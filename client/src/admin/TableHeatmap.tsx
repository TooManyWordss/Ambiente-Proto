import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import { dateLabel } from '../shared/format';
import type { DiningTable } from '../shared/types';
import { FloorMap } from '../tables/FloorMap';

type Use = { id?: number; name: string; seats: number | null; seatings: number; guests: number; minutes: number; timed: number };
type Heat = { from: string; days: number; tables: Use[]; others: Use[] };
type Measure = 'seatings' | 'guests' | 'minutes';

const RANGES: [number, string][] = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days']];
const MEASURES: [Measure, string][] = [['seatings', 'Seatings'], ['guests', 'Guests'], ['minutes', 'Time occupied']];
const LEVELS = 5;

const hours = (m: number) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const amount = (measure: Measure, n: number) => measure === 'minutes' ? hours(n) : plural(n, measure === 'seatings' ? 'seating' : 'guest');
// Shade 1–5 in equal steps up to the busiest table; 0 means the table wasn't used at all.
const levelOf = (value: number, max: number) => value && max ? Math.max(1, Math.ceil(value / max * LEVELS)) : 0;
const summary = (u: Use) => [plural(u.seatings, 'seating'), plural(u.guests, 'guest'), u.timed ? `${hours(u.minutes)} occupied · ${hours(Math.round(u.minutes / u.timed))} average stay` : null].filter(Boolean).join(' · ');

// The owner's table heatmap: the floor map shaded by how often each table is sat at, so the busiest
// and quietest spots stand out. Tap or hover a table for its numbers; the list below has them all.
export function TableHeatmap({ tables }: { tables: DiningTable[] }) {
  const [days, setDays] = useState(30), [measure, setMeasure] = useState<Measure>('seatings'), [heat, setHeat] = useState<Heat | null>(null), [error, setError] = useState('');
  const [picked, setPicked] = useState<number | null>(null), [hovered, setHovered] = useState<number | null>(null);
  useEffect(() => { setError(''); api<Heat>(`/api/admin/table-heat?days=${days}`).then(setHeat).catch((e) => setError((e as Error).message)); }, [days]);

  const uses = new Map((heat?.tables ?? []).map((u) => [u.id!, u]));
  const max = Math.max(0, ...(heat?.tables ?? []).map((u) => u[measure]));
  const level = Object.fromEntries(tables.map((t) => [t.id, levelOf(uses.get(t.id)?.[measure] ?? 0, max)]));
  const ranked = [...(heat?.tables ?? [])].sort((a, b) => b[measure] - a[measure] || a.name.localeCompare(b.name));
  const total = ranked.reduce((n, u) => n + u[measure], 0), top = ranked[0], unused = ranked.filter((u) => !u.seatings);
  const shownId = hovered ?? picked, shown = shownId == null ? null : uses.get(shownId);
  // The legend lists each shade's range, skipping shades no table can fall in (with small numbers).
  const steps = Array.from({ length: LEVELS }, (_, i) => {
    const lo = Math.floor(max * i / LEVELS) + 1, hi = Math.floor(max * (i + 1) / LEVELS);
    return { level: i + 1, label: measure === 'minutes' ? `up to ${hours(hi)}` : lo >= hi ? String(hi) : `${lo}–${hi}`, empty: lo > hi };
  }).filter((s) => !s.empty);

  return <section className="panel table-heat">
    <div className="th-head">
      <div><h2>Table heatmap</h2><p className="muted">{heat ? `Which tables get sat at most · ${days === 1 ? 'today' : `since ${dateLabel(heat.from)}`}` : 'Which tables get sat at most'}</p></div>
      <div className="th-filters">
        <div className="th-chips" role="group" aria-label="Period">{RANGES.map(([d, label]) => <button key={d} className={`chip ${days === d ? 'active' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>{label}</button>)}</div>
        <div className="th-chips" role="group" aria-label="Shade tables by">{MEASURES.map(([m, label]) => <button key={m} className={`chip ${measure === m ? 'active' : ''}`} aria-pressed={measure === m} onClick={() => setMeasure(m)}>{label}</button>)}</div>
      </div>
    </div>
    {error && <p className="status error">{error}</p>}
    {heat && <>
      <p className="th-headline">{top && top[measure] > 0
        ? <>Busiest: <strong>{top.name}</strong> · {amount(measure, top[measure])}{total ? ` (${Math.round(top[measure] / total * 100)}% of all)` : ''}{unused.length > 0 && <> · {plural(unused.length, 'table')} not used</>}</>
        : 'No tables were sat at in this period.'}</p>
      <div className="th-map">
        <FloorMap tables={tables} selectedId={picked} onPick={(t) => setPicked(picked === t.id ? null : t.id)} onHover={(t) => setHovered(t?.id ?? null)}
          heat={{ level, describe: (t) => { const u = uses.get(t.id); return `${t.name} · ${t.seats} seats · ${u ? summary(u) : 'not used'}`; } }} />
        <div className="th-readout" aria-live="polite">{shown ? <><strong>{shown.name}</strong> · {shown.seats} seats<br />{summary(shown)}</> : <span className="muted">Tap or point at a table to see its numbers.</span>}</div>
      </div>
      <div className="th-legend" aria-label={`Shade shows ${MEASURES.find(([m]) => m === measure)![1].toLowerCase()}`}>
        <span className="th-key"><i className="th-swatch heat-0" />Not used</span>
        {steps.map((s) => <span className="th-key" key={s.level}><i className={`th-swatch heat-${s.level}`} />{s.label}</span>)}
        <span className="muted th-key-note">{MEASURES.find(([m]) => m === measure)![1]} · fewer → more</span>
      </div>
      <details className="th-list">
        <summary>All tables as a list</summary>
        <div className="table-wrap"><table><thead><tr><th>Table</th><th>Seatings</th><th>Guests</th><th>Time occupied</th><th>Average stay</th></tr></thead>
          <tbody>{ranked.map((u) => <tr key={u.id}><td>{u.name}</td><td className="num">{u.seatings}</td><td className="num">{u.guests}</td><td className="num">{u.timed ? hours(u.minutes) : '—'}</td><td className="num">{u.timed ? hours(Math.round(u.minutes / u.timed)) : '—'}</td></tr>)}</tbody></table></div>
        {heat.others.length > 0 && <p className="muted">Unpaid tabs at tables not on the floor map: {heat.others.map((u) => `${u.name} (${plural(u.seatings, 'seating')})`).join(', ')}. Add them in Tables & menu → Manage tables to see them on the map.</p>}
      </details>
    </>}
  </section>;
}
