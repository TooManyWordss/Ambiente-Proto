import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { totals } from '../dining-domain.js';
import { launch } from './support/server.mjs';

test('staff codes: every bill out, waiter order and stock change says who did it', async () => {
  const server = await launch();
  try {
    const { request, login } = server, owner = await login('admin'), pos = await login('pos'), waiter = await login('barista'), inspector = await login('inventory');
    const menu = (await request('/api/menu', pos)).data.items, kebab = menu.find((m) => m.name === 'Spicy Chicken Kebab');
    const tables = (await request('/api/tables', pos)).data, items = [{ menuItemId: kebab.id, qty: 1 }];
    const order = (who, table, body = {}) => request('/api/orders', who, { clientId: crypto.randomUUID(), payLater: true, table: { tableId: table.id, guests: 2 }, items, ...body });

    // Before anyone has a code, nothing asks for one.
    assert.equal((await request('/api/staff-codes', pos)).data.required, false);
    assert.equal((await order(waiter, tables[0])).status, 201);

    // The owner gives each person a code; codes are unique.
    const add = (name, role, code) => request('/api/admin/staff', owner, { name, role, code });
    assert.equal((await add('Ana', 'pos', '4821')).status, 201);
    assert.equal((await add('Ben', 'barista', '5932')).status, 201);
    assert.equal((await add('Dan', 'barista', '4821')).status, 400, 'someone already has that code');
    assert.equal((await add('Eve', 'pos', '12')).status, 400, '4 to 6 digits');
    const cara = (await add('Cara', 'inventory')).data;
    assert.equal((await request(`/api/admin/staff/${cara.id}/staff-code`, owner, { code: '6043' })).status, 200);
    assert.equal((await request(`/api/admin/staff/${cara.id}/staff-code`, pos, { code: '6043' })).status, 401);
    const security = (await request('/api/admin/security', owner)).data;
    assert.deepEqual(security.staff.filter((s) => s.has_code).map((s) => s.name).sort(), ['Ana', 'Ben', 'Cara']);
    assert.ok(!JSON.stringify(security).includes('4821'), 'codes are never sent back');
    assert.equal((await request('/api/staff-codes', pos)).data.required, true);

    // Waiter: every order needs the waiter's own code.
    const noCode = await order(waiter, tables[1]);
    assert.deepEqual([noCode.status, noCode.data.needsCode], [403, true]);
    assert.equal((await order(waiter, tables[1], { staffCode: '4821' })).status, 403, 'a cashier’s code isn’t a waiter’s');
    const sent = await order(waiter, tables[1], { staffCode: '5932' });
    assert.equal(sent.status, 201);
    assert.equal(sent.data.staff_name, 'Ben');
    assert.equal((await request(`/api/tables/${tables[1].id}/request-bill`, waiter, { paymentMethod: 'cash' })).status, 403);
    assert.equal((await request(`/api/tables/${tables[1].id}/request-bill`, waiter, { paymentMethod: 'cash', staffCode: '5932' })).status, 200);
    assert.equal((await request('/api/tables', pos)).data.find((t) => t.id === tables[1].id).party.bill_requested_by, 'Ben');

    // Cashier: every bill out needs the cashier's code, and the bill says who.
    const due = (await request(`/api/tables/${tables[1].id}/bill`, pos)).data.orders.reduce((n, o) => n + o.total_cents, 0);
    const pay = (body) => request(`/api/tables/${tables[1].id}/pay`, pos, { billId: crypto.randomUUID(), paymentMethod: 'card', paymentReference: 'AUTH-2001', totalCents: due, ...body });
    assert.equal((await pay({})).status, 403);
    const wrong = await pay({ staffCode: '0000' });
    assert.deepEqual([wrong.status, wrong.data.error], [403, 'That staff code isn’t right']);
    const paid = await pay({ staffCode: '4821' });
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    assert.equal(paid.data.billed_by_name, 'Ana');
    // The owner's own login doesn't need a code.
    await order(owner, tables[2]);
    const ownerDue = (await request(`/api/tables/${tables[2].id}/bill`, owner)).data.orders.reduce((n, o) => n + o.total_cents, 0);
    assert.equal((await request(`/api/tables/${tables[2].id}/pay`, owner, { billId: crypto.randomUUID(), paymentMethod: 'card', paymentReference: 'AUTH-2001', totalCents: ownerDue })).status, 200);

    // Inspector: every stock change needs the inspector's code.
    const stock = (await request('/api/admin/inventory', owner)).data.items.find((i) => i.name === 'Chicken Kebab');
    assert.equal((await request(`/api/inventory/${stock.id}/stock`, inspector, { kind: 'count', amount: 40 })).status, 403);
    assert.equal((await request(`/api/inventory/${stock.id}/stock`, inspector, { kind: 'count', amount: 40, staffCode: '6043' })).status, 200);
    assert.equal((await request(`/api/inventory/${stock.id}`, inspector, { threshold: 10 }, 'PATCH')).status, 403);
    assert.equal((await request(`/api/inventory/${stock.id}`, inspector, { threshold: 10, staffCode: '6043' }, 'PATCH')).status, 200);
    const log = (await request('/api/admin/inventory', owner)).data.log;
    assert.ok(log.some((l) => l.name === 'Chicken Kebab' && l.actor_name === 'Cara'));

    // The owner sees who last used each screen.
    const last = (await request('/api/admin/security', owner)).data.lastUsers;
    assert.deepEqual([last.pos?.name, last.pos?.action, last.barista?.name, last.inventory?.name], ['Ana', 'bill out', 'Ben', 'Cara']);
    // A screen can check a code before saving something offline.
    assert.equal((await request('/api/staff-codes/check', pos, { staffCode: '4821' })).data.name, 'Ana');
    assert.equal((await request('/api/staff-codes/check', pos, { staffCode: '5932' })).status, 403);

    // Unpaid tabs: settling on the cashier's login needs the code too; the code never gets stored.
    let clock = Date.now() - 60_000;
    const act = async (type, target, payload, who = pos) => {
      const state = (await request('/api/dining/state', owner)).data, record = type.startsWith('table.') ? state.tables[target] : state.visits[target];
      const op = { id: crypto.randomUUID(), deviceId: 't', at: new Date(clock += 1000).toISOString(), type, targetId: target, expectedVersion: record?.version ?? 0, payload };
      return (await request('/api/dining/sync', who, { operations: [op] })).data.results[0];
    };
    const tableId = crypto.randomUUID(), visitId = crypto.randomUUID();
    await act('table.save', tableId, { name: 'Garden 8', active: true }, owner);
    await act('table.seat', tableId, { visitId, guests: 2 });
    await act('visit.submit', visitId, { submissionId: crypto.randomUUID(), lines: [{ id: crypto.randomUUID(), menu_item_id: kebab.id, name: kebab.name, unit_price_cents: kebab.price_cents, sends_to_kitchen: 1, qty: 1, note: '' }] });
    await act('visit.event', visitId, { event: 'bill_requested_at' });
    const total = totals((await request('/api/dining/state', owner)).data.visits[visitId], 0.12).total_cents;
    const wrongSettle = await act('visit.settle', visitId, { payment_method: 'card', payment_reference: 'AUTH-2002', total_cents: total, staff_code: '9999' });
    assert.equal(wrongSettle.status, 'conflict');
    assert.match(wrongSettle.error, /Wrong staff code/);
    const settled = await act('visit.settle', visitId, { payment_method: 'card', payment_reference: 'AUTH-2002', total_cents: total, staff_code: '4821' });
    assert.equal(settled.status, 'applied', JSON.stringify(settled));
    assert.equal((await request('/api/dining/state', owner)).data.visits[visitId].settled_by, 'Ana');
    const history = (await request('/api/dining/history', owner)).data;
    assert.ok(!JSON.stringify(history).includes('4821'), 'the code isn’t kept in the history');

    // Cashier: ringing up a counter sale needs the cashier's code too.
    const counter = (body = {}) => request('/api/orders', pos, { clientId: crypto.randomUUID(), paymentMethod: 'cash', cashTenderedCents: 100000, items, ...body });
    const unsigned = await counter();
    assert.deepEqual([unsigned.status, unsigned.data.needsCode], [403, true]);
    const rung = await counter({ staffCode: '4821' });
    assert.equal(rung.status, 201);
    assert.equal(rung.data.staff_name, 'Ana');

    // The owner's activity history names who did each order and stock change; only the owner sees it.
    const feed = (await request('/api/admin/activity?days=7', owner)).data.entries;
    const anas = feed.find((e) => e.action === 'order' && e.who === 'Ana');
    assert.ok(anas && anas.what.includes('Order #'), JSON.stringify(feed.slice(0, 5)));
    assert.ok(feed.some((e) => e.who === 'Cara' && e.action.startsWith('stock.')), 'stock changes are in the feed');
    assert.ok(!JSON.stringify(feed).includes('4821'), 'codes never appear in the feed');
    assert.equal((await request('/api/admin/activity', pos)).status, 401, 'owner only');

    // Kitchen staff carry a code too, but it opens nothing.
    assert.equal((await add('Kiko', 'kitchen', '7777')).status, 201);
    assert.equal((await order(waiter, tables[3], { staffCode: '7777' })).status, 403, 'a kitchen code can’t send orders');
    assert.equal((await counter({ staffCode: '7777' })).status, 403, 'a kitchen code can’t ring up a sale');

    // The owner renames people and moves them between positions; the code follows the person.
    const kiko = (await request('/api/admin/security', owner)).data.staff.find((s) => s.name === 'Kiko');
    assert.equal((await request(`/api/admin/staff/${kiko.id}`, owner, { name: 'Ana' }, 'PATCH')).status, 400, 'names stay unique');
    assert.equal((await request(`/api/admin/staff/${kiko.id}`, owner, { name: 'Koko', role: 'pos' }, 'PATCH')).status, 200);
    const promoted = await counter({ staffCode: '7777' });
    assert.equal(promoted.status, 201, 'the same code now rings up as a cashier');
    assert.equal(promoted.data.staff_name, 'Koko');
    assert.equal((await request(`/api/admin/staff/${kiko.id}`, pos, { name: 'X' }, 'PATCH')).status, 401, 'owner only');
  } finally { await server.close(); }
});
