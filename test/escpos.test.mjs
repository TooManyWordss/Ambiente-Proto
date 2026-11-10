import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeKitchenSlip, encodeReceipt, joinPrints, tearOff } from '../client/src/printing/escpos.ts';
import { darkBox, toBitmap } from '../client/src/printing/logo.ts';

const settings = { name: 'Café Ambiente', header: ['Iligan City'], footer: ['Thank you!'] };
const text = (bytes) => Buffer.from(bytes).toString('latin1');

test('a 58 mm ESC/POS receipt fits 32 columns, prints plain ASCII and ends with feed and cut', () => {
  const bytes = encodeReceipt({
    label: '1001', created_at: '2026-10-19T04:00:00Z', table_name: 'Table 5', guests: 2,
    items: [{ name: 'Spanish Latte (16oz) with extra espresso shot', qty: 2, unit_price_cents: 18500 }, { name: 'Sweet Corn', qty: 1, unit_price_cents: 9000 }],
    subtotal_cents: 46000, tax_cents: 0, total_cents: 46000, cash_tendered_cents: 50000, change_cents: 4000,
  }, settings, { columns: 32, cut: true, drawer: false });
  const out = text(bytes);
  assert.deepEqual([...bytes.slice(0, 2)], [0x1b, 0x40], 'starts by resetting the printer');
  assert.ok(out.includes('Cafe Ambiente'), 'accents are dropped for the printer');
  assert.ok(out.includes('Order #1001') && !out.includes('Receipt'));
  assert.ok(out.includes('Table 5 - 2 guests'));
  assert.ok(out.includes('P370.00') && out.includes('P460.00') && out.includes('P40.00'));
  assert.ok(out.includes('THIS DOCUMENT IS NOT VALID') && out.indexOf('FOR CLAIM OF INPUT TAX') > out.indexOf('TOTAL'), 'the BIR notice sits at the very bottom');
  assert.ok([...bytes].every((b) => b < 0x80 || b === 0xfa), 'only ASCII text');
  // Every printed line fits the paper once the printer commands are taken out.
  const lines = out.replace(/\x1b@|\x1b[aEJ][\s\S]|\x1bp[\s\S]{3}|\x1d[!B][\s\S]|\x1dV[\s\S]{2}/g, '').split('\n');
  for (const line of lines) assert.ok(line.length <= 32, `too long: "${line}"`);
  assert.deepEqual([...bytes.slice(-4)], [0x1d, 0x56, 0x42, 0x00], 'ends with a cut');
  assert.ok(lines.length > 10);
});

test('the barista receipt prints the order number large and a cash sale can open the drawer', () => {
  const bytes = encodeReceipt({ label: 'B-0007', station: 'barista', items: [], total_cents: 0 },
    { ...settings, title: 'Coffee Bar' }, { columns: 32, cut: false, drawer: true });
  const out = text(bytes);
  assert.ok(out.includes('\x1d\x21\x11Order B-0007'), 'double width and height');
  assert.ok(out.includes('Coffee Bar'));
  assert.deepEqual([...bytes.slice(-5)], [0x1b, 0x70, 0x00, 0x19, 0xfa]);
});

test('the kitchen slip lists what to cook without prices and prints after the receipt as one job', () => {
  const order = { label: '1002', created_at: '2026-10-19T04:00:00Z', table_name: 'Couch', guests: 6,
    items: [{ name: 'Sweet Corn', qty: 2, unit_price_cents: 9000 }, { name: 'Carbonara with extra parmesan and bacon bits', qty: 1, unit_price_cents: 26000 }],
    total_cents: 44000, cash_tendered_cents: 50000, change_cents: 6000 };
  const slip = encodeKitchenSlip(order, { columns: 32, cut: false, drawer: false });
  const out = text(slip);
  assert.ok(out.includes('KITCHEN') && out.includes('Couch') && out.includes('6 guests') && out.includes('Order #1002') && !out.includes('Receipt'));
  assert.ok(out.includes('2 x Sweet Corn') && out.includes('1 x Carbonara'));
  assert.ok(!/P\d/.test(out), 'no prices on the kitchen slip');
  const lines = out.replace(/\x1b@|\x1b[aEJ][\s\S]|\x1d[!B][\s\S]/g, '').split('\n');
  for (const line of lines) assert.ok(line.length <= 32, `too long: "${line}"`);
  const receipt = encodeReceipt(order, settings, { columns: 32, cut: true, drawer: false });
  const both = joinPrints(receipt, slip);
  assert.equal(both.length, receipt.length + slip.length);
  assert.ok(text(both).indexOf('Cash') < text(both).indexOf('KITCHEN'), 'receipt first, then the kitchen slip');
  // A card payment says so instead of cash and change.
  const byQr = text(encodeReceipt({ ...order, payment_method: 'qr', payment_reference: 'GCASH-5551234', cash_tendered_cents: null, change_cents: null }, settings, { columns: 32, cut: false, drawer: false }));
  assert.ok(byQr.includes('QR / APP') && byQr.includes('Ref: GCASH-5551234') && !byQr.includes('Change'), byQr);
  const byCard = text(encodeReceipt({ ...order, payment_method: 'card', cash_tendered_cents: null, change_cents: null }, settings, { columns: 32, cut: false, drawer: false }));
  assert.ok(byCard.includes('Paid by') && byCard.includes('CARD') && !byCard.includes('Change'));
  // The barista's slip has its own band, so the two stations' slips can't be mixed up.
  const drinks = text(encodeKitchenSlip({ ...order, prep: 'barista', items: [{ name: 'Iced Latte', qty: 2 }] }, { columns: 32, cut: false, drawer: false }));
  assert.ok(drinks.includes(' BARISTA ORDER ') && !drinks.includes('KITCHEN') && drinks.includes('2 x Iced Latte'));
  // A ticket that reached the station late says so: the till may already have printed it on paper.
  assert.ok(text(encodeKitchenSlip({ ...order, late: true }, { columns: 32, cut: false, drawer: false })).includes('LATE - check for a till slip'));
  assert.ok(!text(slip).includes('LATE'));
});

