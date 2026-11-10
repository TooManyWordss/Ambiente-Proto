import { useCallback, useEffect, useRef, useState } from 'react';
import { connectPrinter, encodeKitchenSlip, joinPrints, keepPrintersLinked, printerWaitingText, reconnectPrinter, sendToPrinter, type ReceiptData } from '../printing/escpos';
import { api } from '../shared/api';
import { storageKey } from '../shared/store';
import { Dialog } from '../shared/ui';

// One printout for the kitchen. The key changes when the order changes, so a changed order prints again.
export type KitchenSlip = ReceiptData & { key: string };
// Printing is on unless switched off: every order that arrives on the screen prints. `since` is when it was
// switched on; orders already waiting then don't print, so a tablet doesn't print a pile of old tickets.
type Settings = { on: boolean; method: 'ble' | 'usb'; paper: '58' | '80'; cut: boolean; since?: string };
const DEFAULTS: Settings = { on: true, method: 'ble', paper: '58', cut: false };
// What has printed is remembered for a week, so a reload doesn't print it again.
const KEEP_MS = 7 * 86_400_000;
const settingsKey = () => storageKey('kitchenPrint'), printedKey = () => storageKey('kitchenPrinted');
function read<T extends object>(key: string, fallback: T): T { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { return fallback; } }
function write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered on this tablet */ } }

export type KitchenPrinting = ReturnType<typeof useKitchenPrinting>;
// The till prints what this tablet's printer couldn't. False when no till is open to take them.
const handToTill = (batch: KitchenSlip[]) => api('/api/kitchen/takeover', { method: 'POST', body: { slips: batch.map(({ key, ...slip }) => slip) }, timeoutMs: 20_000 }).then(() => true, () => false);

// A ticket that shows up here well after it was placed came while this tablet or the till was offline, and the
// till printed it on paper then. It still prints here, marked late, so the cook checks before making it twice.
const LATE_MS = 90_000;
const lateness = (s: KitchenSlip): KitchenSlip => !s.banner && Date.now() - Date.parse(s.created_at ?? '') > LATE_MS ? { ...s, late: true } : s;

// The kitchen or barista tablet's own receipt printer: every new ticket prints as it arrives (from the moment the
// screen opens), and again marked "ORDER CHANGED" or "CANCELLED" when it changes. If the printer can't
// be reached, a till prints them instead; only if no till can take them do they wait here, with a banner to
// connect the printer and print them.
export function useKitchenPrinting(slips: KitchenSlip[], active: boolean, station: 'kitchen' | 'barista' = 'kitchen') {
  const [settings, setSettings] = useState<Settings>(() => {
    const s = read(settingsKey(), DEFAULTS);
    if (s.on && !s.since) { s.since = new Date().toISOString(); write(settingsKey(), s); }
    return s;
  });
  const [printer, setPrinter] = useState<string | null>(null), [failed, setFailed] = useState<{ slips: KitchenSlip[]; message: string } | null>(null), [busy, setBusy] = useState(false);
  const [handed, setHanded] = useState<{ count: number; message: string } | null>(null);
  const live = useRef(settings); live.current = settings;
  const printed = useRef<Record<string, number> | null>(null), tried = useRef(new Set<string>()), queue = useRef<Promise<void>>(Promise.resolve());
  if (!printed.current) {
    const now = Date.now();
    printed.current = Object.fromEntries(Object.entries(read<Record<string, number>>(printedKey(), {})).filter(([, at]) => now - at < KEEP_MS));
  }
  const markPrinted = (keys: string[]) => { for (const k of keys) printed.current![k] = Date.now(); write(printedKey(), printed.current); };

  // Prints run one after another: a Bluetooth printer takes one job at a time.
  const send = useCallback((batch: KitchenSlip[]) => {
    queue.current = queue.current.then(async () => {
      const s = live.current, options = { columns: s.paper === '58' ? 32 : 48, cut: s.cut, drawer: false };
      const keys = new Set(batch.map((b) => b.key));
      try {
        await sendToPrinter(s.method, joinPrints(...batch.map((b) => encodeKitchenSlip(b, options))));
        markPrinted([...keys]);
        setPrinter(await reconnectPrinter(s.method)); setHanded(null);
        setFailed((f) => f && (f.slips.some((x) => !keys.has(x.key)) ? { ...f, slips: f.slips.filter((x) => !keys.has(x.key)) } : null));
      } catch (e) {
        const message = (e as Error).message;
        if (!batch[0].key.startsWith('test:') && await handToTill(batch)) {
          markPrinted([...keys]);
          setHanded((h) => ({ count: (h?.count ?? 0) + batch.length, message }));
          setFailed((f) => f && (f.slips.some((x) => !keys.has(x.key)) ? { ...f, slips: f.slips.filter((x) => !keys.has(x.key)) } : null));
        } else setFailed((f) => ({ slips: [...(f?.slips ?? []).filter((x) => !keys.has(x.key)), ...batch], message }));
      }
    });
    return queue.current;
  }, []);

  const signature = slips.map((s) => s.key).join('|');
  useEffect(() => {
    if (!active || !settings.on) return;
    // A changed or cancelled order prints even if it first arrived before printing was switched on.
    const fresh = slips.filter((s) => !printed.current![s.key] && !tried.current.has(s.key) && (s.banner || !settings.since || (s.created_at ?? '') >= settings.since));
    if (!fresh.length) return;
    fresh.forEach((s) => tried.current.add(s.key));
    void send(fresh.map(lateness));
  }, [signature, active, settings.on, settings.since, send]);

  // After a reload, finds the printer again without a tap where the browser allows it.
  const wake = useCallback(async () => { if (live.current.on) setPrinter(await reconnectPrinter(live.current.method)); }, []);
  const save = (change: Settings) => {
    let next = change;
    // Switching it on prints only what arrives from now on, not the tickets already on the screen.
    if (next.on && !live.current.on) { markPrinted(slips.map((s) => s.key)); next = { ...next, since: new Date().toISOString() }; }
    const lookAgain = next.on && (!live.current.on || next.method !== live.current.method);
    if (next.method !== live.current.method) setPrinter(null);
    live.current = next; setSettings(next); write(settingsKey(), next);
    if (lookAgain) void wake();
  };
  // Keeps the printer linked with no tap: after a reload, a dropped link, or the Wi-Fi going off.
  useEffect(() => keepPrintersLinked(() => live.current.on ? [[live.current.method, 'receipt']] : [], (_, name) => setPrinter(name)), []);
  // Must run from a tap: the browser asks which printer to use.
  const connect = async () => {
    setBusy(true);
    try { setPrinter(await connectPrinter(live.current.method)); if (failed) await send(failed.slips); }
    catch (e) { if ((e as Error).name !== 'NotFoundError') setFailed((f) => ({ slips: f?.slips ?? [], message: (e as Error).message })); }
    finally { setBusy(false); }
  };
  const test = () => send([{ key: `test:${Date.now()}`, label: '', table_name: 'Printer test', created_at: new Date().toISOString(), prep: station, items: [{ qty: 1, name: `The ${station} printer works` }] }]).then(() => { /* a test isn't a ticket */ });
  const skip = () => { if (failed) markPrinted(failed.slips.map((s) => s.key)); setFailed(null); setHanded(null); };
  // Asked by the server before the till decides on paper slips: a tablet with printing off leaves them to the till.
  const status = () => ({ prints: live.current.on });
  return { settings, save, printer, failed, handed, busy, connect, test, skip, wake, status, station };
}

