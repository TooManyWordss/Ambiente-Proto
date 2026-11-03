// ESC/POS receipt printing for thermal printers such as the common 58 mm "58H" models.
// The receipt is built as printer commands (text, bold, double size, cut) and sent one of three ways:
//   rawbt – the RawBT Android app, which passes it on over USB or Bluetooth (works with almost any printer)
//   usb   – straight from Chrome over USB (WebUSB; needs HTTPS or localhost)
//   ble   – straight from Chrome over Bluetooth Low Energy (only printers that offer BLE)

export type PrintMethod = 'system' | 'rawbt' | 'usb' | 'ble';
export type ReceiptLine = { name?: string; qty: number; unit_price_cents?: number; note?: string | null };
export type ReceiptData = {
  label: string; station?: string; created_at?: string; items?: ReceiptLine[];
  subtotal_cents?: number; discount_cents?: number; discount_label?: string | null; discount_lines?: { label: string; cents: number }[]; discount_ids?: string[]; tax_cents?: number; total_cents?: number;
  cash_tendered_cents?: number | null; change_cents?: number | null;
  table_name?: string | null; guests?: number | null; staff_name?: string | null;
  offline?: boolean; reprint?: boolean; test?: boolean; heading?: string;
  // A kitchen slip for an order that changed after it was sent: "ORDER CHANGED", "CANCELLED".
  banner?: string;
  // Whose slip it is: the kitchen's (food) or the barista's (drinks and desserts).
  prep?: 'kitchen' | 'barista';
  // A station ticket that reached its tablet late, while the till couldn't see the station: the till printed it then.
  late?: boolean;
};
// A black-and-white picture for the printer: width in dots (a multiple of 8), one bit per dot, rows top to bottom.
export type Bitmap = { width: number; height: number; data: Uint8Array };
export type ReceiptSettings = { name: string; title?: string; header?: string[]; footer?: string[]; logo?: Bitmap | null };
export type PrintOptions = { columns: number; cut: boolean; drawer: boolean };

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

