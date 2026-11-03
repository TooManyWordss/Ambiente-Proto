import assert from 'node:assert/strict';
import test from 'node:test';
import { launch } from './support/server.mjs';

test('the owner adds dishes with a description and edits descriptions; receipts have no closing lines', async () => {
  const server = await launch();
  try {
    const { request, login } = server, owner = await login('admin'), pos = await login('pos');
    const menu = async () => (await request('/api/menu', pos)).data;
    const byName = async (name) => (await menu()).items.find((m) => m.name === name);
    // No "Thank you! Please come again." unless the café sets its own closing lines.
    assert.deepEqual((await menu()).receipt.footer, []);

    // Added from the admin page: straight onto the menu, with its description.
    const added = await request('/api/menu/requests', owner, { name: 'Ube Cheesecake', category: 'Desserts / Cakes / Pastries', priceCents: 22000, sendsToKitchen: true, description: 'Purple yam cheesecake on a graham crust.' });
    assert.equal(added.status, 201);
    assert.equal(added.data.status, 'approved');
    assert.equal((await byName('Ube Cheesecake')).description, 'Purple yam cheesecake on a graham crust.');
    assert.equal((await request('/api/menu/requests', owner, { name: 'Too Long', category: 'Pasta', priceCents: 100, description: 'x'.repeat(601) })).status, 400);

    // A dish from the standard menu shows its standard description until the owner writes their own.
    const kebab = await byName('Spicy Chicken Kebab'), standard = kebab.description;
    assert.ok(standard);
    const state = async () => (await request('/api/dining/state', owner)).data;
    let item = (await state()).menu.find((m) => m.id === kebab.id);
    assert.equal(item.description, standard, 'the menu editor starts from the description shown');
    const edit = (body) => request(`/api/dining/menu/${kebab.id}`, owner, { expectedVersion: item.version, name: item.name, category: item.category, price_cents: item.price_cents, available: true, sends_to_kitchen: true, ...body }, 'PATCH');
    assert.equal((await edit({ description: 'Grilled chicken skewers with a chili glaze.' })).status, 200);
    assert.equal((await byName('Spicy Chicken Kebab')).description, 'Grilled chicken skewers with a chili glaze.');
    assert.equal((await byName('Spicy Chicken Kebab')).descriptionSources, undefined, 'the standard text’s sources go with it');
    // Saving without touching the description keeps it.
    item = (await state()).menu.find((m) => m.id === kebab.id);
    assert.equal((await edit({ price_cents: item.price_cents + 1000 })).status, 200);
    assert.equal((await byName('Spicy Chicken Kebab')).description, 'Grilled chicken skewers with a chili glaze.');
  } finally { await server.close(); }
});

test('the owner sizes the balcony on the floor map, and every screen gets it', async () => {
  const server = await launch();
  try {
    const { request, login } = server, owner = await login('admin'), pos = await login('pos'), kitchen = await login('kitchen');
    assert.deepEqual((await request('/api/floor', pos)).data, { balcony: { x: 100, y: 84, w: 166, h: 508 } });
    const bigger = { x: 60, y: 84, w: 260, h: 600 };
    assert.equal((await request('/api/admin/floor', pos, { balcony: bigger }, 'PUT')).status, 401);
    assert.equal((await request('/api/admin/floor', owner, { balcony: { ...bigger, w: 1300 } }, 'PUT')).status, 400, 'it has to fit in the room');
    assert.equal((await request('/api/admin/floor', owner, { balcony: { ...bigger, h: 20 } }, 'PUT')).status, 400);
    assert.deepEqual((await request('/api/admin/floor', owner, { balcony: bigger }, 'PUT')).data, { balcony: bigger });
    assert.deepEqual((await request('/api/floor', kitchen)).data, { balcony: bigger });
    assert.equal((await request('/api/floor')).status, 401);
  } finally { await server.close(); }
});