test('Bluetooth printing finds the printer’s print channel and piece size, reconnects, and never prints twice', async () => {
  const { connectPrinter, sendToPrinter, saveBleSettings } = await import('../client/src/printing/escpos.ts');
  if (!globalThis.localStorage?.setItem) { const store = new Map(); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) } }); }
  // A pretend BLE printer with two writable channels: ff02 looks like a print channel but refuses data
  // ("GATT operation failed"), ae01 is the one that prints. Each connection hands out new objects.
  const PRINT = '0000ae01-0000-1000-8000-00805f9b34fb', DUD = '0000ff02-0000-1000-8000-00805f9b34fb';
  const written = [], plan = { failNext: false, failAfter: Infinity, largest: 100, modes: [] };
  let connections = 0;
  const device = { name: 'Fake 58H', listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
    gatt: { connected: false, async connect() { connections++; this.connected = true; return server; }, disconnect() { this.connected = false; } } };
  const fail = () => { throw new Error('GATT operation failed for unknown reason.'); };
  const write = (uuid, mode) => async (chunk) => {
    plan.modes.push(mode);
    if (uuid === DUD) fail();
    if (plan.failNext) { plan.failNext = false; fail(); }
    if (chunk.length > plan.largest || written.length >= plan.failAfter) fail();
    written.push([...chunk]);
  };
  const channel = (uuid) => ({ uuid, properties: { write: true, writeWithoutResponse: true }, writeValueWithoutResponse: write(uuid, 'without'), writeValueWithResponse: write(uuid, 'with') });
  const services = { '0000ff00-0000-1000-8000-00805f9b34fb': DUD, '0000ae30-0000-1000-8000-00805f9b34fb': PRINT };
  const server = { async getPrimaryService(uuid) { if (!services[uuid]) throw new Error('no'); return { getCharacteristics: async () => [channel(services[uuid])], getCharacteristic: async () => channel(services[uuid]) }; } };
  Object.defineProperty(globalThis.navigator, 'bluetooth', { value: { requestDevice: async () => device, getDevices: async () => [device] }, configurable: true });

  assert.equal(await connectPrinter('ble'), 'Fake 58H');
  const receipt = encodeReceipt({ label: '1003', items: [{ name: 'Sweet Corn', qty: 2, unit_price_cents: 9000 }, { name: 'Iced Spanish Latte', qty: 1, unit_price_cents: 18500 }], total_cents: 36500 }, settings, { columns: 32, cut: false, drawer: false });
  // The usual print channel (ff02) refuses, so it moves on to the next channel, which prints.
  await sendToPrinter('ble', receipt);
  assert.deepEqual(written.flat(), [...receipt], 'printed exactly once, in order');
  assert.equal(written[0].length, 100);
  const first = (await import('../client/src/printing/escpos.ts')).lastBleReport;
  assert.equal(first.channel, 'ae30/ae01'); assert.ok(first.tries > 1 && first.ok);
  // The channel that worked is remembered: the next receipt goes straight to it.
  written.length = 0; plan.modes.length = 0;
  await sendToPrinter('ble', receipt);
  assert.equal((await import('../client/src/printing/escpos.ts')).lastBleReport.tries, 1);
  assert.ok(plan.modes.every(m => m === 'with'), 'automatic waits for the printer to confirm each piece when it can');

  // The printer slept: the next print reconnects and uses the new connection.
  written.length = 0; device.gatt.connected = false; device.listeners.gattserverdisconnected?.();
  const before = connections;
  await sendToPrinter('ble', receipt);
  assert.deepEqual(written.flat(), [...receipt]);
  assert.ok(connections > before);

  // A printer that refuses 100-byte pieces: it goes again in 20-byte pieces and remembers that.
  written.length = 0; plan.largest = 20;
  await sendToPrinter('ble', receipt);
  assert.ok(written.every(c => c.length <= 20));
  assert.deepEqual(written.flat(), [...receipt]);
  written.length = 0; await sendToPrinter('ble', receipt);
  assert.equal(written[0].length, 20, 'the size that worked is remembered');

  // Failing halfway stops with a clear message rather than printing the first half again.
  written.length = 0; plan.failAfter = 3;
  await assert.rejects(sendToPrinter('ble', receipt), /Switch the printer off and on/);
  assert.equal(written.length, 3);

  // Chosen by hand in Printer settings: piece size, write type and channel.
  plan.failAfter = Infinity; plan.largest = 512; written.length = 0; plan.modes.length = 0;
  saveBleSettings({ size: 180, write: 'response', channel: PRINT });
  await sendToPrinter('ble', receipt);
  assert.equal(written[0].length, 180);
  assert.ok(plan.modes.every(m => m === 'with'));
  // Choosing the channel that refuses data says so instead of hopping to another.
  saveBleSettings({ size: 'auto', write: 'auto', channel: DUD });
  await assert.rejects(sendToPrinter('ble', receipt), /the chosen Bluetooth channel/);
  saveBleSettings({ size: 'auto', write: 'auto', channel: 'auto' });

  // After the page reloads (a fresh copy of the code knows no printer), the printer chosen before is
  // found again without a tap, by its remembered name, and goes straight to the channel that worked.
  written.length = 0; device.gatt.connected = false;
  const reloaded = await import('../client/src/printing/escpos.ts?reloaded');
  await reloaded.sendToPrinter('ble', receipt);
  assert.deepEqual(written.flat(), [...receipt]);
  assert.equal(reloaded.lastBleReport.tries, 1);
  // A printer that was never chosen on this tablet still needs Connect.
  localStorage.removeItem('5way.blePrinter');
  const fresh = await import('../client/src/printing/escpos.ts?fresh');
  await assert.rejects(fresh.sendToPrinter('ble', receipt), /isn’t connected/);
  delete globalThis.navigator.bluetooth;
});

