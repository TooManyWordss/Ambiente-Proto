import { useState, FormEvent } from 'react';
import { api } from '../shared/api';
import type { DiningTable } from '../shared/types';
import { FloorMap } from './FloorMap';
import { setBalcony, STANDARD_BALCONY, useBalcony, type Box } from './floor';
import { STORE } from '../shared/store';

// Owner: drag tables into place on the map, rename them, change seats, add or remove.
export function TablesAdmin({tables,refresh,notify}:{tables:DiningTable[];refresh:()=>void;notify:(m:string)=>void}){
  const [selected,setSelected]=useState<number|null>(null);const t=tables.find(x=>x.id===selected);
  // The balcony's size and place: tried out on the map while sliding, saved for every screen with Save.
  const saved=useBalcony(tables),[balcony,setDraft]=useState<Box|null>(null),shown=balcony??saved;
  const slide=(k:keyof Box,v:number)=>{const b={...shown,[k]:v};b.x=Math.min(b.x,1266-b.w);b.y=Math.min(b.y,704-b.h);setDraft(b);};
  async function saveBalcony(b:Box){try{const r=await api<{balcony:Box}>('/api/admin/floor',{method:'PUT',body:{balcony:b}});setBalcony(r.balcony);setDraft(null);notify('Balcony saved');}catch(e){notify((e as Error).message);}}
  const patch=async(id:number,body:any)=>{try{await api(`/api/admin/tables/${id}`,{method:'PATCH',body});refresh();}catch(e){notify((e as Error).message);}};
  async function add(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget,f=new FormData(form);try{const created=await api<DiningTable>('/api/admin/tables',{method:'POST',body:{name:f.get('name'),seats:Number(f.get('seats'))}});form.reset();setSelected(created.id);notify(`${created.name} added at the bottom left of the map. Drag it into place.`);refresh();}catch(err){notify((err as Error).message);}}
  return <section className="panel"><h2>Tables <span className="pill">{tables.filter(x=>x.party).length} of {tables.length} occupied</span></h2><p className="hint">Drag a table to move it; it snaps into line with the others. Tap one to rename it or change its seats.</p>
    <FloorMap tables={tables} selectedId={selected} onPick={x=>setSelected(x.id)} onMove={(x,nx,ny)=>void patch(x.id,{x:nx,y:ny})} balcony={balcony}/>
    {STORE==='ambiente'&&<details className="balcony-edit"><summary>Balcony size</summary><p className="hint">Slide to make the balcony wider, longer or move it; the map shows it as you go. Save to show it on every screen.</p>
      {([['w','Width',60,1252],['h','Length',60,628],['x','From the left',14,1266-shown.w],['y','From the top',76,704-shown.h]] as const).map(([k,label,min,max])=><label key={k}>{label} <span className="muted">{shown[k]}</span><input type="range" min={min} max={max} value={shown[k]} onChange={e=>slide(k,Number(e.target.value))}/></label>)}
      <div className="sheet-actions"><button type="button" className="btn ghost" onClick={()=>setDraft(STANDARD_BALCONY)}>Standard size</button>{balcony&&<button type="button" className="btn" onClick={()=>setDraft(null)}>Cancel</button>}<button type="button" className="btn primary" disabled={!balcony} onClick={()=>balcony&&void saveBalcony(balcony)}>Save balcony</button></div></details>}
    {t&&<form className="staff-form" key={t.id} onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void patch(t.id,{name:f.get('name'),seats:Number(f.get('seats'))});}}><input name="name" defaultValue={t.name} aria-label="Table name" maxLength={30}/><input name="seats" type="number" min={1} max={50} defaultValue={t.seats} aria-label="Seats"/><span className="edit-buttons"><button className="btn primary">Save</button><button type="button" className="btn danger-outline" onClick={async()=>{if(!confirm(`Remove ${t.name}?`))return;try{await api(`/api/admin/tables/${t.id}`,{method:'DELETE'});setSelected(null);refresh();}catch(err){notify((err as Error).message);}}}>Remove</button></span></form>}
    <form className="staff-form" onSubmit={add}><input name="name" required maxLength={30} placeholder="New table name"/><input name="seats" type="number" min={1} max={50} defaultValue={4} aria-label="Seats"/><button className="btn">Add table</button></form>
  </section>;
}
