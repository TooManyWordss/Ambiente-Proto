import { useState, type FormEvent } from 'react';
import { Dialog } from '../shared/ui';

export const NOTE_MAX = 140;
// Quick instructions for the cook, one tap each. Within a group with `one`, picking an option replaces
// the other (an item can't be both rare and well done).
const GROUPS: { label: string; one: boolean; options: string[] }[] = [
  { label: 'Spice', one: true, options: ['Not spicy', 'Mild', 'Spicy', 'Extra spicy'] },
  { label: 'Doneness', one: true, options: ['Rare', 'Medium rare', 'Medium', 'Medium well', 'Well done'] },
  { label: 'Other', one: false, options: ['No onions', 'No garlic', 'Sauce on the side', 'Less ice', 'Less sugar', 'Take out'] },
];
const QUICK = new Set(GROUPS.flatMap((g) => g.options));

// A note is kept as one line of text: the quick picks first, then anything typed, comma-separated.
const parts = (note: string) => note.split(',').map((p) => p.trim()).filter(Boolean);
const split = (note: string) => { const all = parts(note); return { picks: all.filter((p) => QUICK.has(p)), extra: all.filter((p) => !QUICK.has(p)).join(', ') }; };
const join = (picks: string[], extra: string) => [...picks, extra.trim()].filter(Boolean).join(', ');

// Tap-to-add instructions plus a box for anything else; edits the note text in place.
export function QuickNotes({ value, onChange }: { value: string; onChange: (note: string) => void }) {
  // What's typed stays as typed (spaces and all) while the note itself is tidied.
  const picks = split(value).picks, [extra, setExtra] = useState(() => split(value).extra);
  const toggle = (group: (typeof GROUPS)[number], option: string) => {
    const next = picks.includes(option) ? picks.filter((p) => p !== option) : [...picks.filter((p) => !(group.one && group.options.includes(p))), option];
    onChange(join(next, extra));
  };
  return <div className="quick-notes">
    {GROUPS.map((g) => <div className="qn-group" role="group" aria-label={g.label} key={g.label}>
      <span className="qn-label">{g.label}</span>
      <div className="qn-chips">{g.options.map((o) => <button type="button" key={o} className={`chip ${picks.includes(o) ? 'active' : ''}`} aria-pressed={picks.includes(o)} onClick={() => toggle(g, o)}>{o}</button>)}</div>
    </div>)}
    <label>Anything else<input value={extra} maxLength={NOTE_MAX} placeholder="e.g. no tomatoes, extra rice" onChange={(e) => { setExtra(e.target.value); onChange(join(picks, e.target.value)); }} /></label>
  </div>;
}

// The till's note window for one line of the order.
export function LineNoteDialog({ name, note, onSave, onClose }: { name: string; note: string; onSave: (note: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(note);
  const tooLong = value.length > NOTE_MAX;
  const submit = (e: FormEvent) => { e.preventDefault(); if (!tooLong) { onSave(value.trim()); onClose(); } };
  return <Dialog title={`Note for ${name}`} onClose={onClose}>
    <form className="line-note" onSubmit={submit}>
      <QuickNotes value={value} onChange={setValue} />
      <p className={`hint ${tooLong ? 'status error' : ''}`}>{value ? `Kitchen sees: “${value}”` : 'No note: the kitchen makes it the usual way.'}{tooLong ? ` · too long (${NOTE_MAX} characters at most)` : ''}</p>
      <div className="sheet-actions">
        {note && <button type="button" className="btn ghost" onClick={() => { onSave(''); onClose(); }}>Remove note</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={tooLong}>Save note</button>
      </div>
    </form>
  </Dialog>;
}
