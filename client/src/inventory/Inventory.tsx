import { useCallback, useEffect, useState, FormEvent } from 'react';
import { api } from '../shared/api';
import { peso, time } from '../shared/format';
import { useCodeRequired, useLive, useSession, useToast } from '../shared/hooks';
import type { InventoryItem } from '../shared/types';
import { Dialog, StaffCode, Toast, TopBar } from '../shared/ui';

// Sections in the order of the kitchen's paper sheets; within one, items keep the sheet's row order.
export const SECTIONS = ['Spices & market', 'Vegetables', 'Groceries', 'Supplies', 'Beef', 'Chicken', 'Steak', 'Seafood', 'Burgers', 'Pica-pica'];
// The bought ingredients and supplies, the sheets before Beef. The owner's admin page leaves them out; the
// inventory screen still has them for the kitchen's counts.
export const RAW_SECTIONS = SECTIONS.slice(0, SECTIONS.indexOf('Beef'));
export const bySheet = (items: InventoryItem[]) => {
  const groups = new Map<string, InventoryItem[]>();
  for (const i of items) { const s = i.section || 'Other'; if (!groups.has(s)) groups.set(s, []); groups.get(s)!.push(i); }
  const rank = (s: string) => { const n = SECTIONS.indexOf(s); return n < 0 ? SECTIONS.length : n; };
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([section, list]) => [section, list.sort((a, b) => a.id - b.id)] as const);
};
const KINDS = { ingredient: [['count', 'Count', 'How much is there now'], ['received', 'Received', 'A delivery came in'], ['used', 'Used / wasted', 'Take some out']], portion: [['count', 'Count', 'How many are there now'], ['prepped', 'Prepped', 'Made more; takes out their ingredients'], ['used', 'Used / wasted', 'Take some out']] } as const;

// The inspector's screen: the stock board, updated live.
export function Inventory() {
  const {user,ready}=useSession('inventory'),{toast,notify}=useToast(),[tick,setTick]=useState(0);
  const event=useCallback((e:string)=>{if(e==='inventory.updated')setTick(n=>n+1);},[]);const state=useLive(event);
  if(!ready)return <div className="loading">Loading inventory…</div>;
  return <div><TopBar subtitle="Inventory inspector" state={state} user={user}/><StockBoard notify={notify} refresh={tick}/><Toast text={toast}/></div>;
}

// The stock list and each item's edit window: on the inspector's screen, and on the till behind the cashier's
// code. `staffCode` is the code the till already checked; every change is signed with it. On the inspector's
// screen each change asks for the inspector's code instead (once inspectors have codes).
export function StockBoard({ notify, refresh, staffCode }: { notify: (message: string) => void; refresh?: number; staffCode?: string }) {
  const [items,setItems]=useState<InventoryItem[]>([]),[query,setQuery]=useState(''),[editing,setEditing]=useState<InventoryItem|null>(null);
  const needCode=useCodeRequired()&&staffCode===undefined,[code,setCode]=useState(''),signed=staffCode!==undefined?{staffCode}:needCode?{staffCode:code}:{};
  const load=useCallback(()=>api<InventoryItem[]>('/api/inventory').then(setItems).catch(()=>{}),[]);useEffect(()=>{window.addEventListener('dining.business',load);return()=>window.removeEventListener('dining.business',load);},[load]);useEffect(()=>{void load();},[load,refresh]);
  const shown=bySheet(items.filter(i=>`${i.name} ${i.section??''}`.toLowerCase().includes(query.toLowerCase())));
  // The inspector records a count, delivery, prep or use, and/or changes the level the item is reordered at
  // (dropping below it alerts the owner). The stock change goes first: it checks the item hasn't changed meanwhile.
  async function updateStock(e:FormEvent<HTMLFormElement>){e.preventDefault();if(!editing)return;const f=new FormData(e.currentTarget),amount=String(f.get('amount')??'').trim(),threshold=Number(f.get('threshold'));
    if(!amount&&threshold===editing.threshold)return notify('Enter an amount, or a new reorder level');
    if(needCode&&code.length<4)return notify('Enter your staff code');
    try{if(amount)await api(`/api/inventory/${editing.id}/stock`,{method:'POST',body:{expectedVersion:editing.version,kind:f.get('kind'),amount:Number(amount),note:f.get('note'),...signed}});
      if(threshold!==editing.threshold)await api(`/api/inventory/${editing.id}`,{method:'PATCH',body:{threshold,...signed}});
      setEditing(null);setCode('');notify(amount?'Stock updated':'Reorder level saved');void load();}catch(e){notify((e as Error).message);}}
  return <><main className="stock"><div className="stock-tools"><input className="search" type="search" placeholder="Find an item" value={query} onChange={e=>setQuery(e.target.value)}/></div><p className="hint">Tap an item to count it, add a delivery, record portions prepped, take out what was used or thrown away, or change the level it’s reordered at. New items are added by the owner. Selling a dish takes its portions out by itself. Low stock is added to the owner’s buying list.</p>{shown.map(([section,list])=><section className="stock-section" key={section}><h2>{section} <small>{list.length}</small></h2><div className="stock-list">{list.map(i=><button className={`stock-item ${i.low?'low':''}`} key={i.id} onClick={()=>setEditing(i)}><span className="si-name">{i.name}</span><span className="si-qty">{peso(i.quantity)} <small>{i.unit}</small></span><span className="si-meta">{i.low&&<span className="pill void">Low · reorder</span>} {i.used_in?.length?`For ${i.used_in.join(', ')}`:`reorder below ${peso(i.threshold)} ${i.unit}`}</span></button>)}</div></section>)}{!shown.length&&<p className="empty">No stock items match.</p>}</main>{editing&&<Dialog title={editing.name} onClose={()=>setEditing(null)}><p className="hint">Recorded: {peso(editing.quantity)} {editing.unit} · reorder below {peso(editing.threshold)} {editing.unit} · last by {editing.updated_by} {time(editing.updated_at)}</p><p className="stock-uses">{editing.used_in?.length?<>Used in: {editing.used_in.join(', ')}</>:'Not linked to a dish yet.'}{editing.kind==='portion'&&<><br/>Prepping takes out: {editing.prep_uses?.length?editing.prep_uses.join(', '):'nothing linked yet'}</>}</p><form onSubmit={updateStock}><div className="stock-kinds">{KINDS[editing.kind==='portion'?'portion':'ingredient'].map(([v,l,d])=><label key={v}><input type="radio" name="kind" value={v} defaultChecked={v==='count'}/><span>{l}<small>{d}</small></span></label>)}</div><label>Amount<input name="amount" inputMode="decimal"/></label><p className="hint">Unit: {editing.unit}. Leave it empty to only change the reorder level.</p><label>Reorder when below<input name="threshold" type="number" min="0" step="0.001" required defaultValue={editing.threshold}/></label><p className="hint">When the stock drops below this level, the owner is alerted and it goes on the buying list.</p><label>Note (optional)<input name="note" maxLength={140}/></label>{needCode&&<StaffCode value={code} onChange={setCode}/>}<div className="sheet-actions"><button type="button" className="btn ghost" onClick={()=>setEditing(null)}>Cancel</button><button className="btn primary">Save</button></div></form></Dialog>}</>;
}
