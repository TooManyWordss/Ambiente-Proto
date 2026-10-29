import React, { useState } from 'react';
import { discountLines, groupShare, totals } from '../../dining-domain.js';
import { storageKey } from './shared/store';

type Mode = 'PWD' | 'Senior' | 'PWD & Senior' | 'Other';
const MODES: [Mode, string][] = [['Senior', 'Senior citizen'], ['PWD', 'PWD'], ['PWD & Senior', 'PWD & Senior'], ['Other', 'Other discount']];
const money = (n = 0) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(n / 100);
// The rates and VAT choice last used on this device, so the cashier sets them once.
const remembered = (): { pwd: number; senior: number; vat: boolean } => { try { return { pwd: 2000, senior: 2000, vat: true, ...JSON.parse(localStorage.getItem(storageKey('groupDiscount')) ?? '{}') }; } catch { return { pwd: 2000, senior: 2000, vat: true }; } };
const remember = (value: { pwd: number; senior: number; vat: boolean }) => { try { localStorage.setItem(storageKey('groupDiscount'), JSON.stringify(value)); } catch { /* not remembered */ } };

function Count({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (n: number) => void }) {
  return <div className="gd-count"><span>{label}</span><span className="qty"><button type="button" aria-label={`One fewer: ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button><span aria-live="polite">{value}</span><button type="button" aria-label={`One more: ${label}`} disabled={value >= 999} onClick={() => onChange(value + 1)}>+</button></span></div>;
}

// Seniors and PWDs (Philippine rules, group share), or another discount with a reason.
// `guests` is how many are eating, `subtotal` and `taxRate` show what the discount comes to.
export default function DiscountEditor({ discount, onSave, onClose, busy = false, guests, subtotal = 0, taxRate = 0 }: { discount: any; onSave: (discount: any) => void; onClose: () => void; busy?: boolean; guests?: number | null; subtotal?: number; taxRate?: number }) {
  const group = discount?.kind === 'group' ? discount : null, saved = remembered();
  const [mode, setMode] = useState<Mode>(group ? group.label : discount ? 'Other' : 'Senior');
  const [pwd, setPwd] = useState<number>(group?.pwd || 1), [senior, setSenior] = useState<number>(group?.senior || 1);
  const [diners, setDiners] = useState<number>(group?.diners ?? Math.max(guests ?? 1, 1));
  const [pwdRate, setPwdRate] = useState(String((group?.pwd_rate ?? saved.pwd) / 100)), [seniorRate, setSeniorRate] = useState(String((group?.senior_rate ?? saved.senior) / 100));
  const [vat, setVat] = useState<boolean>(group ? group.vat_exempt : saved.vat);
  const [ids, setIds] = useState<Record<string, string>>(() => { const by: Record<string, string> = {}, n: Record<string, number> = {}; for (const i of group?.ids ?? []) { by[`${i.type}:${n[i.type] ?? 0}`] = i.id; n[i.type] = (n[i.type] ?? 0) + 1; } return by; });

  if (mode === 'Other') return <form className="dining-form discount-form" onSubmit={e => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    onSave({ kind: f.get('kind'), value: Math.round(Number(f.get('amount')) * 100), label: '', reason: f.get('reason') });
  }}>
    <Modes mode={mode} setMode={setMode}/>
    <p className="hint">For promos and owner concessions. Seniors and PWDs use their own tabs.</p>
    <label>Type<select name="kind" defaultValue={discount?.kind === 'fixed' ? 'fixed' : 'percent'}><option value="percent">Percentage</option><option value="fixed">Fixed pesos</option></select></label>
    <label>Amount / percent<input name="amount" type="number" min="0" step="0.01" defaultValue={group ? 0 : (discount?.value ?? 0) / 100} required/></label>
    <label>Reason<input name="reason" maxLength={200} defaultValue={group ? '' : discount?.reason ?? ''} required/></label>
    <Actions busy={busy} disabled={false} onSave={onSave} onClose={onClose}/>
  </form>;

  const counts = { pwd: mode === 'Senior' ? 0 : pwd, senior: mode === 'PWD' ? 0 : senior };
  const people = [...Array.from({ length: counts.pwd }, (_, n) => ({ type: 'PWD', n })), ...Array.from({ length: counts.senior }, (_, n) => ({ type: 'Senior', n }))];
  const who = [counts.pwd && `${counts.pwd} PWD`, counts.senior && `${counts.senior} senior${counts.senior === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  const draft = { kind: 'group', label: mode, diners, pwd: counts.pwd, senior: counts.senior, pwd_rate: Math.round(Number(pwdRate) * 100), senior_rate: Math.round(Number(seniorRate) * 100), vat_exempt: vat, ids: people.map(p => ({ type: p.type, id: (ids[`${p.type}:${p.n}`] ?? '').trim() })), reason: `Group share: ${who} of ${diners}` };
  let share: ReturnType<typeof groupShare> | null = null, bill: ReturnType<typeof totals> | null = null, problem = '';
  try { share = groupShare(subtotal, draft, taxRate); bill = totals({ discount: draft, submissions: [{ lines: [{ qty: 1, unit_price_cents: subtotal }] }] }, taxRate); } catch (e) { problem = (e as Error).message; }
  const rate = (label: string, value: string, set: (v: string) => void) => <label className="gd-rate">{label}<span><input type="number" inputMode="decimal" min="0" max="100" step="0.01" value={value} onChange={e => set(e.target.value)} required/>%</span></label>;
  const fix = (n: number) => Math.min(999, Math.max(1, n));

  return <form className="dining-form discount-form" onSubmit={e => { e.preventDefault(); if (problem) return; remember({ pwd: draft.pwd_rate, senior: draft.senior_rate, vat }); onSave(draft); }}>
    <Modes mode={mode} setMode={setMode}/>
    <p className="hint">Group share: the bill is split equally among everyone eating, and each {mode === 'PWD' ? 'PWD' : mode === 'Senior' ? 'senior' : 'senior and PWD'} with an ID gets the discount on their share.</p>
    <div className="gd-counts">
      <Count label="Diners in the group" value={diners} min={Math.max(1, counts.pwd + counts.senior)} onChange={n => setDiners(fix(n))}/>
      {mode !== 'Senior' && <Count label="PWDs with ID" value={pwd} min={1} onChange={n => { setPwd(fix(n)); if (n + counts.senior > diners) setDiners(fix(n + counts.senior)); }}/>}
      {mode !== 'PWD' && <Count label="Seniors with ID" value={senior} min={1} onChange={n => { setSenior(fix(n)); if (n + counts.pwd > diners) setDiners(fix(n + counts.pwd)); }}/>}
    </div>
    <div className="gd-rates">
      {mode !== 'Senior' && rate('PWD discount rate', pwdRate, setPwdRate)}
      {mode !== 'PWD' && rate('Senior discount rate', seniorRate, setSeniorRate)}
    </div>
    <label className="check"><input type="checkbox" checked={vat} onChange={e => setVat(e.target.checked)}/> {taxRate ? 'Their share is VAT-exempt (no tax on it)' : 'Remove 12% VAT from their share first (VAT-registered café)'}</label>
    <fieldset className="gd-ids"><legend>ID numbers</legend>
      {people.map(p => <label key={`${p.type}:${p.n}`}>{p.type === 'PWD' ? 'PWD ID' : 'Senior ID (OSCA)'}{(p.type === 'PWD' ? counts.pwd : counts.senior) > 1 ? ` ${p.n + 1}` : ''}<input maxLength={40} autoComplete="off" value={ids[`${p.type}:${p.n}`] ?? ''} onChange={e => setIds({ ...ids, [`${p.type}:${p.n}`]: e.target.value })} required/></label>)}
    </fieldset>
    {share && bill ? <dl className="totals gd-preview">
      <dt>Each diner’s share</dt><dd>{money(Math.round(subtotal / diners))}</dd>
      {discountLines(subtotal, draft, taxRate).map(l => <React.Fragment key={l.label}><dt>{l.label}</dt><dd>−{money(l.cents)}</dd></React.Fragment>)}
      <dt className="grand">Bill after discount</dt><dd className="grand">{money(bill.total_cents)}</dd>
    </dl> : <p className="status error" role="status">{problem}</p>}
    <Actions busy={busy} disabled={!!problem} onSave={onSave} onClose={onClose}/>
  </form>;
}

function Modes({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return <div className="gd-modes" role="group" aria-label="Discount type">{MODES.map(([m, label]) => <button type="button" key={m} className={`chip ${mode === m ? 'active' : ''}`} aria-pressed={mode === m} onClick={() => setMode(m)}>{label}</button>)}</div>;
}
function Actions({ busy, disabled, onSave, onClose }: { busy: boolean; disabled: boolean; onSave: (d: any) => void; onClose: () => void }) {
  return <div className="dining-actions"><button className="btn primary" disabled={busy || disabled}>Apply discount</button><button type="button" className="btn" disabled={busy} onClick={() => onSave(null)}>Remove discount</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>;
}