// Cheap printers only reliably print plain ASCII: "Café" → "Cafe", "₱" → "P".
function ascii(text: string) {
  return text.replace(/₱/g, 'P').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/×/g, 'x').replace(/…/g, '...')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
}
const peso = (cents = 0) => `P${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const clock = (date?: string) => date ? new Date(date).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

class Receipt {
  private bytes: number[] = [];
  private columns: number;
  constructor(columns: number) { this.columns = columns; this.raw(ESC, 0x40); } // reset the printer
  raw(...b: number[]) { this.bytes.push(...b); return this; }
  align(where: 'left' | 'center' | 'right') { return this.raw(ESC, 0x61, where === 'left' ? 0 : where === 'center' ? 1 : 2); }
  bold(on: boolean) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  size(wide: boolean, tall: boolean) { return this.raw(GS, 0x21, (wide ? 0x10 : 0) | (tall ? 0x01 : 0)); }
  text(value: string) { for (const ch of ascii(value)) this.bytes.push(ch.charCodeAt(0)); return this; }
  line(value = '') { return this.text(value).raw(LF); }
  rule(char = '-') { return this.line(char.repeat(this.columns)); }
  // Extra paper between lines, in dots (about 8 dots to a millimetre).
  gap(dots: number) { return this.raw(ESC, 0x4a, dots); }
  // White text on a black band.
  reverse(on: boolean) { return this.raw(GS, 0x42, on ? 1 : 0); }
  // A picture, sent as raster rows (GS v 0).
  raster(image: Bitmap) {
    const bytesPerRow = image.width / 8;
    this.raw(GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, image.height & 0xff, image.height >> 8);
    for (const b of image.data) this.bytes.push(b);
    return this;
  }
  // "2 x Iced Latte ........ P300.00", wrapping long names onto the next line.
  row(left: string, right: string, width = this.columns) {
    const room = Math.max(1, width - right.length - 1);
    const words = ascii(left).split(' ');
    const lines: string[] = [''];
    for (const word of words) {
      const current = lines[lines.length - 1];
      if (!current) lines[lines.length - 1] = word.slice(0, room);
      else if (current.length + 1 + word.length <= room) lines[lines.length - 1] = `${current} ${word}`;
      else lines.push(`  ${word}`.slice(0, room));
    }
    lines.forEach((l, i) => this.line(i === lines.length - 1 ? l.padEnd(width - right.length) + right : l));
    return this;
  }
  done() { return new Uint8Array(this.bytes); }
}

// The customer's receipt: the café's logo, the receipt number and time, the table, then the items with
// some air between them, the totals and a framed thank-you.
export function encodeReceipt(r: ReceiptData, settings: ReceiptSettings, options: PrintOptions) {
  const p = new Receipt(options.columns), half = Math.floor(options.columns / 2);
  p.align('center');
  if (settings.logo) p.raster(settings.logo).line();
  else p.bold(true).size(true, true).line(settings.name).size(false, false).bold(false);
  if (r.station === 'barista' && settings.title) p.line(settings.title);
  for (const h of settings.header ?? []) p.line(h);
  p.align('left').rule('=');
  if (r.test) p.align('center').line('Test receipt').line('The printer is working').align('left');
  if (r.offline) p.line('Saved offline - number given when sent');
  if (r.reprint) p.bold(true).line('*** REPRINT ***').bold(false);
  // A table's bill printed before they pay says so.
  if (r.heading) p.bold(true).line(r.heading).bold(false);
  if (r.station === 'barista' && r.label) p.align('center').bold(true).size(true, true).line(`Order ${r.label}`).size(false, false).bold(false).align('left').line(clock(r.created_at));
  else if (!r.test && r.label) p.bold(true).row(`Receipt #${r.label}`, clock(r.created_at)).bold(false);
  else p.line(clock(r.created_at));
  if (r.table_name) p.line(`${r.table_name}${r.guests ? ` - ${r.guests} guest${r.guests === 1 ? '' : 's'}` : ''}`);
  if (r.staff_name) p.line(`Served by ${r.staff_name}`);
  p.rule();
  // A long name wraps onto lines that stay together; the space goes between items.
  (r.items ?? []).forEach((i, n) => {
    if (n) p.gap(18);
    p.row(`${i.qty} x ${i.name ?? ''}`, peso((i.unit_price_cents ?? 0) * i.qty));
    if (i.note) p.row(`    ${i.note}`, '');
    if (i.qty > 1) p.line(`    ${peso(i.unit_price_cents)} each`);
  });
  p.rule();
  if (r.tax_cents || r.discount_cents) p.row('Subtotal', peso(r.subtotal_cents));
  // A senior/PWD discount itemises the VAT exemption and each discount, then lists the IDs shown.
  if (r.discount_cents && r.discount_lines?.length) { for (const l of r.discount_lines) p.row(l.label, `-${peso(l.cents)}`); for (const id of r.discount_ids ?? []) p.line(`  ${id}`); }
  else if (r.discount_cents) p.row(`Discount${r.discount_label ? ` (${r.discount_label})` : ''}`, `-${peso(r.discount_cents)}`);
  if (r.tax_cents) p.row('Tax', peso(r.tax_cents));
  // Double-width text fits half as many characters.
  p.bold(true).size(true, false).row('TOTAL', peso(r.total_cents), half).size(false, false).bold(false);
  if (r.cash_tendered_cents != null) p.row('Cash', peso(r.cash_tendered_cents)).row('Change', peso(r.change_cents ?? 0));
  p.rule('=').align('center');
  for (const f of settings.footer ?? []) p.line(f.length + 4 <= options.columns ? `* ${f} *` : f);
  p.raw(LF, LF, LF, LF);
  if (options.cut) p.raw(GS, 0x56, 0x42, 0x00); // feed and cut; printers without a cutter ignore it
  if (options.drawer) p.raw(ESC, 0x70, 0x00, 0x19, 0xfa); // kick the cash drawer plugged into the printer
  return p.done();
}

