import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
    assert.ok(Object.keys(s).length >= 196);
    assert.deepEqual([s['Chicken Kebab'].kind, s['Chicken Kebab'].section, s['Chicken Kebab'].quantity, s['Chicken Kebab'].unit], ['portion', 'Chicken', 100, 'pcs']);
    assert.deepEqual([s.Ahos.kind, s.Ahos.section, s.Ahos.unit], ['ingredient', 'Spices & market', 'g']);
    assert.equal(s['Take Out Box'].kind, 'supply');
    // Each item says where it goes; unclear ones are left for the owner to link.
    assert.deepEqual(s['Chicken Kebab'].used_in, ['Spicy Chicken Kebab']);
    assert.deepEqual(s['Putanesca / Mushroom'].used_in, ['Beef and Mushroom', 'Beef Puttanesca']);
    assert.ok(s.Ahos.used_in.includes('1 Cup Garlic Rice') && s.Ahos.used_in.includes('Roasted Shrimp (prep)'));
    assert.deepEqual(s['Seafood Sotanghon'].prep_uses, ['Sotanghon']);
    for (const unlinked of ['Drum Stick', 'AS Ribeye', 'Demkota', 'Japanese Wagyu', 'Marinara / Seafood Pasta', 'Shrimp Pasta', 'Shrimp Pasta 2']) assert.deepEqual(s[unlinked].used_in, [], unlinked);

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