test('the receipt has the logo, spaced-out items with unit prices, the discount, and a tear line before the kitchen slip', () => {
  // A 16 x 4 "logo": dark lettering (dark red) on orange, with a white margin around it.
  const w = 20, h = 6, rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, lettering = x >= 2 && x < 18 && y >= 1 && y < 5 && (x + y) % 2 === 0;
    rgba.set(lettering ? [90, 14, 10, 255] : [240, 112, 33, 255], i);
  }
  const box = darkBox(rgba, w, h);
  assert.equal(box.x, 2); assert.equal(box.y, 1); assert.equal(box.height, 4);
  const logo = toBitmap(rgba, w, h, 384);
  assert.equal(logo.width, 384); assert.equal(logo.data.length, 48 * h);
  // The orange prints as paper, the lettering as dots, centred: the first dark dot sits 182 + 2 dots in.
  const firstRow = [...logo.data.slice(48, 96)].flatMap((b, i) => [...Array(8)].map((_, bit) => (b >> (7 - bit)) & 1 ? i * 8 + bit : -1)).filter(d => d >= 0);
  assert.equal(firstRow[0], 182 + 3);
  assert.ok(logo.data.slice(0, 48).every(b => b === 0), 'the orange margin row prints nothing');

  const order = { label: '1004', created_at: '2026-10-25T04:00:00Z', table_name: 'Couch', guests: 6,
    items: [{ name: 'Sweet Corn', qty: 2, unit_price_cents: 9000 }, { name: 'Iced Spanish Latte', qty: 1, unit_price_cents: 18500 }],
    subtotal_cents: 36500, discount_cents: 7300, discount_label: 'Senior', total_cents: 29200, cash_tendered_cents: 30000, change_cents: 800 };
  const bytes = encodeReceipt(order, { ...settings, logo }, { columns: 32, cut: false, drawer: false }), out = text(bytes);
  const at = out.indexOf('\x1dv0\x00');
  assert.ok(at > 0, 'the logo is sent as a picture');
  assert.deepEqual([...bytes.slice(at + 4, at + 8)], [48, 0, h, 0], '48 bytes (384 dots) wide, 6 rows tall');
  assert.ok(!out.includes('Cafe Ambiente\n'), 'the logo replaces the printed name');
  assert.ok(out.includes('\x1bJ\x12'), 'items have extra paper (18 dots) between them');
  assert.ok(out.includes('P90.00 each'), 'a line with more than one gets its unit price');
  assert.ok(out.includes('Discount (Senior)') && out.includes('-P73.00'));
  assert.ok(out.includes('* Thank you! *'));
  const slip = text(encodeKitchenSlip(order, { columns: 32, cut: false, drawer: false }));
  assert.ok(slip.includes('\x1dB\x01') && slip.includes(' KITCHEN ORDER '), 'the kitchen slip has a black band');
  assert.ok(text(tearOff({ columns: 32, cut: false, drawer: false })).includes('tear here'));
  // Without a logo the café's name prints large instead.
  assert.ok(text(encodeReceipt(order, settings, { columns: 32, cut: false, drawer: false })).includes('Cafe Ambiente'));
});
