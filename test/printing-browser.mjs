import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { chromium } from '@playwright/test';
import { launch } from './support/server.mjs';

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));

// A pretend Bluetooth printer that records what it prints.
const fakeBle = () => {
  window.__printed = [];
  // This tablet connected the printer once before.
  localStorage.setItem('5way.blePrinter', 'Fake 58H');
  // and has been printing since an hour ago.
  if (!localStorage.getItem('5way.ambiente.kitchenPrint')) localStorage.setItem('5way.ambiente.kitchenPrint', JSON.stringify({ on: true, method: 'ble', paper: '58', cut: false, since: new Date(Date.now() - 3600000).toISOString() }));
  const PRINT = '0000ae01-0000-1000-8000-00805f9b34fb';
  const channel = { uuid: PRINT, properties: { write: true, writeWithoutResponse: true }, writeValueWithResponse: async (c) => { window.__printed.push(...new Uint8Array(c.buffer ?? c)); }, writeValueWithoutResponse: async (c) => { window.__printed.push(...new Uint8Array(c.buffer ?? c)); } };
  const server = { async getPrimaryService(uuid) { if (uuid !== '0000ae30-0000-1000-8000-00805f9b34fb') throw new Error('no'); return { getCharacteristics: async () => [channel], getCharacteristic: async () => channel }; } };
  const device = { id: 'fake', name: 'Fake 58H', addEventListener() {}, gatt: { connected: false, async connect() { this.connected = true; return server; }, disconnect() { this.connected = false; } } };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device, getDevices: async () => [device] }, configurable: true });
};
const printedText = (page) => page.evaluate(() => String.fromCharCode(...window.__printed));

test('stations print before Start, and the till prints slips for stations that do not answer', { timeout: 200000 }, async () => {
  const server = await launch(), browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const kitchenCtx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    await kitchenCtx.addInitScript(fakeBle);
    await kitchenCtx.request.post(`${server.base}/api/login`, { data: { role: 'kitchen', secret: '4321' } });
    const kitchen = await kitchenCtx.newPage(), errors = [];
    kitchen.on('pageerror', (e) => errors.push(e.message));
    await kitchen.goto(`${server.base}/kitchen`);
    await kitchen.waitForTimeout(2500);

    const till = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    await till.request.post(`${server.base}/api/login`, { data: { role: 'pos', secret: '1234' } });
    const menu = await (await till.request.get(`${server.base}/api/menu`)).json(), items = menu.items ?? menu;
    const food = items.find((m) => m.name === 'Spicy Chicken Kebab'), drink = items.find((m) => /latte/i.test(m.name) && m.available);
    // Nobody tapped Start on the kitchen tablet, and the order still prints there.
    const sale = await till.request.post(`${server.base}/api/orders`, { data: { clientId: 'k1', items: [{ menuItemId: food.id, qty: 1 }, { menuItemId: drink.id, qty: 1 }], cashTenderedCents: 1_000_000 } });
    assert.equal(sale.status(), 201);
    await kitchen.waitForFunction(() => String.fromCharCode(...window.__printed).includes('Spicy Chicken Kebab'), null, { timeout: 15000 });
    const k = await printedText(kitchen);
    assert.ok(k.includes(' KITCHEN ORDER ') && !k.includes(drink.name) && !k.includes('LATE'), k);
    // The kitchen tablet answers; there's no barista tablet.
    assert.deepEqual(await (await till.request.get(`${server.base}/api/pos/kitchen-screens`)).json(), { screens: 1, barista: 0 });

    // From Unpaid tabs, a table's drink and food: only the barista slip prints at the till.
    const owner = await browser.newContext();
    await owner.request.post(`${server.base}/api/login`, { data: { role: 'admin', secret: 'test-password' } });
    await owner.request.post(`${server.base}/api/dining/sync`, { data: { operations: [{ id: 'seed', deviceId: 't', type: 'table.save', targetId: 'tbl', expectedVersion: 0, at: new Date().toISOString(), payload: { name: 'Garden 1', active: true } }] } });
    const pos = await till.newPage();
    pos.on('pageerror', (e) => errors.push(e.message));
    await pos.addInitScript(() => { window.__prints = []; window.print = () => window.__prints.push(document.querySelector('.print-receipt')?.innerText ?? ''); });
    await pos.goto(`${server.base}/pos`);
    await pos.getByRole('button', { name: 'Unpaid tabs', exact: true }).click();
    await pos.getByRole('button', { name: /Garden 1.*Available/ }).click();
    await pos.getByLabel('Guests', { exact: true }).fill('2');
    await pos.getByRole('button', { name: 'Seat guests', exact: true }).click();
    await pos.getByRole('heading', { name: /Garden 1/ }).waitFor();
    for (const m of [drink, food]) { await pos.getByLabel('Search table menu').fill(m.name); await pos.locator('.dining-menu button').filter({ hasText: m.name }).first().click(); }
    await pos.getByRole('button', { name: 'Send order to kitchen', exact: true }).click();
    await pos.waitForFunction(() => window.__prints.length > 0, null, { timeout: 15000 });
    const slip = (await pos.evaluate(() => window.__prints))[0];
    assert.ok(/barista/i.test(slip) && slip.includes(drink.name) && !slip.includes(food.name), slip);
    // The kitchen tablet prints the table's food itself.
    await kitchen.waitForFunction(() => String.fromCharCode(...window.__printed).includes('Garden 1'), null, { timeout: 20000 });

    // The kitchen tablet loses its wifi: the server still has its connection, but the till now prints the kitchen slip.
    await kitchenCtx.setOffline(true);
    await kitchen.evaluate(() => { window.__printed.length = 0; });
    assert.deepEqual(await (await till.request.get(`${server.base}/api/pos/kitchen-screens`)).json(), { screens: 0, barista: 0 });
    // Wifi back: the orders that arrived meanwhile print there, marked late.
    await till.request.post(`${server.base}/api/orders`, { data: { clientId: 'k2', createdAt: new Date(Date.now() - 5 * 60000).toISOString(), items: [{ menuItemId: food.id, qty: 2 }], cashTenderedCents: 1_000_000 } });
    await kitchenCtx.setOffline(false);
    await kitchen.waitForFunction(() => String.fromCharCode(...window.__printed).includes('2 x Spicy Chicken Kebab'), null, { timeout: 60000 });
    assert.ok((await printedText(kitchen)).includes('LATE - check for a till slip'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
