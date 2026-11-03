import { useState } from 'react';
import { byWeight, perLabel, weighedLine } from '../../../weighed.js';
import { WeighDialog } from '../pos/WeighDialog';
import { api } from '../shared/api';
import { money, time } from '../shared/format';
import type { MenuItem, Order } from '../shared/types';
import { Dialog } from '../shared/ui';

// Owner: change any receipt's items. Items already on it keep their sold price; added ones use today's price.
// Lines are told apart by item and, for a steak sold by weight, its weight ("12@85").
const keyOf=(id:number,grams?:number|null)=>grams!=null?`${id}@${grams}`:String(id);
export function ReceiptEditor({order,menu,onClose,onSaved,notify}:{order:Order;menu:MenuItem[];onClose:()=>void;onSaved:()=>void;notify:(m:string)=>void}){
  const [qty,setQty]=useState<Record<string,number>>(()=>{const q:Record<string,number>={};for(const i of order.items){const k=keyOf(i.menu_item_id,i.grams);q[k]=(q[k]??0)+i.qty;}return q;}),[adding,setAdding]=useState(''),[weighing,setWeighing]=useState<MenuItem|null>(null),[saving,setSaving]=useState(false);
  const lineOf=(key:string)=>{const [id,g]=key.split('@'),grams=g?Number(g):null,sold=order.items.find(i=>keyOf(i.menu_item_id,i.grams)===key),item=menu.find(m=>m.id===Number(id)),weighed=item&&grams!=null?weighedLine(item,grams):null;return {key,id:Number(id),grams,price:sold?.unit_price_cents??weighed?.unit_price_cents??item?.price_cents??0,name:sold?.name??weighed?.name??item?.name??`Item ${id}`};};
  const lines=Object.entries(qty).filter(([,n])=>n>0).map(([key,n])=>({...lineOf(key),qty:n}));
  const subtotal=lines.reduce((n,l)=>n+l.price*l.qty,0),oldSubtotal=order.subtotal_cents??order.total_cents;
  const change=(key:string,d:number)=>setQty(q=>({...q,[key]:Math.max(0,Math.min(99,(q[key]??0)+d))}));
  async function save(){if(!lines.length)return notify('An order needs at least one item. Void it instead.');setSaving(true);try{const r=await api<any>(`/api/orders/${order.id}`,{method:'PATCH',body:{expectedVersion:order.version,items:lines.map(l=>({menuItemId:l.id,qty:l.qty,...(l.grams!=null?{grams:l.grams}:{})}))}});notify(r.differenceCents>0?`Order updated · collect ${money(r.differenceCents)}`:r.differenceCents<0?`Order updated · give back ${money(-r.differenceCents)}`:'Order updated · total unchanged');onSaved();onClose();}catch(e){notify((e as Error).message);}finally{setSaving(false);}}
  return <Dialog title={`Edit order #${order.receipt_label??order.receipt_no}`} onClose={onClose}><p className="hint">Was {money(order.total_cents)} · {time(order.created_at)}. Stock used by the menu items is adjusted to match.</p>
    <ul className="line-editor">{lines.map(l=><li key={l.key}><span>{l.name}</span><span className="qty"><button type="button" aria-label={`One less ${l.name}`} onClick={()=>change(l.key,-1)}>−</button><span>{l.qty}</span><button type="button" aria-label={`One more ${l.name}`} onClick={()=>change(l.key,1)}>+</button></span><span className="num">{money(l.price*l.qty)}</span></li>)}{!lines.length&&<li className="hint">No items left. Add one, or close and void the order.</li>}</ul>
    <div className="add-row"><select aria-label="Add a menu item" value={adding} onChange={e=>setAdding(e.target.value)}><option value="">Add an item…</option>{menu.filter(m=>m.available).map(m=><option key={m.id} value={m.id}>{m.name} · {money(m.price_cents)}{byWeight(m)?` / ${perLabel(m)}`:''}</option>)}</select><button type="button" className="btn" disabled={!adding} onClick={()=>{const item=menu.find(m=>m.id===Number(adding));if(item&&byWeight(item))setWeighing(item);else change(adding,1);setAdding('');}}>Add</button></div>
    {weighing&&<WeighDialog item={weighing} onAdd={grams=>change(keyOf(weighing.id,grams),1)} onClose={()=>setWeighing(null)}/>}
    <dl className="totals"><dt className="grand">New subtotal</dt><dd className="grand">{money(subtotal)}</dd><dt>Difference</dt><dd>{subtotal===oldSubtotal?'—':`${subtotal>oldSubtotal?'collect':'give back'} ${money(Math.abs(subtotal-oldSubtotal))}`}</dd></dl>
    <div className="sheet-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={saving||!lines.length} onClick={()=>void save()}>{saving?'Saving…':'Save changes'}</button></div></Dialog>;
}