// Shown above the tickets when printing is on but the printer needs a tap, or tickets didn't print.
export function KitchenPrintBanner({ printing, active }: { printing: KitchenPrinting; active: boolean }) {
  const { settings, printer, failed, handed, busy, connect, skip, station } = printing;
  if (!settings.on || !active) return null;
  const waiting = failed?.slips.filter((s) => !s.key.startsWith('test:')).length ?? 0;
  if (!failed && !handed && printer) return null;
  return <div className="kp-banner" role="alert">
    <span>{failed ? `${waiting ? `${waiting} ${waiting === 1 ? 'ticket' : 'tickets'} didn’t print, and no till could print ${waiting === 1 ? 'it' : 'them'} either. ` : 'The test didn’t print. '}${failed.message}`
      : handed ? `${handed.count} ${handed.count === 1 ? 'ticket' : 'tickets'} couldn’t print here, so the till printed ${handed.count === 1 ? 'it' : 'them'}. ${handed.message}`
      : `The ${station} printer isn’t connected, so new tickets print at the till instead.`}</span>
    <div className="kp-banner-actions">
      <button className="btn primary small" disabled={busy} onClick={() => void connect()}>{waiting ? 'Connect printer & print' : 'Connect printer'}</button>
      {(failed || handed) && <button className="btn ghost small" onClick={skip}>{waiting ? 'Don’t print them' : 'Dismiss'}</button>}
    </div>
  </div>;
}

export function KitchenPrinterSettings({ printing, onClose }: { printing: KitchenPrinting; onClose: () => void }) {
  const { settings, save, printer, busy, connect, test, failed, station } = printing;
  return <Dialog title={station === 'barista' ? 'Barista printer' : 'Kitchen printer'} onClose={onClose}>
    <label className="check"><input type="checkbox" checked={settings.on} onChange={(e) => save({ ...settings, on: e.target.checked })} /> Print every new order as it arrives</label>
    <p className="hint">Each ticket prints once, with the table and what to {station === 'barista' ? 'make' : 'cook'}. A changed or cancelled order prints again, marked so. Tickets already on the screen when you switch this on don’t print. If this printer can’t print (or printing is off), the till prints the tickets instead.</p>
    <label>Printer type<select value={settings.method} onChange={(e) => save({ ...settings, method: e.target.value as Settings['method'] })}>
      <option value="ble">Bluetooth (Chrome)</option>
      <option value="usb">USB cable (Chrome)</option>
    </select></label>
    <p className="hint">{settings.method === 'ble' ? 'Prints straight from Chrome over Bluetooth, no app needed. Tap Connect and pick the printer. After a reload it reconnects by itself where Chrome allows; otherwise a banner asks you to connect.' : 'Plug the printer into the tablet with a USB OTG cable, tap Connect and choose it. Chrome remembers the printer.'} Needs the HTTPS address.</p>
    <div className="sheet-actions"><span className="hint">{printer ?? printerWaitingText(settings.method)}</span><button className="btn" disabled={busy} onClick={() => void connect()}>Connect</button></div>
    <label>Paper width<select value={settings.paper} onChange={(e) => save({ ...settings, paper: e.target.value as Settings['paper'] })}><option value="58">58 mm (32 characters)</option><option value="80">80 mm (48 characters)</option></select></label>
    <label className="check"><input type="checkbox" checked={settings.cut} onChange={(e) => save({ ...settings, cut: e.target.checked })} /> Cut the paper after each ticket (printers with a cutter)</label>
    {failed && <p className="status error" role="status">Last print failed: {failed.message}</p>}
    <div className="sheet-actions"><button className="btn ghost" onClick={() => void test()}>Print a test ticket</button><button className="btn primary" onClick={onClose}>Done</button></div>
  </Dialog>;
}
