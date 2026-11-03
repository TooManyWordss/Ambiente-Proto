import assert from 'node:assert/strict';
import test from 'node:test';
import { io as connect } from 'socket.io-client';
import { launch } from './support/server.mjs';

test('the inspector counts stock and sets reorder levels; the owner adds and edits items and is alerted when stock runs low', async () => {
  const server = await launch();
  let socket;
  try {
    const { request, login } = server, owner = await login('admin'), inspector = await login('inventory'), pos = await login('pos');
    socket = connect(server.base, { extraHeaders: { cookie: owner }, auth: { store: 'ambiente' }, transports: ['websocket'] });
    await new Promise((ok, fail) => { socket.on('connect', ok); socket.on('connect_error', fail); });

    // Only the owner adds items.
    assert.equal((await request('/api/inventory/items', inspector, { name: 'Oat milk', unit: 'L', quantity: 10, threshold: 2 })).status, 403);
    const added = await request('/api/inventory/items', owner, { name: 'Oat milk', unit: 'L', quantity: 10, threshold: 2, kind: 'ingredient', section: 'Groceries' });
    assert.equal(added.status, 201);
    const id = added.data.id;

    // The inspector raises the reorder level above what's left: the owner hears it's low.
    const alerted = new Promise((ok) => socket.once('inventory.low', ok));
    assert.equal((await request(`/api/inventory/${id}`, pos, { threshold: 12 }, 'PATCH')).status, 401, 'not the till');
    assert.equal((await request(`/api/inventory/${id}`, inspector, { threshold: -1 }, 'PATCH')).status, 400);
    const raised = await request(`/api/inventory/${id}`, inspector, { threshold: 12 }, 'PATCH');
    assert.equal(raised.status, 200);
    assert.deepEqual([raised.data.threshold, raised.data.low], [12, true]);
    const alert = await alerted;
    assert.deepEqual([alert.name, alert.quantity], ['Oat milk', 10]);
    let item = (await request('/api/admin/inventory', owner)).data;
    assert.ok(item.log.some((l) => l.name === 'Oat milk' && l.note === 'Reorder level 2 L → 12 L'));

    // The inspector records a delivery; above the level again, it's off the buying list.
    assert.equal((await request(`/api/inventory/${id}/stock`, inspector, { kind: 'received', amount: 5 })).status, 200);
    assert.equal((await request('/api/inventory', inspector)).data.find((i) => i.id === id).low, false);

    // The owner edits everything about the item.
    const edited = await request(`/api/admin/inventory/${id}`, owner, { name: 'Oat milk (Oatside)', unit: 'L', kind: 'ingredient', section: 'Groceries', threshold: 4 }, 'PATCH');
    assert.equal(edited.status, 200);
    item = (await request('/api/admin/inventory', owner)).data.items.find((i) => i.id === id);
    assert.deepEqual([item.name, item.threshold, item.quantity], ['Oat milk (Oatside)', 4, 15]);
    assert.equal((await request(`/api/admin/inventory/${id}`, inspector, { name: 'x' }, 'PATCH')).status, 401, 'renaming is the owner’s');
  } finally { socket?.close(); await server.close(); }
});
