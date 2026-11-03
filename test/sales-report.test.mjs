import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import zlib from 'node:zlib';
import { workbook } from '../client/src/shared/xlsx.ts';
import { launch } from './support/server.mjs';

const manila = (iso) => new Date(Date.parse(iso) + 8 * 3600000);
const today = () => manila(new Date().toISOString()).toISOString().slice(0, 10);

test('the sales report lists every order with its day, hour, time, items, total and guests, and sums them', async () => {
  const server = await launch();
  try {
    const { request, login } = server, owner = await login('admin'), pos = await login('pos');
    const menuData = (await request('/api/menu', pos)).data, menu = Object.fromEntries(menuData.items.map((m) => [m.name, m]));
    const kebab = menu['Spicy Chicken Kebab'], latte = menuData.items.find((m) => /latte/i.test(m.name));
    const sale = (body) => request('/api/orders', pos, { clientId: crypto.randomUUID(), cashTenderedCents: 1_000_000, ...body });
    const counter = await sale({ items: [{ menuItemId: kebab.id, qty: 2, note: 'extra spicy' }, { menuItemId: latte.id, qty: 1 }] });
    const voided = await sale({ items: [{ menuItemId: latte.id, qty: 1 }] });
    assert.equal((await request(`/api/orders/${voided.data.id}/void`, pos, { reason: 'Wrong order' })).status, 200);
    const tables = (await request('/api/tables', pos)).data;
    const tab = await sale({ payLater: true, cashTenderedCents: undefined, items: [{ menuItemId: kebab.id, qty: 1 }], table: { tableId: tables[0].id, guests: 3 } });
    assert.equal(tab.status, 201);

    assert.equal((await request(`/api/admin/sales-report?from=${today()}&to=${today()}`, pos)).status, 401);
    assert.equal((await request(`/api/admin/sales-report?from=${today()}&to=2020-01-01`, owner)).status, 400);
    const r = (await request(`/api/admin/sales-report?from=${today()}&to=${today()}`, owner)).data;
    assert.equal(r.orders.length, 3);
    const first = r.orders.find((o) => o.order === counter.data.receipt_label), at = manila(counter.data.created_at);
    assert.equal(first.date, today());
    assert.equal(first.day, ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][at.getUTCDay()]);
    assert.equal(first.time, `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`);
    assert.equal(first.hour, `${String(at.getUTCHours()).padStart(2, '0')}:00`);
    assert.deepEqual(first.items.map((i) => [i.name, i.qty, i.note]), [[kebab.name, 2, 'extra spicy'], [latte.name, 1, '']]);
    assert.equal(first.items[0].category, kebab.category);
    assert.deepEqual([first.status, first.table, first.item_count, first.total_cents], ['paid', 'Counter', 3, counter.data.total_cents]);
    assert.deepEqual(r.orders.map((o) => o.status).sort(), ['open', 'paid', 'voided']);
    assert.equal(r.orders.find((o) => o.status === 'open').guests, 3);
    assert.equal(r.orders.find((o) => o.status === 'voided').void_reason, 'Wrong order');
    // Only paid orders are sales; the void and the unpaid tab are counted apart.
    assert.deepEqual([r.summary.orders, r.summary.gross_cents, r.summary.items, r.summary.voided, r.summary.unpaid], [1, counter.data.total_cents, 3, 1, 1]);
    assert.equal(r.summary.average_order_cents, counter.data.total_cents);
    assert.deepEqual(r.byDay.map((d) => [d.date, d.orders]), [[today(), 1]]);
    assert.deepEqual(r.byHour.map((h) => h.hour), [first.hour]);
    assert.deepEqual(r.bestSellers.map((b) => [b.name, b.qty]), [[kebab.name, 2], [latte.name, 1]]);
  } finally { await server.close(); }
});