// The kitchen's or the barista's copy (from the till when that station's screen isn't connected, or from the
// station tablet's own printer): a black KITCHEN ORDER or BARISTA ORDER band so it can't be mistaken for a
// receipt or for the other station's slip, then what to make, large and well spaced, with no prices.
export function encodeKitchenSlip(r: ReceiptData, options: PrintOptions) {
  const p = new Receipt(options.columns);
  // Double width fits half the characters: the band is " KITCHEN ORDER " on 58 mm paper and up.
  p.align('center').bold(true).reverse(true).size(true, true).line(r.prep === 'barista' ? ' BARISTA ORDER ' : ' KITCHEN ORDER ').size(false, false).reverse(false);
  p.size(false, true).line(r.table_name ?? 'Takeout').size(false, false).bold(false);
  p.line([r.guests ? `${r.guests} guest${r.guests === 1 ? '' : 's'}` : '', r.label ? `Receipt #${r.label}` : ''].filter(Boolean).join(' - ')).line(clock(r.created_at));
  if (r.offline) p.line('Saved offline');
  if (r.reprint) p.line('*** REPRINT ***');
  if (r.late) p.bold(true).line('LATE - check for a till slip').bold(false);
  if (r.banner) p.bold(true).size(false, true).line(`*** ${r.banner} ***`).size(false, false).bold(false);
  p.align('left').rule('=').bold(true).size(false, true);
  // A preparation note goes under its item in normal-size text; a line taken off a changed order says so.
  (r.items ?? []).forEach((i, n) => {
    if (n) p.gap(24);
    p.row(i.qty ? `${i.qty} x ${i.name ?? ''}` : `REMOVED: ${i.name ?? ''}`, '');
    if (i.note) p.size(false, false).bold(false).row(`   - ${i.note}`, '').bold(true).size(false, true);
  });
  p.size(false, false).bold(false).rule('=');
  p.raw(LF, LF, LF, LF);
  if (options.cut) p.raw(GS, 0x56, 0x42, 0x00);
  return p.done();
}

// Between the customer's receipt and the kitchen slip on a printer without a cutter: room to tear and a
// clear line to tear along.
export function tearOff(options: PrintOptions) {
  const p = new Receipt(options.columns), label = ' tear here ', side = Math.max(2, Math.floor((options.columns - label.length) / 2));
  return p.align('center').line('-'.repeat(side) + label + '-'.repeat(side)).raw(LF, LF, LF).done();
}

