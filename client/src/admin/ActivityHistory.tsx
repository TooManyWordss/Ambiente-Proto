import { useEffect, useMemo, useState } from 'react';
import { api } from '../shared/api';
import { dateLabel, time } from '../shared/format';
import { Panel } from '../shared/ui';

type Entry = { at: string; who: string; action: string; what: string };

const PERIODS = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [366, 'Year']] as const;
const manilaDay = (at: string) => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

// The owner's history of who did what: every order rung up (and who typed their code for it), every
// bill out, table and menu change, and every hand-made stock movement — grouped by day, newest first.
export function ActivityHistory({ liveTick = 0 }: { liveTick?: number }) {
  const [days, setDays] = useState<number>(7);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { void api<{ entries: Entry[] }>(`/api/admin/activity?days=${days}`).then(d => setEntries(d.entries)).catch(() => setEntries([])); }, [days, liveTick]);
  const byDay = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = (entries ?? []).filter(e => !q || e.who.toLowerCase().includes(q) || e.what.toLowerCase().includes(q));
    const groups: { day: string; rows: Entry[] }[] = [];
    for (const e of shown) {
      const day = manilaDay(e.at);
      if (groups.at(-1)?.day !== day) groups.push({ day, rows: [] });
      groups.at(-1)!.rows.push(e);
    }
    return groups;
  }, [entries, filter]);
  return <Panel title={<>Activity history
    <span className="perf-units" role="tablist">{PERIODS.map(([d, label]) => <button key={d} role="tab" aria-selected={days === d} className={`chip ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>{label}</button>)}</span>
    <input className="activity-filter" type="search" placeholder="Filter by name or action…" aria-label="Filter the activity history" value={filter} onChange={e => setFilter(e.target.value)}/></>}>
    <p className="hint">Every order, bill out, table, menu and stock action, with the person who typed their staff code for it. The newest is on top.</p>
    {entries === null ? <p className="hint">Loading…</p> : !byDay.length ? <p className="hint">Nothing in this period{filter ? ' matches the filter' : ''}.</p> : byDay.map(g => <div className="activity-day" key={g.day}>
      <h3>{dateLabel(g.day)} · {g.rows.length} action{g.rows.length === 1 ? '' : 's'}</h3>
      <ul className="log-list">{g.rows.map((e, n) => <li key={`${e.at}-${n}`}><span className="log-time">{time(e.at)}</span><b className="log-actor">{e.who}</b><span>{e.what}</span></li>)}</ul>
    </div>)}
  </Panel>;
}