test('the Excel file is a valid workbook: every part present, checksums right, values and peso amounts in their cells', () => {
  const bytes = workbook([{ name: 'Orders', rows: [['Order #', 'Total', 'Note'], ['1001', { peso: 425.5 }, 'Tom & Jerry <3'], ['1002', 3, null]] }, { name: 'By day / hour?', rows: [['Date'], ['2026-11-03']] }]);
  // Walk the ZIP's local entries: name, stored data, and the checksum Excel checks.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = {};
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true), name = Buffer.from(bytes.slice(at + 30, at + 30 + nameLength)).toString();
    const data = bytes.slice(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(view.getUint32(at + 14, true), zlib.crc32(data), `${name} checksum`);
    files[name] = Buffer.from(data).toString(); at += 30 + nameLength + size;
  }
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Order #<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="B2" s="2"><v>425.5<\/v><\/c>/, 'pesos are numbers with the peso format');
  assert.match(sheet, /Tom &amp; Jerry &lt;3/);
  assert.match(sheet, /<c r="B3"><v>3<\/v><\/c>/);
  assert.match(files['xl/workbook.xml'], /<sheet name="By day   hour " sheetId="2"/, 'characters Excel forbids in sheet names are replaced');
  assert.match(files['xl/styles.xml'], /formatCode="&quot;₱&quot;#,##0.00"/);
});

test('the owner resets the statistics to zero with the owner password; a copy is kept and the rest stays', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const server = await launch();
  try {
    const { request, login } = server, owner = await login('admin'), pos = await login('pos');
    const menu = (await request('/api/menu', pos)).data.items, kebab = menu.find((m) => m.name === 'Spicy Chicken Kebab');
    const sale = () => request('/api/orders', pos, { clientId: crypto.randomUUID(), cashTenderedCents: 1_000_000, items: [{ menuItemId: kebab.id, qty: 1 }] });
    const first = (await sale()).data;
    await sale();
    // A party on Unpaid tabs.
    const tableId = crypto.randomUUID(), visitId = crypto.randomUUID();
    let clock = Date.now() - 60_000;
    const act = async (type, target, payload, who = pos) => {
      const state = (await request('/api/dining/state', owner)).data, record = type.startsWith('table.') ? state.tables[target] : state.visits[target];
      const op = { id: crypto.randomUUID(), deviceId: 't', at: new Date(clock += 1000).toISOString(), type, targetId: target, expectedVersion: record?.version ?? 0, payload };
      assert.equal((await request('/api/dining/sync', who, { operations: [op] })).data.results[0].status, 'applied');
    };
    await act('table.save', tableId, { name: 'Garden 9', active: true }, owner);
    await act('table.seat', tableId, { visitId, guests: 2 });
    const stockBefore = (await request('/api/admin/inventory', owner)).data.items.length;
    const revision = (await request('/api/dining/state', owner)).data.revision;

    assert.equal((await request('/api/admin/reset-statistics', pos, { password: 'test-password' })).status, 401, 'only the owner');
    assert.equal((await request('/api/admin/reset-statistics', owner, { password: 'wrong' })).status, 401);
    assert.equal((await request('/api/admin/reset-statistics', owner, {})).status, 401);
    const reset = await request('/api/admin/reset-statistics', owner, { password: 'test-password' });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.cleared, 2);
    assert.ok(fs.existsSync(path.join(server.dir, 'cafe-backups', reset.data.backup)), 'a copy was saved first');

    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const report = (await request(`/api/admin/sales-report?from=${day}&to=${day}`, owner)).data;
    assert.deepEqual([report.orders.length, report.summary.gross_cents], [0, 0]);
    const state = (await request('/api/dining/state', owner)).data;
    assert.deepEqual(Object.keys(state.visits), []);
    assert.equal(state.tables[tableId].visit_id, null, 'the table is still there, free');
    assert.ok(state.revision > revision, 'tablets replace their saved copy');
    assert.equal((await request('/api/admin/inventory', owner)).data.items.length, stockBefore, 'stock stays');
    assert.ok((await request('/api/menu', pos)).data.items.length > 0, 'the menu stays');
    const logs = (await request('/api/admin/day', owner)).data.logs;
    assert.ok(logs.some((l) => JSON.stringify(l).includes('Reset sales statistics to zero')), 'the reset itself is logged');
    // Order numbers start again.
    assert.equal((await sale()).data.receipt_no, first.receipt_no);
  } finally { await server.close(); }
});