// Several printouts sent to the printer as one job.
export function joinPrints(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// ---------- Sending ----------

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// RawBT (Android app) receives the raw bytes and forwards them to the paired USB/Bluetooth printer.
function sendRawBT(bytes: Uint8Array) {
  location.href = `intent:base64,${toBase64(bytes)}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
}

// The till can have a printer for each kind of paper: the receipt printer and, if wanted, one of its own for
// the kitchen's slips and one for the barista's. Each slot finds its own printer again after a reload. The
// receipt printer keeps the names it was remembered by before there were slots.
export type PrinterSlot = 'receipt' | 'kitchen' | 'barista';
const slotKey = (key: string, slot: PrinterSlot) => slot === 'receipt' ? key : `${key}.${slot}`;
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } };

// --- USB (WebUSB) ---
const usbApi = () => (navigator as any).usb;
const USB_KEY = '5way.usbPrinter';
const usbId = (d: any) => `${d.vendorId}:${d.productId}:${d.serialNumber ?? ''}`;
const usbDevices: Partial<Record<PrinterSlot, { device: any; endpoint: number }>> = {};
async function openUsb(device: any, slot: PrinterSlot) {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  // Prefer the printer-class interface (7); otherwise any interface with a bulk OUT endpoint.
  const interfaces = device.configuration.interfaces;
  const pick = interfaces.find((i: any) => i.alternate.interfaceClass === 7) ?? interfaces.find((i: any) => i.alternate.endpoints.some((e: any) => e.direction === 'out' && e.type === 'bulk'));
  if (!pick) throw new Error('This USB device has no way to send print data');
  if (!pick.claimed) await device.claimInterface(pick.interfaceNumber);
  const endpoint = pick.alternate.endpoints.find((e: any) => e.direction === 'out' && e.type === 'bulk');
  usbDevices[slot] = { device, endpoint: endpoint.endpointNumber };
  save(slotKey(USB_KEY, slot), usbId(device));
  return device;
}
// A printer allowed before is remembered by Chrome, so it reconnects without asking. A receipt printer set up
// before printers were told apart takes the first one.
async function knownUsb(slot: PrinterSlot) {
  const devices: any[] = (await usbApi()?.getDevices?.().catch(() => [])) ?? [], id = read(slotKey(USB_KEY, slot));
  return devices.find((d) => usbId(d) === id) ?? (slot === 'receipt' && !id ? devices[0] : null);
}
async function sendUsb(bytes: Uint8Array, slot: PrinterSlot) {
  if (!usbDevices[slot]) {
    const known = await knownUsb(slot);
    if (!known) throw new Error('No USB printer connected. Open Printer settings and tap Connect.');
    await openUsb(known, slot);
  }
  const { device, endpoint } = usbDevices[slot]!;
  for (let i = 0; i < bytes.length; i += 4096) await device.transferOut(endpoint, bytes.slice(i, i + 4096));
}

// --- Bluetooth Low Energy (Web Bluetooth) ---
// Services that BLE receipt printers commonly use for print data.
const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb', '0000ffe5-0000-1000-8000-00805f9b34fb'];
// A printer can have several writable "channels" (characteristics) and only one takes print data. These
// are the usual print channels, tried first; the rest follow in the order the printer lists them.
const PRINT_CHANNELS = ['00002af1', '0000ff02', '49535343-8841', 'bef8d6c9', '0000ae01', '0000fff2', '0000ffe1', '0000ffe9'];
const rank = (uuid: string) => { const i = PRINT_CHANNELS.findIndex((p) => uuid.startsWith(p)); return i < 0 ? PRINT_CHANNELS.length : i; };
export type BleChannel = { service: string; characteristic: string; write: boolean; noResponse: boolean };
// The printer chosen with Connect: its channels and the one in use. The channel is looked up again whenever
// the link has dropped (printer asleep, switched off, out of range), because the old one is dead after that.
type BleTarget = { device: any; name: string; channels: BleChannel[]; at: number; char: any; slot: PrinterSlot };
const bleTargets: Partial<Record<PrinterSlot, BleTarget>> = {};
async function bleCharacteristic(target: BleTarget) {
  const { device, channels, at } = target, channel = channels[at];
  if (!target.char || !device.gatt.connected || target.char.uuid !== channel.characteristic) {
    const server = await device.gatt.connect();
    target.char = await (await server.getPrimaryService(channel.service)).getCharacteristic(channel.characteristic);
  }
  return target.char;
}
// How print data goes to the printer. Many 58 mm printers take 100 bytes per write; some only 20 (the
// smallest Bluetooth packet). Automatic starts with what last worked on this tablet (100 on the usual
// channel at first); if the printer refuses before anything printed, it tries 20 bytes, then the next
// channel. Size, write type and channel can also be set by hand in Printer settings (for the receipt printer).
export type BleSettings = { size: 'auto' | number; write: 'auto' | 'response' | 'no-response'; channel: 'auto' | string };
const BLE_SETTINGS_KEY = '5way.bleSettings', BLE_WORKED_KEY = '5way.bleSizeThatWorked', BLE_CHANNEL_KEY = '5way.bleChannelThatWorked';
const DEFAULTS: BleSettings = { size: 'auto', write: 'auto', channel: 'auto' };
export function bleSettings(): BleSettings { try { return { ...DEFAULTS, ...JSON.parse(read(BLE_SETTINGS_KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; } }
export function saveBleSettings(next: BleSettings) { save(BLE_SETTINGS_KEY, JSON.stringify(next)); }
export const bleChannels = (slot: PrinterSlot = 'receipt') => bleTargets[slot]?.channels ?? [];
export const shortUuid = (uuid: string) => uuid.startsWith('0000') ? uuid.slice(4, 8) : uuid.slice(0, 8);
// What the last print did, shown under Connect so a problem can be described exactly.
export type BleReport = { printer: string; channel: string; channelNo: number; channels: number; canWrite: string; size: number; write: string; bytes: number; pieces: number; tries: number; ok: boolean; error?: string };
export let lastBleReport: BleReport | null = null;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Chrome forgets the printer when the page reloads. Where it allows it (getDevices), the printer picked
// last time is found again without a tap, by the id (or name) remembered on this tablet.
const BLE_NAME_KEY = '5way.blePrinter', BLE_ID_KEY = '5way.blePrinterId';
async function attachBle(device: any, slot: PrinterSlot) {
  const server = await device.gatt.connect();
  device.addEventListener?.('gattserverdisconnected', () => { for (const t of Object.values(bleTargets)) if (t?.device === device) t.char = null; });
  const channels: BleChannel[] = [];
  for (const uuid of BLE_SERVICES) {
    try {
      for (const c of await (await server.getPrimaryService(uuid)).getCharacteristics()) {
        if (c.properties.write || c.properties.writeWithoutResponse) channels.push({ service: uuid, characteristic: c.uuid, write: !!c.properties.write, noResponse: !!c.properties.writeWithoutResponse });
      }
    } catch { /* the printer doesn't have this service */ }
  }
  if (!channels.length) {
    device.gatt.disconnect();
    throw new Error('This printer only has classic Bluetooth, which Chrome can’t send to. Use a USB cable (Printer type: ESC/POS over USB cable).');
  }
  channels.sort((a, b) => rank(a.characteristic) - rank(b.characteristic));
  const target: BleTarget = { device, name: device.name || 'Bluetooth printer', channels, at: Math.max(0, channels.findIndex((c) => c.characteristic === read(slotKey(BLE_CHANNEL_KEY, slot)))), char: null, slot };
  bleTargets[slot] = target;
  save(slotKey(BLE_NAME_KEY, slot), target.name);
  if (device.id) save(slotKey(BLE_ID_KEY, slot), device.id);
  return target.name;
}
async function bleFromEarlier(slot: PrinterSlot) {
  const bluetooth = (navigator as any).bluetooth, name = read(slotKey(BLE_NAME_KEY, slot)), id = read(slotKey(BLE_ID_KEY, slot));
  if (!bluetooth?.getDevices || !name) return false;
  const devices: any[] = await bluetooth.getDevices().catch(() => []);
  // Two printers of the same model share a name, so the one remembered by id comes first.
  for (const device of [...devices.filter((d) => id && d.id === id), ...devices.filter((d) => !(id && d.id === id) && d.name === name)]) {
    try { await attachBle(device, slot); return true; } catch { /* try the next one */ }
  }
  return false;
}
async function sendBle(bytes: Uint8Array, slot: PrinterSlot) {
  if (!bleTargets[slot] && !(await bleFromEarlier(slot))) throw new Error('The Bluetooth printer isn’t connected. Chrome forgets it when the page reloads.');
  const target = bleTargets[slot]!, settings = slot === 'receipt' ? bleSettings() : DEFAULTS;
  const chosen = settings.channel === 'auto' ? -1 : target.channels.findIndex((c) => c.characteristic === settings.channel);
  if (chosen >= 0) target.at = chosen;
  const channels = chosen >= 0 ? [target.at] : [target.at, ...target.channels.map((_, i) => i).filter((i) => i !== target.at)];
  const sizes = settings.size === 'auto' ? [...new Set([Number(read(slotKey(BLE_WORKED_KEY, slot))) || 100, 20])] : [Number(settings.size)];
  let tries = 0, lastError: Error | null = null;
  for (const at of channels) {
    for (const size of sizes) {
      target.at = at; tries++;
      let sent = 0, pieces = 0, mode = '';
      try {
        const c = await bleCharacteristic(target);
        // Automatic prefers "with response": the printer confirms each piece before the next is sent, so a
        // small buffer (common on 58 mm printers such as the Xprinter 58IIH) never overflows. Unconfirmed
        // writes, when that's all a channel takes, get a short pause after every piece instead.
        const noResponse = settings.write === 'no-response' || (settings.write === 'auto' && !c.properties.write);
        mode = noResponse ? 'without response' : 'with response';
        for (; sent < bytes.length; sent += size, pieces++) {
          const chunk = bytes.slice(sent, sent + size);
          if (noResponse) { await c.writeValueWithoutResponse(chunk); await pause(25); }
          else await (c.writeValueWithResponse ? c.writeValueWithResponse(chunk) : c.writeValue(chunk));
        }
        if (settings.size === 'auto') save(slotKey(BLE_WORKED_KEY, slot), String(size));
        if (settings.channel === 'auto') save(slotKey(BLE_CHANNEL_KEY, slot), target.channels[at].characteristic);
        lastBleReport = report(target, size, mode, bytes.length, pieces, tries, true);
        return;
      } catch (e) {
        target.char = null; lastError = e as Error;
        lastBleReport = report(target, size, mode, bytes.length, pieces, tries, false, lastError.message);
        // After part of the receipt printed, trying again would print that part twice, so stop here.
        if (sent > 0) throw new Error(`Bluetooth printer stopped (${lastError.message}). Switch the printer off and on, then tap Connect in Printer settings.`);
      }
    }
  }
  throw new Error(`The printer refused the print data on ${channels.length === 1 ? 'the chosen Bluetooth channel' : `all ${channels.length} of its Bluetooth channels`} (${lastError?.message}). Turn the tablet’s Bluetooth and the printer off and on, then tap Connect.`);
}
function report(t: BleTarget, size: number, write: string, bytes: number, pieces: number, tries: number, ok: boolean, error?: string): BleReport {
  const channel = t.channels[t.at];
  return { printer: t.name, channel: `${shortUuid(channel.service)}/${shortUuid(channel.characteristic)}`, channelNo: t.at + 1, channels: t.channels.length,
    canWrite: [channel.write && 'with response', channel.noResponse && 'without response'].filter(Boolean).join(' & ') || 'unknown',
    size, write, bytes, pieces, tries, ok, error };
}

// Asks the browser for the printer. Must run from a tap (browsers require it).
export async function connectPrinter(method: PrintMethod, slot: PrinterSlot = 'receipt'): Promise<string> {
  if (method === 'usb') {
    if (!usbApi()) throw new Error('This browser cannot use USB printers. Use Chrome on Android over HTTPS, or the RawBT app.');
    const device = await openUsb(await usbApi().requestDevice({ filters: [] }), slot);
    return device.productName || 'USB printer';
  }
  if (method === 'ble') {
    const bluetooth = (navigator as any).bluetooth;
    if (!bluetooth) throw new Error('This browser cannot use Bluetooth printers. Use Chrome over HTTPS, or the RawBT app.');
    return attachBle(await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES }), slot);
  }
  return method === 'rawbt' ? 'RawBT app' : 'Print screen';
}

// Finds the printer used before on this tablet without a tap, where the browser allows it. Null if it can't.
export async function reconnectPrinter(method: PrintMethod, slot: PrinterSlot = 'receipt'): Promise<string | null> {
  if (method === 'ble') return bleTargets[slot] || await bleFromEarlier(slot).catch(() => false) ? bleTargets[slot]!.name : null;
  if (method === 'usb' && !usbDevices[slot]) {
    const known = await knownUsb(slot);
    if (known) await openUsb(known, slot).catch(() => null);
  }
  return connectedPrinter(method, slot);
}

export function connectedPrinter(method: PrintMethod, slot: PrinterSlot = 'receipt') {
  if (method === 'usb') return usbDevices[slot]?.device.productName ?? null;
  if (method === 'ble') return bleTargets[slot]?.name ?? null;
  return null;
}

// One job at a time, on every printer: a print that started in the middle of another (a station's slip handed
// to the till while it prints a receipt) would mix its bytes into the first.
let printing: Promise<unknown> = Promise.resolve();
export function sendToPrinter(method: PrintMethod, bytes: Uint8Array, slot: PrinterSlot = 'receipt'): Promise<void> {
  const job = printing.then(() => sendNow(method, bytes, slot));
  printing = job.catch(() => {});
  return job;
}
async function sendNow(method: PrintMethod, bytes: Uint8Array, slot: PrinterSlot) {
  if (method === 'rawbt') return sendRawBT(bytes);
  if (method === 'usb') return sendUsb(bytes, slot);
  if (method === 'ble') return sendBle(bytes, slot);
  throw new Error('Not an ESC/POS printer');
}
