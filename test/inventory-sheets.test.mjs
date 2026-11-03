import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { totals } from '../dining-domain.js';
import { launch } from './support/server.mjs';
const id = () => crypto.randomUUID();

test('the kitchen sheets load as stock: sales take portions, prepping takes ingredients, table bills count too', async () => {
  const server = await launch();
  try {
    const { request, login } = server, owner = await login('admin'), pos = await login('pos'), inventory = await login('inventory');
    const stock = async () => Object.fromEntries((await request('/api/admin/inventory', owner)).data.items.map(i => [i.name, i]));
    const menuData = (await request('/api/menu', pos)).data, menu = Object.fromEntries((menuData.items ?? menuData).map(m => [m.name, m]));

    // Every row of the six Café Ambiente sheets, grouped like the paper, starting at 100.
    let s = await stock();
    assert.ok(Object.keys(s).length >= 198);
    assert.deepEqual([s['Chicken Kebab'].kind, s['Chicken Kebab'].section, s['Chicken Kebab'].quantity, s['Chicken Kebab'].unit], ['portion', 'Chicken', 100, 'pcs']);
    assert.deepEqual([s.Ahos.kind, s.Ahos.section, s.Ahos.unit], ['ingredient', 'Spices & market', 'g']);
    assert.equal(s['Take Out Box'].kind, 'supply');
    // Each item says where it goes; unclear ones are left for the owner to link.
    assert.deepEqual(s['Chicken Kebab'].used_in, ['Spicy Chicken Kebab']);
    assert.deepEqual(s['Putanesca / Mushroom'].used_in, ['Beef and Mushroom', 'Beef Puttanesca']);
    assert.ok(s.Ahos.used_in.includes('1 Cup Garlic Rice') && s.Ahos.used_in.includes('Roasted Shrimp (prep)'));
    assert.deepEqual(s['Seafood Sotanghon'].prep_uses, ['Sotanghon']);
    for (const unlinked of ['AS Ribeye', 'Demkota', 'Japanese Wagyu', 'Marinara / Seafood Pasta', 'Shrimp Pasta', 'Shrimp Pasta 2']) assert.deepEqual(s[unlinked].used_in, [], unlinked);
    // The owner's later answers: Angus patties in the burgers (two in the Double), a drumstick in the pancit,
    // and two portions that weren't on the sheets.
    assert.deepEqual(s['Angus Patty'].used_in, ['Classic American Angus Cheese Burger', 'Double Cheese Burger', 'Truffle Cheese Burger']);
    assert.deepEqual(s['Drum Stick'].used_in, ['Spicy Fried Chicken Kare-Kare Pancit']);
    assert.deepEqual([s['Beef Belly Steak'].kind, s['Beef Belly Steak'].section, s['Beef Belly Steak'].quantity, s['Beef Belly Steak'].used_in], ['portion', 'Beef', 100, ['Beef Belly Steak']]);
    assert.deepEqual([s['Fried Shrimp'].section, s['Fried Shrimp'].used_in], ['Seafood', ['Fried Shrimp Pasta']]);

    // A Double Cheese Burger takes two patties.
    const burger = await request('/api/orders', pos, { clientId: id(), items: [{ menuItemId: menu['Double Cheese Burger'].id, qty: 1 }], cashTenderedCents: 1_000_000 });
    assert.equal(burger.status, 201);
    assert.equal((await stock())['Angus Patty'].quantity, 98);

    // A sale takes one portion per dish. A link without an amount (spaghetti) takes nothing yet.
    const kebab = menu['Spicy Chicken Kebab'], marinara = menu['Spicy Spaghetti Marinara'];
    const sale = await request('/api/orders', pos, { clientId: id(), items: [{ menuItemId: kebab.id, qty: 2 }, { menuItemId: marinara.id, qty: 1 }], cashTenderedCents: 1_000_000 });
    assert.equal(sale.status, 201);
    s = await stock();
    assert.equal(s['Chicken Kebab'].quantity, 98);
    assert.equal(s['Spaghetti Pasta'].quantity, 100);
    assert.equal((await request(`/api/orders/${sale.data.id}/void`, pos, { reason: 'Test' })).status, 200);
    assert.equal((await stock())['Chicken Kebab'].quantity, 100);

    // Prepping 10 kebabs takes out 10 × what one uses; an ingredient without an amount is skipped.
    assert.equal((await request(`/api/admin/prep/${s['Chicken Kebab'].id}`, owner, { ingredients: [{ inventoryItemId: s.Ahos.id, qty: 5 }, { inventoryItemId: s['Red Onion'].id, qty: 0 }] }, 'PUT')).status, 200);
    assert.equal((await request(`/api/admin/prep/${s.Ahos.id}`, owner, { ingredients: [] }, 'PUT')).status, 404, 'only portions have a prep recipe');
    assert.equal((await request(`/api/admin/prep/${s['Chicken Kebab'].id}`, owner, { ingredients: [{ inventoryItemId: s['Chicken Kebab'].id, qty: 1 }] }, 'PUT')).status, 400);
    const prepped = await request(`/api/inventory/${s['Chicken Kebab'].id}/stock`, inventory, { kind: 'prepped', amount: 10 });
    assert.equal(prepped.status, 200, JSON.stringify(prepped.data));
    s = await stock();
    assert.deepEqual([s['Chicken Kebab'].quantity, s.Ahos.quantity, s['Red Onion'].quantity], [110, 50, 100]);
    assert.ok(s.Ahos.used_in.includes('Chicken Kebab (prep)'));
    const log = (await request('/api/admin/inventory', owner)).data.log;
    assert.ok(log.some(l => l.name === 'Ahos' && l.kind === 'prep' && l.change === -50 && l.note === 'Prepped 10 Chicken Kebab'));
    assert.equal((await request(`/api/inventory/${s.Ahos.id}/stock`, inventory, { kind: 'prepped', amount: 1 })).status, 400, 'only portions are prepped');

    // The owner can link a dish without an amount yet; nothing comes out until one is entered.
    assert.equal((await request(`/api/admin/recipes/${menu['Spicy Chicken Wings'].id}`, owner, { ingredients: [{ inventoryItemId: s.Wings.id, qty: 1 }, { inventoryItemId: s['Red Hot'].id, qty: 0 }] }, 'PUT')).status, 200);

    // A table on Unpaid tabs takes its portions out when the bill is settled, and gets them back on undo.
    const snapshot = async () => (await request('/api/dining/state', owner)).data;
    let clock = Date.now() - 3600000;
    const act = async (type, target, payload, who = pos) => {
      const state = await snapshot(), record = type.startsWith('table.') ? state.tables[target] : state.visits[target];
      const op = { id: id(), deviceId: 'pos-A', at: new Date(clock += 1000).toISOString(), type, targetId: target, expectedVersion: record?.version ?? 0, payload };
      const result = await request('/api/dining/sync', who, { operations: [op] });
      assert.equal(result.data.results[0].status, 'applied', JSON.stringify(result.data));
      return op;
    };
    const table = id(), visit = id();
    await act('table.save', table, { name: 'Stock Test', active: true }, owner);
    await act('table.seat', table, { visitId: visit, guests: 2 });
    await act('visit.submit', visit, { submissionId: id(), lines: [{ id: id(), menu_item_id: kebab.id, name: kebab.name, unit_price_cents: kebab.price_cents, sends_to_kitchen: 1, qty: 3, note: '' }] });
    assert.equal((await stock())['Chicken Kebab'].quantity, 110, 'nothing comes out before the bill is settled');
    await act('visit.event', visit, { event: 'bill_requested_at' });
    const bill = totals((await snapshot()).visits[visit], 0.12);
    const settle = await act('visit.settle', visit, { cash_cents: bill.total_cents, total_cents: bill.total_cents });
    assert.equal((await stock())['Chicken Kebab'].quantity, 107);
    assert.equal((await request(`/api/dining/undo/${settle.id}`, owner, {})).status, 200);
    assert.equal((await stock())['Chicken Kebab'].quantity, 110);
  } finally { await server.close(); }
});

