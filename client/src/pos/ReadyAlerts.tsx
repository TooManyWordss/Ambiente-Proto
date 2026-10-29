import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../shared/api';
import { chime } from '../shared/sound';
import { storageKey } from '../shared/store';

// One order (or table ticket) with the pieces the kitchen has finished. Each piece has its own key.
type Pickup = { key: string; title: string; label: string | null; items: { name: string; qty: number; note: string | null; from?: string; keys: string[] }[]; ready_at: string; ready: number; total: number; complete: boolean };

const ago = (iso: string, now: number) => { const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000)); return m < 1 ? 'just now' : `${m} min ago`; };
const readKeys = (key: string): string[] => { try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; } };

// "Ready to collect": food the kitchen has finished, item by item, shown on the till with a chime until
// someone taps "Picked up". Part of an order can be collected while the rest cooks; the rest rings again
// when it's done. The list comes from the server, so a reload or a dropped connection doesn't lose any.
export function ReadyAlerts({ station }: { station: 'cashier' | 'barista' }) {
  const doneKey = storageKey(`pickedUp.${station}`);
  const [list, setList] = useState<Pickup[]>([]), [done, setDone] = useState(() => readKeys(doneKey)), [now, setNow] = useState(Date.now()), [all, setAll] = useState(false);
  const shown = useRef<Set<string> | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await api<Pickup[]>(`/api/pos/ready?station=${station}`, { redirectOnUnauthorized: false });
      setList(data);
      // Forget "picked up" marks for pieces that have dropped off the list.
      const live = new Set(data.flatMap((p) => p.items.flatMap((i) => i.keys)));
      setDone((d) => d.filter((k) => live.has(k)));
    } catch {}
  }, [station]);
  useEffect(() => {
    void load();
    const refresh = () => void load(), tick = setInterval(() => { setNow(Date.now()); void load(); }, 30000);
    window.addEventListener('dining.live', refresh); window.addEventListener('online', refresh);
    return () => { clearInterval(tick); window.removeEventListener('dining.live', refresh); window.removeEventListener('online', refresh); };
  }, [load]);
  useEffect(() => { try { localStorage.setItem(doneKey, JSON.stringify(done)); } catch {} }, [doneKey, done]);

  // What's still to collect: each order's pieces not yet picked up.
  const waiting = list.map((p) => {
    const items = p.items.map((i) => ({ ...i, keys: i.keys.filter((k) => !done.includes(k)) })).filter((i) => i.keys.length);
    return { ...p, items, collected: p.ready - items.reduce((n, i) => n + i.keys.length, 0) };
  }).filter((p) => p.items.length);
  const pieces = waiting.flatMap((p) => p.items.flatMap((i) => i.keys));
  useEffect(() => {
    const keys = new Set(pieces);
    // No chime for pieces already waiting when the page opened, only for ones that finish while it's open.
    if (shown.current && [...keys].some((k) => !shown.current!.has(k))) { chime([1047, 1319, 1568]); navigator.vibrate?.([200, 100, 200]); setNow(Date.now()); }
    shown.current = keys;
  }, [pieces.join('|')]);

  if (!waiting.length) return null;
  const visible = all ? waiting : waiting.slice(0, 2);
  return <aside className="pickup-alerts" role="status" aria-live="assertive" aria-label="Ready to collect from the kitchen">
    {visible.map((p) => <article className="pickup" key={p.key}>
      <div className="pickup-body">
        <span className="pickup-kicker">{p.complete ? (p.collected ? 'Rest of the order ready' : 'Whole order ready') : `Ready: ${p.ready} of ${p.total} items`} · {ago(p.ready_at, now)}</span>
        <strong className="pickup-title">{p.title}{p.label && <span> · #{p.label}</span>}</strong>
        <span className="pickup-items">{p.items.map((i) => `${i.keys.length} × ${i.name}${i.note ? ` (${i.note})` : ''}${i.from === 'barista' ? ' · from the barista' : ''}`).join(' · ')}</span>
        {!p.complete && <span className="pickup-wait">The rest is still cooking</span>}
      </div>
      <button className="btn primary" onClick={() => setDone((d) => [...d, ...p.items.flatMap((i) => i.keys)])}>Picked up</button>
    </article>)}
    {waiting.length > 2 && <button className="pickup-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `+${waiting.length - 2} more ready`}</button>}
  </aside>;
}
