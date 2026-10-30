import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { io as connect } from 'socket.io-client';
import { fileURLToPath } from 'node:url';
import { prepStation, tableBill } from '../dining-domain.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('sales take recipe stock out, edits and voids adjust it, and the kitchen marks single items ready', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambiente-recipes-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), POS_PIN: '1234', KITCHEN_PIN: '4321', INVENTORY_PIN: '5555', BARISTA_PIN: '7777',
      ADMIN_PASSWORD: 'owner-password', SESSION_SECRET: 'recipes-test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('5 Way System running')) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const call = async (url, cookie, method = 'GET', body) => {
      const response = await fetch(base + url, {
        method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json() };
    };
    const login = async (role, secret) => {
      const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, secret }) });
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie').split(';')[0];
    };
    const owner = await login('admin', 'owner-password');
    const pos = await login('pos', '1234');
    const kitchen = await login('kitchen', '4321');
    const barista = await login('barista', '7777');

    const { body: menu } = await call('/api/menu', pos);
    const bar = ['Sparkling Wine', 'White Wine', 'Red Wine', 'Dessert Wine', 'Whiskey', 'Beer'];
    const [corn, other] = menu.items.filter((i) => i.available && prepStation(i) === 'kitchen');
    const { body: stock } = await call('/api/inventory/items', owner, 'POST', { name: 'Corn', unit: 'pcs', quantity: 5, threshold: 3 });
    const put = await call(`/api/admin/recipes/${corn.id}`, owner, 'PUT', { ingredients: [{ inventoryItemId: stock.id, qty: 1 }] });
    assert.equal(put.status, 200);
    const cornStock = async () => (await call('/api/admin/inventory', owner)).body.items.find((i) => i.id === stock.id).quantity;

    // Selling 2 takes 2 out and crosses the reorder level, which is logged for the owner.
    const sale = await call('/api/orders', pos, 'POST', { clientId: 'sale-1', items: [{ menuItemId: corn.id, qty: 2 }, { menuItemId: other.id, qty: 1 }] });
    assert.equal(sale.status, 201);
    assert.equal(await cornStock(), 3);
    const sale2 = await call('/api/orders', pos, 'POST', { clientId: 'sale-2', items: [{ menuItemId: corn.id, qty: 1 }] });
    assert.equal(await cornStock(), 2);
    const day = (await call('/api/admin/day', owner)).body;
    assert.ok(day.logs.some((l) => l.action === 'inventory.low' && l.message.includes('Corn')));

    // Notes for the cook travel with each item: saved with the sale, kept by an edit that doesn't send
    // them, changed or removed by one that does, and logged. An over-long note is refused.
    const noted = await call('/api/orders', pos, 'POST', { clientId: 'noted-1', items: [{ menuItemId: other.id, qty: 1, note: '  Medium rare, not spicy ' }] });
    assert.equal(noted.status, 201);
    assert.equal(noted.body.items[0].note, 'Medium rare, not spicy');
    assert.equal((await call('/api/orders', pos, 'POST', { clientId: 'noted-2', items: [{ menuItemId: other.id, qty: 1, note: 'x'.repeat(141) }] })).status, 400);
    const kept = await call(`/api/orders/${noted.body.id}`, pos, 'PATCH', { items: [{ menuItemId: other.id, qty: 2 }] });
    assert.equal(kept.body.order.items[0].note, 'Medium rare, not spicy');
    const renoted = await call(`/api/orders/${noted.body.id}`, pos, 'PATCH', { items: [{ menuItemId: other.id, qty: 2, note: 'Well done' }] });
    assert.equal(renoted.status, 200);
    assert.equal(renoted.body.order.items[0].note, 'Well done');
    assert.ok((await call('/api/admin/day', owner)).body.logs.some((l) => l.message.includes('Note on') && l.message.includes('"Well done"')));
    assert.equal((await call(`/api/orders/${noted.body.id}/void`, pos, 'POST', { reason: 'test' })).status, 200);

    // Steaks sold by weight: priced by the grams typed, sized S/M/L, one line per weight. A sale or edit without a weight is refused.
    const wagyu = menu.items.find((i) => i.name === 'Japanese Kobe A5 Wagyu Steak'), striploin = menu.items.find((i) => i.name === 'USDA Prime Striploin');
    assert.deepEqual([wagyu.per_grams, wagyu.sizes, striploin.per_grams], [1, 'S<60,M<100,L', 100]);
    assert.equal((await call('/api/orders', pos, 'POST', { clientId: 'steak-0', items: [{ menuItemId: wagyu.id, qty: 1 }] })).status, 400);
    assert.equal((await call('/api/orders', pos, 'POST', { clientId: 'steak-00', items: [{ menuItemId: other.id, qty: 1, grams: 80 }] })).status, 400);
    const steaks = await call('/api/orders', pos, 'POST', { clientId: 'steak-1', items: [{ menuItemId: wagyu.id, qty: 1, grams: 59 }, { menuItemId: wagyu.id, qty: 2, grams: 85 }, { menuItemId: wagyu.id, qty: 1, grams: 100 }, { menuItemId: striploin.id, qty: 1, grams: 250 }] });
    assert.equal(steaks.status, 201);
    assert.deepEqual(steaks.body.items.map((i) => [i.name, i.qty, i.unit_price_cents, i.grams]), [
      ['Japanese Kobe A5 Wagyu Steak (S · 59 g)', 1, 118000, 59],
      ['Japanese Kobe A5 Wagyu Steak (M · 85 g)', 2, 170000, 85],
      ['Japanese Kobe A5 Wagyu Steak (L · 100 g)', 1, 200000, 100],
      ['USDA Prime Striploin (250 g)', 1, 224750, 250],
    ]);
    assert.equal(steaks.body.subtotal_cents, 118000 + 2 * 170000 + 200000 + 224750);
    // An edit keeps each weighed line apart: one fewer 85 g steak, the 59 g one gone, a 120 g one added.
    const steakEdit = await call(`/api/orders/${steaks.body.id}`, pos, 'PATCH', { items: [{ menuItemId: wagyu.id, qty: 1, grams: 85 }, { menuItemId: wagyu.id, qty: 1, grams: 100 }, { menuItemId: wagyu.id, qty: 1, grams: 120 }, { menuItemId: striploin.id, qty: 1, grams: 250 }] });
    assert.equal(steakEdit.status, 200);
    assert.deepEqual(steakEdit.body.order.items.map((i) => [i.name, i.qty]), [
      ['Japanese Kobe A5 Wagyu Steak (M · 85 g)', 1], ['Japanese Kobe A5 Wagyu Steak (L · 100 g)', 1], ['USDA Prime Striploin (250 g)', 1], ['Japanese Kobe A5 Wagyu Steak (L · 120 g)', 1],
    ]);
    assert.equal(steakEdit.body.order.subtotal_cents, 170000 + 200000 + 224750 + 240000);
    assert.equal((await call(`/api/orders/${steaks.body.id}`, pos, 'PATCH', { items: [{ menuItemId: wagyu.id, qty: 1 }] })).status, 400);
    assert.equal((await call(`/api/orders/${steaks.body.id}/void`, pos, 'POST', { reason: 'test' })).status, 200);

    // Food goes to the kitchen and drinks, coffee and desserts to the barista: each screen sees and finishes its own
    // items, and the order is ready (and rings the till) only when both are done.
    {
      const coffee = menu.items.find((i) => i.category === 'Hot Coffee'), cake = menu.items.find((i) => i.category === 'Desserts / Cakes / Pastries'), wine = menu.items.find((i) => i.category === 'Red Wine');
      const mixed = (await call('/api/orders', pos, 'POST', { clientId: 'mixed-1', items: [{ menuItemId: other.id, qty: 1 }, { menuItemId: coffee.id, qty: 2 }, { menuItemId: cake.id, qty: 1 }, { menuItemId: wine.id, qty: 1 }] })).body;
      assert.deepEqual(mixed.items.map((i) => [i.name, i.station, i.sends_to_kitchen]), [[other.name, 'kitchen', 1], [coffee.name, 'barista', 1], [cake.name, 'barista', 1], [wine.name, 'barista', 1]]);
      const onScreen = async (who) => (await call('/api/kitchen/tickets', who)).body.some((t) => t.id === mixed.id);
      assert.deepEqual([await onScreen(kitchen), await onScreen(barista)], [true, true]);
      const kitchenDone = await call(`/api/orders/${mixed.id}/kitchen`, kitchen, 'PATCH', { status: 'ready' });
      assert.deepEqual([kitchenDone.body.kitchen_status, kitchenDone.body.items.filter((i) => i.kitchen_ready_at).map((i) => i.name)], ['preparing', [other.name]]);
      assert.deepEqual([await onScreen(kitchen), await onScreen(barista)], [false, true]);
      const drinkReady = (await call('/api/pos/ready', pos)).body.find((p) => p.key === `order:${mixed.id}`);
      assert.deepEqual([drinkReady.complete, drinkReady.items.map((i) => i.from)], [false, ['kitchen']]);
      const baristaDone = await call(`/api/orders/${mixed.id}/kitchen`, barista, 'PATCH', { status: 'ready' });
      assert.equal(baristaDone.body.kitchen_status, 'ready');
      assert.equal(await onScreen(barista), false);
      const allReady = (await call('/api/pos/ready', pos)).body.find((p) => p.key === `order:${mixed.id}`);
      assert.deepEqual([allReady.complete, allReady.items.map((i) => i.from).sort()], [true, ['barista', 'barista', 'barista', 'kitchen']]);
      assert.equal((await call(`/api/orders/${mixed.id}/void`, pos, 'POST', { reason: 'test' })).status, 200);
    }

    // Editing down to 1 puts 1 back; voiding puts the rest back.
    const edit = await call(`/api/orders/${sale.body.id}`, owner, 'PATCH', { items: [{ menuItemId: corn.id, qty: 1 }, { menuItemId: other.id, qty: 1 }] });
    assert.equal(edit.status, 200);
    assert.equal(await cornStock(), 3);
    assert.equal((await call(`/api/orders/${sale2.body.id}/void`, pos, 'POST', { reason: 'test' })).status, 200);
    assert.equal(await cornStock(), 4);

    // The kitchen marks one item ready; the ticket stays open until the last one is.
    const order = edit.body.order;
    {
      assert.ok(order.items.every((i) => i.sends_to_kitchen));
      const [first, second] = order.items;
      // Tapping an item once starts it cooking; the ticket counts as started but nothing is ready yet.
      const cooking = await call(`/api/orders/${order.id}/items/${second.id}/kitchen`, kitchen, 'PATCH', { state: 'cooking' });
      assert.equal(cooking.body.kitchen_status, 'preparing');
      const cookingItem = cooking.body.items.find((i) => i.id === second.id);
      assert.ok(cookingItem.kitchen_started_at && !cookingItem.kitchen_ready_at);
      const one = await call(`/api/orders/${order.id}/items/${first.id}/kitchen`, kitchen, 'PATCH', { ready: true });
      assert.equal(one.status, 200);
      assert.equal(one.body.kitchen_status, 'preparing');
      assert.ok(one.body.items.find((i) => i.id === first.id).kitchen_ready_at);
      assert.ok(!one.body.items.find((i) => i.id === second.id).kitchen_ready_at);
      const tickets = (await call('/api/kitchen/tickets', kitchen)).body;
      assert.ok(tickets.some((t) => t.id === order.id));

      // An edit that doesn't add more of the ready item keeps its mark.
      const kept = await call(`/api/orders/${order.id}`, owner, 'PATCH', { items: [{ menuItemId: first.menu_item_id, qty: 1 }, { menuItemId: second.menu_item_id, qty: 2 }] });
      const keptItem = kept.body.order.items.find((i) => i.menu_item_id === first.menu_item_id);
      assert.ok(keptItem.kitchen_ready_at);
      const last = kept.body.order.items.find((i) => i.menu_item_id === second.menu_item_id);
      // The till already lists the finished item, as part of an order that's still cooking.
      const [part] = (await call('/api/pos/ready', pos)).body;
      assert.deepEqual([part.key, part.complete, part.ready, part.total], [`order:${order.id}`, false, 1, 3]);
      assert.deepEqual(part.items, [{ name: first.name, qty: 1, note: null, from: 'kitchen', keys: [`item:${keptItem.id}:1`] }]);
      // Finishing the last item tells the till, which shows the order as ready to collect.
      const till = connect(base, { extraHeaders: { cookie: pos }, auth: { store: 'ambiente' }, transports: ['websocket'] });
      await new Promise((resolve, reject) => { till.on('connect', resolve); till.on('connect_error', reject); });
      const told = new Promise((resolve) => till.once('pickup.updated', resolve));
      const done = await call(`/api/orders/${order.id}/items/${last.id}/kitchen`, kitchen, 'PATCH', { ready: true });
      assert.equal(done.body.kitchen_status, 'ready');
      await told; till.close();
      assert.ok(!(await call('/api/kitchen/tickets', kitchen)).body.some((t) => t.id === order.id));
      const [pickup] = (await call('/api/pos/ready', pos)).body;
      assert.equal(pickup.key, `order:${order.id}`);
      assert.equal(pickup.label, done.body.receipt_label);
      assert.deepEqual(pickup.items.map(({ name, qty }) => ({ name, qty })), [{ name: first.name, qty: 1 }, { name: last.name, qty: 2 }]);
      assert.equal(pickup.complete, true);
      assert.deepEqual(pickup.items[1].keys, [`item:${last.id}:1`, `item:${last.id}:2`]);
      assert.equal((await call('/api/pos/ready', kitchen)).status, 401);
    }

    // The till can tell whether the kitchen and barista screens are open, to know which paper slips to print.
    assert.deepEqual((await call('/api/pos/kitchen-screens', pos)).body, { screens: 0, barista: 0 });
    assert.equal((await call('/api/pos/kitchen-screens', kitchen)).status, 401);
    const screen = connect(base, { extraHeaders: { cookie: kitchen }, auth: { store: 'ambiente' }, transports: ['websocket'] });
    await new Promise((resolve, reject) => { screen.on('connect', resolve); screen.on('connect_error', reject); });
    assert.deepEqual((await call('/api/pos/kitchen-screens', pos)).body, { screens: 1, barista: 0 });
    // The owner's live panel sees which screens are open.
    assert.deepEqual((await call('/api/admin/screens', owner)).body, { pos: 0, barista: 0, kitchen: 1, inventory: 0, admin: 0 });
    assert.equal((await call('/api/admin/screens', pos)).status, 401);
    screen.close();

    // The owner's general terminal opens every screen. Each hears that screen's updates but isn't counted
    // as a real one (so with only the terminal's kitchen open, the till still prints paper kitchen slips).
    const mirror = connect(base, { extraHeaders: { cookie: owner }, auth: { store: 'ambiente', screen: 'pos' }, transports: ['websocket'] });
    await new Promise((resolve, reject) => { mirror.on('connect', resolve); mirror.on('connect_error', reject); });
    assert.equal((await call('/api/admin/screens', owner)).body.pos, 0);
    const heard = new Promise((resolve) => mirror.once('menu.updated', resolve));
    await call(`/api/menu/${other.id}/availability`, pos, 'POST', { available: false });
    await heard; mirror.close();
    await call(`/api/menu/${other.id}/availability`, pos, 'POST', { available: true });
    // The panel picker is open to anyone (each panel asks for its own PIN); the side-by-side view is the owner's.
    const terminal = (path, cookie) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
    assert.equal((await terminal('/terminal')).headers.get('location'), '/', 'the old general terminal goes to the main page');
    assert.equal((await terminal('/terminal/all', owner)).status, 200);
    assert.equal((await terminal('/terminal/all', pos)).headers.get('location'), '/login?role=admin&next=terminal');

    // Tables: the sketch's layout is there, a party is seated, adds a second order, then bills out.
    const tables = (await call('/api/tables', pos)).body;
    assert.equal(tables.length, 21);
    const t5 = tables.find((t) => t.name === 'Table 5');
    const seatedAt = new Date(Date.now() - 10 * 60000).toISOString();
    const dineIn = await call('/api/orders', pos, 'POST', { clientId: 'table-1', items: [{ menuItemId: other.id, qty: 1 }],
      table: { tableId: t5.id, guests: 3, customerTag: 'vip', seatedAt } });
    assert.equal(dineIn.status, 201);
    assert.equal(dineIn.body.table_name, 'Table 5');
    assert.equal(dineIn.body.seated_at, seatedAt);
    const more = await call('/api/orders', pos, 'POST', { clientId: 'table-2', items: [{ menuItemId: other.id, qty: 1 }],
      table: { tableId: t5.id, guests: 3, seatedAt: new Date().toISOString() } });
    assert.equal(more.body.seated_at, seatedAt, 'a second order keeps the time the party sat down');
    const busy = (await call('/api/tables', pos)).body.find((t) => t.id === t5.id);
    assert.equal(busy.party.receipts.length, 2);
    assert.equal(busy.party.customer_tag, 'vip');
    assert.equal((await call(`/api/admin/tables/${t5.id}`, owner, 'DELETE')).status, 409);
    assert.equal((await call(`/api/tables/${t5.id}/bill-out`, pos, 'POST')).status, 200);
    assert.equal((await call('/api/tables', pos)).body.find((t) => t.id === t5.id).party, null);
    const billed = (await call('/api/admin/day', owner)).body.orders.find((o) => o.id === dineIn.body.id);
    assert.ok(billed.billed_out_at);
    // The table heatmap counts the party once (two receipts, one seating), with its guests and how long it stayed.
    const heat = (await call('/api/admin/table-heat?days=7', owner)).body;
    const used = heat.tables.find((t) => t.id === t5.id);
    assert.deepEqual([used.seatings, used.guests, used.timed], [1, 3, 1]);
    assert.ok(used.minutes >= 9 && used.minutes <= 12, `stayed ${used.minutes} min`);
    assert.ok(heat.tables.every((t) => t.id === t5.id || t.seatings === 0));
    assert.equal((await call('/api/admin/table-heat?days=5', owner)).status, 400);
    assert.equal((await call('/api/admin/table-heat', pos)).status, 401);

    // Pay at bill out: a table's orders go to the kitchen unpaid, and the table pays them together, with a
    // senior's group-share discount on the whole bill. Only then do they count as sales.
    const t6 = tables.find((t) => t.name === 'Table 6'), table6 = { tableId: t6.id, guests: 4 };
    const salesBefore = (await call('/api/admin/day', owner)).body.summary.gross_cents;
    assert.equal((await call('/api/orders', pos, 'POST', { clientId: 'later-0', payLater: true, items: [{ menuItemId: other.id, qty: 1 }] })).status, 400);
    const round1 = await call('/api/orders', pos, 'POST', { clientId: 'later-1', payLater: true, cashTenderedCents: 1, discount: { kind: 'percent', value: 5000, reason: 'ignored', label: '' }, items: [{ menuItemId: other.id, qty: 2 }], table: table6 });
    const round2 = await call('/api/orders', pos, 'POST', { clientId: 'later-2', payLater: true, items: [{ menuItemId: other.id, qty: 1 }], table: table6 });
    assert.deepEqual([round1.status, round1.body.status, round1.body.discount_cents, round1.body.cash_tendered_cents, round2.body.status], [201, 'open', 0, null, 'open']);
    assert.ok((await call('/api/kitchen/tickets', kitchen)).body.some((o) => o.id === round1.body.id), 'the kitchen cooks an unpaid table order');
    assert.equal((await call('/api/admin/day', owner)).body.summary.gross_cents, salesBefore, 'unpaid orders are not sales yet');
    const owing = (await call('/api/tables', pos)).body.find((t) => t.id === t6.id).party;
    assert.equal(owing.unpaid_cents, round1.body.total_cents + round2.body.total_cents);
    assert.equal((await call(`/api/tables/${t6.id}/bill-out`, pos, 'POST')).status, 409, 'an unpaid table cannot just be freed');
    const billOrders = (await call(`/api/tables/${t6.id}/bill`, pos)).body.orders;
    assert.deepEqual(billOrders.map((o) => o.id), [round1.body.id, round2.body.id]);
    const senior = { kind: 'group', label: 'Senior', diners: 4, pwd: 0, senior: 1, pwd_rate: 2000, senior_rate: 2000, vat_exempt: true, ids: [{ type: 'Senior', id: 'OSCA-77' }], reason: 'Group share: 1 senior of 4' };
    const expected = tableBill(billOrders, senior, menu.taxRate);
    assert.equal((await call(`/api/tables/${t6.id}/pay`, pos, 'POST', { billId: 'bill-1', discount: senior, cashTenderedCents: expected.total_cents, totalCents: expected.total_cents + 1 })).status, 409, 'a bill that changed is checked again');
    assert.equal((await call(`/api/tables/${t6.id}/pay`, pos, 'POST', { billId: 'bill-1', discount: senior, cashTenderedCents: expected.total_cents - 1 })).status, 400);
    const paid = await call(`/api/tables/${t6.id}/pay`, pos, 'POST', { billId: 'bill-1', discount: senior, cashTenderedCents: 1_000_000, totalCents: expected.total_cents });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.deepEqual([paid.body.total_cents, paid.body.discount_cents, paid.body.change_cents, paid.body.items.length, paid.body.labels.length], [expected.total_cents, expected.discount_cents, 1_000_000 - expected.total_cents, 2, 2]);
    assert.ok(expected.discount_cents > 0);
    assert.deepEqual((await call(`/api/tables/${t6.id}/pay`, pos, 'POST', { billId: 'bill-1', discount: senior, cashTenderedCents: 1_000_000 })).body.total_cents, expected.total_cents, 'a retried payment is not taken twice');
    assert.equal((await call('/api/tables', pos)).body.find((t) => t.id === t6.id).party, null, 'paying frees the table');
    assert.equal((await call('/api/admin/day', owner)).body.summary.gross_cents, salesBefore + expected.total_cents);
    assert.equal((await call(`/api/bills/bill-1`, pos)).body.total_cents, expected.total_cents);
    assert.equal((await call(`/api/admin/tables/${t5.id}`, owner, 'PATCH', { name: 'Window', x: 500, y: 500 })).body.name, 'Window');

    // The owner changes their own password from the dashboard; the old one stops working.
    assert.equal((await call('/api/admin/password', owner, 'POST', { current: 'wrong', password: 'new-owner-pass' })).status, 403);
    assert.equal((await call('/api/admin/password', owner, 'POST', { current: 'owner-password', password: 'short' })).status, 400);
    assert.equal((await call('/api/admin/password', owner, 'POST', { current: 'owner-password', password: 'new-owner-pass' })).status, 200);
    const tryLogin = (secret) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin', secret }) }).then((r) => r.status);
    assert.equal(await tryLogin('owner-password'), 401);
    assert.equal(await tryLogin('new-owner-pass'), 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