test('a server that loaded the sheets before gets the later links once, and keeps what the owner changed', async () => {
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ambiente-sheets-')), 'data.db');
  // A café server as it was after the first load: no Beef Belly Steak or Fried Shrimp, no burger or pancit
  // links, and the owner had since unlinked the kebab.
  let server = await launch();
  try {
    const db = new DatabaseSync(path.join(server.dir, 'data.db'));
    const item = (name) => db.prepare('SELECT id FROM inventory_items WHERE name = ?').get(name).id;
    const dish = (name) => db.prepare('SELECT id FROM menu_items WHERE name = ?').get(name).id;
    db.prepare("UPDATE settings SET value = '2026-11-01' WHERE key = 'inventory_sheets_version'").run();
    for (const name of ['Beef Belly Steak', 'Fried Shrimp']) { const id = item(name); db.prepare('DELETE FROM menu_recipes WHERE inventory_item_id = ?').run(id); db.prepare('DELETE FROM inventory_log WHERE item_id = ?').run(id); db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id); }
    for (const [stock, menuItem] of [['Angus Patty', 'Truffle Cheese Burger'], ['Angus Patty', 'Double Cheese Burger'], ['Drum Stick', 'Spicy Fried Chicken Kare-Kare Pancit'], ['Chicken Kebab', 'Spicy Chicken Kebab']]) db.prepare('DELETE FROM menu_recipes WHERE inventory_item_id = ? AND menu_item_id = ?').run(item(stock), dish(menuItem));
    db.exec(`VACUUM INTO '${copy}'`);
    db.close();
  } finally { await server.close(); }

  server = await launch({ prepareData: (dir) => fs.copyFileSync(copy, path.join(dir, 'data.db')) });
  try {
    const owner = await server.login('admin');
    const items = (await server.request('/api/admin/inventory', owner)).data.items, s = Object.fromEntries(items.map(i => [i.name, i]));
    assert.equal(items.length, new Set(items.map(i => i.name)).size, 'no item added twice');
    assert.deepEqual(s['Beef Belly Steak'].used_in, ['Beef Belly Steak']);
    assert.deepEqual(s['Fried Shrimp'].used_in, ['Fried Shrimp Pasta']);
    assert.deepEqual(s['Drum Stick'].used_in, ['Spicy Fried Chicken Kare-Kare Pancit']);
    const recipes = (await server.request('/api/admin/recipes', owner)).data;
    const menuData = (await server.request('/api/menu', await server.login('pos'))).data, menu = Object.fromEntries((menuData.items ?? menuData).map(m => [m.name, m]));
    assert.equal(recipes.find(r => r.menu_item_id === menu['Double Cheese Burger'].id && r.name === 'Angus Patty').qty, 2);
    assert.deepEqual(s['Chicken Kebab'].used_in, [], 'a link the owner removed stays removed');
  } finally { await server.close(); fs.rmSync(path.dirname(copy), { recursive: true, force: true }); }
});

