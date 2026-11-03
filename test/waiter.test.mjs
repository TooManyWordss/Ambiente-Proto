import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { io as connect } from 'socket.io-client';
import { launch } from './support/server.mjs';

test('the waiter sends table orders and asks for the bill; only the cashier takes payment', async () => {
  const server = await launch();
  const sockets = [];
  const socket = async (cookie) => { const s = connect(server.base, { extraHeaders: { cookie }, auth: { store: 'ambiente' }, transports: ['websocket'] }); sockets.push(s); await new Promise((ok, fail) => { s.on('connect', ok); s.on('connect_error', fail); }); return s; };
  try {
    const { request, login } = server, waiter = await login('barista'), pos = await login('pos');
    const menu = (await request('/api/menu', waiter)).data.items;
    const food = menu.find((m) => m.name === 'Spicy Chicken Kebab'), drink = menu.find((m) => /latte/i.test(m.name));
    const table = (await request('/api/tables', waiter)).data[0];
    const items = [{ menuItemId: food.id, qty: 2 }, { menuItemId: drink.id, qty: 1, note: 'oat milk' }];

    // No till open yet: the waiter's panel hears that the drink slip couldn't print.
    const panel = await socket(waiter), unprinted = new Promise((ok) => panel.once('slips.unprinted', ok));
    assert.equal((await request('/api/orders', waiter, { clientId: crypto.randomUUID(), items, cashTenderedCents: 1_000_000 })).status, 403, 'no counter sales');
    const first = await request('/api/orders', waiter, { clientId: crypto.randomUUID(), payLater: true, table: { tableId: table.id, guests: 3 }, items });
    assert.equal(first.status, 201);
    assert.deepEqual([first.data.station, first.data.status, first.data.table_name], ['cashier', 'open', table.name], 'the cashier’s order, on the table’s bill');
    assert.deepEqual((await unprinted).preps, ['barista', 'kitchen']);

    // With the till open (and no kitchen screen), the till prints the drink slip and the kitchen slip.
    const till = await socket(pos), handed = [];
    till.on('slips.takeover', (data, answer) => { handed.push(data); answer({ ok: true }); });
    await request('/api/orders', waiter, { clientId: crypto.randomUUID(), payLater: true, table: { tableId: table.id, guests: 3 }, items });
    for (let i = 0; i < 50 && !handed.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(handed[0].slips.map((s) => [s.prep, s.table_name, s.items.map((i) => `${i.qty} ${i.name}${i.note ? ` (${i.note})` : ''}`)]),
      [['barista', table.name, [`1 ${drink.name} (oat milk)`]], ['kitchen', table.name, [`2 ${food.name}`]]]);

    // The waiter can't change, void, pay or bill out.
    assert.equal((await request(`/api/orders/${first.data.id}/void`, waiter, { reason: 'x' })).status, 403);
    assert.equal((await request(`/api/tables/${table.id}/pay`, waiter, { billId: 'w', paymentMethod: 'card' })).status, 401);
    assert.equal((await request(`/api/tables/${table.id}/bill-out`, waiter, {})).status, 401);

    // Asking for the bill: the cashier's till hears it and the table shows it until they pay.
    const asked = new Promise((ok) => till.once('bill.requested', ok));
    assert.equal((await request(`/api/tables/${table.id}/request-bill`, waiter, { paymentMethod: 'card' })).status, 200);
    assert.deepEqual([(await asked).table_name, (await asked).pay_by], [table.name, 'card']);
    let party = (await request('/api/tables', pos)).data.find((t) => t.id === table.id).party;
    assert.ok(party.bill_requested_at);
    assert.deepEqual([party.bill_requested_by, party.bill_pay_by], ['Waiter', 'card']);
    assert.equal((await request(`/api/tables/${table.id}/request-bill`, waiter, {}, 'DELETE')).status, 401, 'only the cashier dismisses');
    const due = (await request(`/api/tables/${table.id}/bill`, pos)).data.orders.reduce((n, o) => n + o.total_cents, 0);
    assert.equal((await request(`/api/tables/${table.id}/pay`, pos, { billId: crypto.randomUUID(), paymentMethod: 'cash', cashTenderedCents: due, totalCents: due })).status, 200);
    assert.equal((await request('/api/tables', pos)).data.find((t) => t.id === table.id).party, null, 'paid: the table is free and the request gone');
    assert.equal((await request(`/api/tables/${table.id}/request-bill`, waiter, {})).status, 409, 'nothing to bill');

    // The waiter's panel isn't a barista screen: the till prints drink slips for its own sales too.
    assert.deepEqual((await request('/api/pos/kitchen-screens', pos)).data, { screens: 0, barista: 0 });
  } finally { for (const s of sockets) s.close(); await server.close(); }
});
