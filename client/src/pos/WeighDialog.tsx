import { useState, type FormEvent } from 'react';
import { MAX_GRAMS, perLabel, sizeBands, sizeOf, weighedLine } from '../../../weighed.js';
import { money } from '../shared/format';
import type { MenuItem } from '../shared/types';
import { Dialog } from '../shared/ui';

const bandText = (b: { from: number; below: number | null }) => b.below == null ? `${b.from} g and over` : b.from ? `${b.from}–${b.below - 1} g` : `under ${b.below} g`;

// A steak sold by weight: the cashier types what the scale shows, and the till names its size and prices it.
export function WeighDialog({ item, onAdd, onClose }: { item: MenuItem; onAdd: (grams: number) => void; onClose: () => void }) {
  const [grams, setGrams] = useState('');
  const g = Number(grams), line = grams ? weighedLine(item, g) : null;
  const bands = sizeBands(item), size = line && !line.error ? sizeOf(item, g) : '';
  const submit = (e: FormEvent) => { e.preventDefault(); if (line && !line.error) { onAdd(g); onClose(); } };
  return <Dialog title={`Weigh the ${item.name}`} onClose={onClose}>
    <form className="weigh" onSubmit={submit}>
      <p className="hint">{money(item.price_cents)} per {perLabel(item)}. Weigh the steak and type its weight.</p>
      {bands.length > 0 && <div className="weigh-sizes" role="group" aria-label="Sizes">{bands.map(b => <div key={b.name} className={`weigh-size ${size === b.name ? 'active' : ''}`} aria-current={size === b.name || undefined}><strong>{b.name}</strong><span>{bandText(b)}</span></div>)}</div>}
      <label>Weight in grams<input autoFocus inputMode="numeric" pattern="[0-9]*" maxLength={4} placeholder="e.g. 85" value={grams} onChange={e => setGrams(e.target.value.replace(/\D/g, ''))}/></label>
      <p className={`weigh-result ${line?.error ? 'status error' : ''}`} role="status">{!line ? `Up to ${MAX_GRAMS.toLocaleString('en-PH')} g` : line.error ?? <>{line.name} · <strong>{money(line.unit_price_cents)}</strong></>}</p>
      <div className="sheet-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!line || !!line.error}>Add to order</button>
      </div>
    </form>
  </Dialog>;
}
