import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../shared/api';
import { chime } from '../shared/sound';
import { storageKey } from '../shared/store';

type Pickup = { key: string; title: string; label: string | null; items: { name: string; qty: number }[]; ready_at: string };

const ago = (iso: string, now: number) => { const m = Math.max(0, Math.floor((now - Date.parse(iso)) / 60000)); return m < 1 ? 'just now' : `${m} min ago`; };
const readKeys = (key: string): string[] => { try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; } };

// "Ready to collect": orders the kitchen has finished, shown on the till with a chime until someone taps
// "Picked up". The list comes from the server, so a reload or a dropped connection doesn't lose any.
export function ReadyAlerts({ station }: { station: 'cashier' | 'barista' }) {
  const doneKey = storageKey(`pickedUp.${station}`);
  const [list, setList] = useState<Pickup[]>([]), [done, setDone] = useState(() => readKeys(doneKey)), [now, setNow] = useState(Date.now()), [all, setAll] = useState(false);
  const shown = useRef<Set<string> | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await api<Pickup[]>(`/api/pos/ready?station=${station}`, { redirectOnUnauthorized: false });
      setList(data);
      // Forget "picked up" marks for orders that have dropped off the list.
      setDone((d) => d.filter((k) => data.some((p) => p.key === k)));
    } catch {}
  }, [station]);
  useEffect(() => {
    void load();
    const refresh = () => void load(), tick = setInterval(() => { setNow(Date.now()); void load(); }, 30000);
    window.addEventListener('dining.live', refresh); window.addEventListener('online', refresh);
    return () => { clearInterval(tick); window.removeEventListener('dining.live', refresh); window.removeEventListener('online', refresh); };
  }, [load]);
  useEffect(() => { try { localStorage.setItem(doneKey, JSON.stringify(done)); } catch {} }, [doneKey, done]);

  const waiting = list.filter((p) => !done.includes(p.key));
  useEffect(() => {
    const keys = new Set(waiting.map((p) => p.key));
    // No chime for orders already waiting when the page opened, only for ones that finish while it's open.
    if (shown.current && [...keys].some((k) => !shown.current!.has(k))) { chime([1047, 1319, 1568]); navigator.vibrate?.([200, 100, 200]); setNow(Date.now()); }
    shown.current = keys;
  }, [waiting.map((p) => p.key).join('|')]);

  if (!waiting.length) return null;
  const visible = all ? waiting : waiting.slice(0, 2);
  return <aside className="pickup-alerts" role="status" aria-live="assertive" aria-label="Ready to collect from the kitchen">
    {visible.map((p) => <article className="pickup" key={p.key}>
      <div className="pickup-body">
        <span className="pickup-kicker">Ready to collect · {ago(p.ready_at, now)}</span>
        <strong className="pickup-title">{p.title}{p.label && <span> · #{p.label}</span>}</strong>
        <span className="pickup-items">{p.items.map((i) => `${i.qty} × ${i.name}`).join(' · ')}</span>
      </div>
      <button className="btn primary" onClick={() => setDone((d) => [...d, p.key])}>Picked up</button>
    </article>)}
    {waiting.length > 2 && <button className="pickup-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `+${waiting.length - 2} more ready`}</button>}
  </aside>;
}
