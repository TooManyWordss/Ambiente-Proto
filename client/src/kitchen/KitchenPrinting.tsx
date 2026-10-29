import { useCallback, useEffect, useRef, useState } from 'react';
import { connectPrinter, encodeKitchenSlip, joinPrints, reconnectPrinter, sendToPrinter, type ReceiptData } from '../printing/escpos';
import { storageKey } from '../shared/store';
import { Dialog } from '../shared/ui';

// One printout for the kitchen. The key changes when the order changes, so a changed order prints again.
export type KitchenSlip = ReceiptData & { key: string };
type Settings = { on: boolean; method: 'ble' | 'usb'; paper: '58' | '80'; cut: boolean };
const DEFAULTS: Settings = { on: false, method: 'ble', paper: '58', cut: false };
// What has printed is remembered for a week, so a reload doesn't print it again.
const KEEP_MS = 7 * 86_400_000;
const settingsKey = () => storageKey('kitchenPrint'), printedKey = () => storageKey('kitchenPrinted');
function read<T extends object>(key: string, fallback: T): T { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { return fallback; } }
function write(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered on this tablet */ } }

export type KitchenPrinting = ReturnType<typeof useKitchenPrinting>;

// The kitchen tablet's own receipt printer: every new ticket prints as it arrives (once the display has
// been started), and again marked "ORDER CHANGED" or "CANCELLED" when it changes. If the printer can't
// be reached, the tickets wait and the cook sees a banner to connect it and print them.
export function useKitchenPrinting(slips: KitchenSlip[], started: boolean) {
  const [settings, setSettings] = useState<Settings>(() => read(settingsKey(), DEFAULTS));
  const [printer, setPrinter] = useState<string | null>(null), [failed, setFailed] = useState<{ slips: KitchenSlip[]; message: string } | null>(null), [busy, setBusy] = useState(false);
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
        setPrinter(await reconnectPrinter(s.method));
        setFailed((f) => f && (f.slips.some((x) => !keys.has(x.key)) ? { ...f, slips: f.slips.filter((x) => !keys.has(x.key)) } : null));
      } catch (e) {
        setFailed((f) => ({ slips: [...(f?.slips ?? []).filter((x) => !keys.has(x.key)), ...batch], message: (e as Error).message }));
      }
    });
    return queue.current;
  }, []);

  const signature = slips.map((s) => s.key).join('|');
  useEffect(() => {
    if (!started || !settings.on) return;
    const fresh = slips.filter((s) => !printed.current![s.key] && !tried.current.has(s.key));
    if (!fresh.length) return;
    fresh.forEach((s) => tried.current.add(s.key));
    void send(fresh);
  }, [signature, started, settings.on, send]);

  // After a reload, finds the printer again without a tap where the browser allows it.
  const wake = useCallback(async () => { if (live.current.on) setPrinter(await reconnectPrinter(live.current.method)); }, []);
  const save = (next: Settings) => {
    // Switching it on prints only what arrives from now on, not the tickets already on the screen.
    if (next.on && !live.current.on) markPrinted(slips.map((s) => s.key));
    const lookAgain = next.on && (!live.current.on || next.method !== live.current.method);
    if (next.method !== live.current.method) setPrinter(null);
    live.current = next; setSettings(next); write(settingsKey(), next);
    if (lookAgain) void wake();
  };
  useEffect(() => { void wake(); }, [wake]);
  // Must run from a tap: the browser asks which printer to use.
  const connect = async () => {
    setBusy(true);
    try { setPrinter(await connectPrinter(live.current.method)); if (failed) await send(failed.slips); }
    catch (e) { if ((e as Error).name !== 'NotFoundError') setFailed((f) => ({ slips: f?.slips ?? [], message: (e as Error).message })); }
    finally { setBusy(false); }
  };
  const test = () => send([{ key: `test:${Date.now()}`, label: '', table_name: 'Printer test', created_at: new Date().toISOString(), items: [{ qty: 1, name: 'The kitchen printer works' }] }]).then(() => { /* a test isn't a ticket */ });
  const skip = () => { if (failed) markPrinted(failed.slips.map((s) => s.key)); setFailed(null); };
  return { settings, save, printer, failed, busy, connect, test, skip, wake };
}

// Shown above the tickets when printing is on but the printer needs a tap, or tickets didn't print.
export function KitchenPrintBanner({ printing, started }: { printing: KitchenPrinting; started: boolean }) {
  const { settings, printer, failed, busy, connect, skip } = printing;
  if (!settings.on || !started) return null;
  const waiting = failed?.slips.filter((s) => !s.key.startsWith('test:')).length ?? 0;
  if (!failed && printer) return null;
  return <div className="kp-banner" role="alert">
    <span>{failed ? `${waiting ? `${waiting} ${waiting === 1 ? 'ticket' : 'tickets'} didn’t print. ` : 'The test didn’t print. '}${failed.message}` : 'The kitchen printer isn’t connected, so new tickets won’t print.'}</span>
    <div className="kp-banner-actions">
      <button className="btn primary small" disabled={busy} onClick={() => void connect()}>{waiting ? 'Connect printer & print' : 'Connect printer'}</button>
      {failed && <button className="btn ghost small" onClick={skip}>{waiting ? 'Don’t print them' : 'Dismiss'}</button>}
    </div>
  </div>;
}

export function KitchenPrinterSettings({ printing, onClose }: { printing: KitchenPrinting; onClose: () => void }) {
  const { settings, save, printer, busy, connect, test, failed } = printing;
  return <Dialog title="Kitchen printer" onClose={onClose}>
    <label className="check"><input type="checkbox" checked={settings.on} onChange={(e) => save({ ...settings, on: e.target.checked })} /> Print every new order as it arrives</label>
    <p className="hint">Each ticket prints once, with the table and what to cook. A changed or cancelled order prints again, marked so. Tickets already on the screen when you switch this on don’t print.</p>
    <label>Printer type<select value={settings.method} onChange={(e) => save({ ...settings, method: e.target.value as Settings['method'] })}>
      <option value="ble">Bluetooth (Chrome)</option>
      <option value="usb">USB cable (Chrome)</option>
    </select></label>
    <p className="hint">{settings.method === 'ble' ? 'Prints straight from Chrome over Bluetooth, no app needed. Tap Connect and pick the printer. After a reload it reconnects by itself where Chrome allows; otherwise a banner asks you to connect.' : 'Plug the printer into the tablet with a USB OTG cable, tap Connect and choose it. Chrome remembers the printer.'} Needs the HTTPS address.</p>
    <div className="sheet-actions"><span className="hint">{printer ?? 'Not connected'}</span><button className="btn" disabled={busy} onClick={() => void connect()}>Connect</button></div>
    <label>Paper width<select value={settings.paper} onChange={(e) => save({ ...settings, paper: e.target.value as Settings['paper'] })}><option value="58">58 mm (32 characters)</option><option value="80">80 mm (48 characters)</option></select></label>
    <label className="check"><input type="checkbox" checked={settings.cut} onChange={(e) => save({ ...settings, cut: e.target.checked })} /> Cut the paper after each ticket (printers with a cutter)</label>
    {failed && <p className="status error" role="status">Last print failed: {failed.message}</p>}
    <div className="sheet-actions"><button className="btn ghost" onClick={() => void test()}>Print a test ticket</button><button className="btn primary" onClick={onClose}>Done</button></div>
  </Dialog>;
}