test('cashiers record card or cash: counter sales, table bill-outs and Unpaid tabs, and the report splits them', async () => {
  const server = await launch();
  try {
    const { request, login } = server, owner = await login('admin'), pos = await login('pos');
    const menu = (await request('/api/menu', pos)).data.items, kebab = menu.find((m) => m.name === 'Spicy Chicken Kebab');
    const items = [{ menuItemId: kebab.id, qty: 1 }];
    // Counter: card needs no cash; cash still needs enough.
    const card = await request('/api/orders', pos, { clientId: crypto.randomUUID(), paymentMethod: 'card', items });
    assert.equal(card.status, 201);
    assert.deepEqual([card.data.payment_method, card.data.cash_tendered_cents, card.data.change_cents], ['card', null, null]);
    const cash = await request('/api/orders', pos, { clientId: crypto.randomUUID(), paymentMethod: 'cash', cashTenderedCents: 100_000, items });
    assert.deepEqual([cash.data.payment_method, cash.data.change_cents], ['cash', 100_000 - cash.data.total_cents]);
    assert.equal((await request('/api/orders', pos, { clientId: crypto.randomUUID(), paymentMethod: 'cash', cashTenderedCents: 1, items })).status, 400);
    assert.equal((await request('/api/orders', pos, { clientId: crypto.randomUUID(), paymentMethod: 'bitcoin', cashTenderedCents: 100_000, items })).data.payment_method, 'cash', 'anything else counts as cash');

    // A table billed out by card.
    const table = (await request('/api/tables', pos)).data[0];
    await request('/api/orders', pos, { clientId: crypto.randomUUID(), payLater: true, items, table: { tableId: table.id, guests: 2 } });
    const bill = (await request(`/api/tables/${table.id}/bill`, pos)).data.orders, total = bill.reduce((n, o) => n + o.total_cents, 0);
    const paid = await request(`/api/tables/${table.id}/pay`, pos, { billId: crypto.randomUUID(), paymentMethod: 'card', totalCents: total });
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    assert.deepEqual([paid.data.payment_method, paid.data.cash_tendered_cents, paid.data.change_cents], ['card', null, null]);

    // Unpaid tabs settled by card.
    const tableId = crypto.randomUUID(), visitId = crypto.randomUUID();
    let clock = Date.now() - 60_000;
    const act = async (type, target, payload, who = pos) => {
      const state = (await request('/api/dining/state', owner)).data, record = type.startsWith('table.') ? state.tables[target] : state.visits[target];
      const op = { id: crypto.randomUUID(), deviceId: 't', at: new Date(clock += 1000).toISOString(), type, targetId: target, expectedVersion: record?.version ?? 0, payload };
      const result = (await request('/api/dining/sync', who, { operations: [op] })).data.results[0];
      assert.equal(result.status, 'applied', JSON.stringify(result));
    };
    await act('table.save', tableId, { name: 'Garden 7', active: true }, owner);
    await act('table.seat', tableId, { visitId, guests: 2 });
    await act('visit.submit', visitId, { submissionId: crypto.randomUUID(), lines: [{ id: crypto.randomUUID(), menu_item_id: kebab.id, name: kebab.name, unit_price_cents: kebab.price_cents, sends_to_kitchen: 1, qty: 1, note: '' }] });
    await act('visit.event', visitId, { event: 'bill_requested_at' });
    const { totals } = await import('../dining-domain.js');
    const due = totals((await request('/api/dining/state', owner)).data.visits[visitId], 0.12).total_cents;
    await act('visit.settle', visitId, { payment_method: 'card', total_cents: due });
    const visit = (await request('/api/dining/state', owner)).data.visits[visitId];
    assert.deepEqual([visit.payment_method, visit.cash_cents, visit.change_cents], ['card', null, null]);

    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const r = (await request(`/api/admin/sales-report?from=${day}&to=${day}`, owner)).data;
    assert.deepEqual(r.orders.map((o) => o.paid_by).sort(), ['Card', 'Card', 'Card', 'Cash', 'Cash']);
    assert.equal(r.summary.card_cents + r.summary.cash_cents, r.summary.gross_cents);
    assert.equal(r.summary.card_cents, card.data.total_cents + total + due);
  } finally { await server.close(); }
});
