import { DiningHistory, DiningKitchen } from '../dining';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../shared/api';
import { time } from '../shared/format';
import { useLive, useSession } from '../shared/hooks';
import { chime } from '../shared/sound';
import { STORE, STORE_NAME } from '../shared/store';
import type { Line, Order } from '../shared/types';
import { Dialog, Logo, TopBar } from '../shared/ui';
import { KitchenPrintBanner, KitchenPrinterSettings, useKitchenPrinting, type KitchenSlip } from './KitchenPrinting';

// "12 min", "1 h 20 min", "2 d": short enough to stay on one line of the ticket.
const waited = (minutes: number) => minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${Math.floor(minutes / 1440)} d`;

const itemState = (i: Line) => i.kitchen_ready_at ? 'ready' : i.kitchen_started_at ? 'cooking' : 'waiting';
// The kitchen cooks the food; the barista makes the drinks, coffee and desserts. Each screen shows only its own items.
export type Station = 'kitchen' | 'barista';
const NAMES = { kitchen: { title: 'Kitchen', making: 'Cooking', mark: '🔥' }, barista: { title: 'Barista', making: 'Making', mark: '☕' } } as const;
const madeAt = (station: Station) => (i: Line) => i.sends_to_kitchen !== 0 && (i.station ?? 'kitchen') === station;
// A ticket stays on a station's screen while something on it is still to be made there.
const openAt = (station: Station) => (o: Order) => ['new', 'preparing'].includes(o.kitchen_status) && o.items.some(i => madeAt(station)(i) && i.qty > 0 && !i.kitchen_ready_at);

// What the station's printer prints for a counter order, and for a table's order (from the Unpaid tabs).
// A changed order prints again only when what this station makes changed: a new drink doesn't reprint the
// kitchen's slip. The key holds a short fingerprint of the station's part of the order.
const fingerprint = (text: string) => { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const keyed = (base: string, slip: Omit<KitchenSlip, 'key'>): KitchenSlip => ({ ...slip, key: `${base}:${fingerprint(JSON.stringify([slip.banner === 'CANCELLED', slip.items]))}` });
const counterSlip = (o: Order, station: Station): KitchenSlip => keyed(`order:${o.id}`, { prep: station, label: String(o.receipt_label ?? o.receipt_no), table_name: o.table_name ?? null, guests: o.guests ?? null, created_at: o.created_at, banner: o.edit_count ? 'ORDER CHANGED' : undefined, items: o.items.filter(madeAt(station)).map(i => ({ qty: i.qty, name: i.name, note: i.note })) });
const tableSlip = (t: any, station: Station): KitchenSlip => keyed(`table:${t.submission.id}`, { prep: station, label: '', table_name: t.title, guests: t.visit.guests, created_at: t.time, banner: t.status === 'cancelled' ? 'CANCELLED' : t.submission.change_seq ? 'ORDER CHANGED' : undefined, items: t.lines.filter((l: any) => l.sends_to_kitchen !== 0).map((l: any) => ({ qty: l.qty, name: l.name, note: l.note })) });

// Inside the owner's all-screens view the display starts by itself: no tap-to-start cover, fullscreen or wake lock.
// It doesn't print there either; only the station's own tablet prints, from the moment it opens (before Start is tapped).
const printsHere = window.self === window.top;
export function Kitchen({ station = 'kitchen' }: { station?: Station }) {
  const names=NAMES[station],mine=madeAt(station),open=openAt(station),ITEM_LABEL={waiting:'Waiting · tap to start',cooking:`${names.making} · tap when ready`,ready:'Ready'} as const;
  const {user,ready}=useSession(station),[tickets,setTickets]=useState<Order[]>([]),[started,setStarted]=useState(window.self!==window.top),[offline,setOffline]=useState(false),[now,setNow]=useState(Date.now()),[tableTickets,setTableTickets]=useState(0),[historyOpen,setHistoryOpen]=useState(false),[tableSlips,setTableSlips]=useState<KitchenSlip[]>([]),[printerOpen,setPrinterOpen]=useState(false);
  const load=useCallback(()=>api<Order[]>(`/api/kitchen/tickets?station=${station}`).then(setTickets).catch(()=>{}),[station]);
  const event=useCallback((name:string,o:any)=>{const put=(v:Order[])=>[...v.filter(x=>x.id!==o.id),o].sort((a,b)=>a.id-b.id);if(name==='order.created'&&open(o)){setTickets(put);if(started)chime();}if(name==='order.updated'||name==='ticket.updated'){setTickets(v=>o.status==='voided'||!open(o)?v.filter(x=>x.id!==o.id):put(v));if(name==='order.updated'&&started&&open(o))chime();}},[started,station]);
  const onTableTickets=useCallback((list:any[])=>setTableSlips(list.filter(t=>t.submission).map(t=>tableSlip(t,station))),[station]);
  const printing=useKitchenPrinting([...tickets.filter(open).map(o=>counterSlip(o,station)),...tableSlips].filter(s=>s.items?.length),printsHere,station);
  const state=useLive(event);useEffect(()=>{void load();const id=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(id);},[load]);
  // Orders taken while this tablet was offline come in when it reconnects (and print then).
  useEffect(()=>{if(state==='Live')void load();},[state,load]);
  async function begin(){setStarted(true);chime();void printing.wake();try{await document.documentElement.requestFullscreen?.();}catch{}try{await navigator.wakeLock?.request('screen');}catch{}}
  async function update(o:Order,next:string){try{await api(`/api/orders/${o.id}/kitchen`,{method:'PATCH',body:{status:next,station}});await load();}catch(e){alert((e as Error).message);}}
  // Each tap moves an item along: waiting → cooking → ready → (tapped by mistake) waiting.
  async function stepItem(o:Order,i:Line){const now=itemState(i),next=now==='waiting'?'cooking':now==='cooking'?'ready':'waiting';try{await api(`/api/orders/${o.id}/items/${i.id}/kitchen`,{method:'PATCH',body:{state:next}});await load();}catch(e){alert((e as Error).message);}}
  if(!ready)return <div className="loading">Opening {names.title.toLowerCase()}…</div>;
  return <div className="kitchen-page"><TopBar title={STORE_NAME} subtitle={`${names.title} · ${tickets.filter(open).length+tableTickets} open`} state={state} user={user}><button className="btn ghost small" onClick={()=>setPrinterOpen(true)}>{printing.settings.on?'Printer · on':'Printer'}</button>{STORE==='ambiente'&&<button className="btn ghost small" onClick={()=>setHistoryOpen(true)}>Undo</button>}</TopBar>{state==='Offline'&&<div className="offline-banner">Connection lost — new orders will not appear until it’s back</div>}<KitchenPrintBanner printing={printing} active={printsHere}/>{STORE==='ambiente'&&<DiningKitchen role={station} station={station} started={started} chime={()=>chime()} includeCounter={false} onCount={setTableTickets} onTickets={onTableTickets}/>}<main className="tickets">{tickets.filter(open).map(o=>{const age=Math.max(0,Math.floor((now-new Date(o.created_at).getTime())/60000)),kitchenItems=o.items.filter(mine),begun=kitchenItems.some(i=>itemState(i)!=='waiting'),next=begun?'ready':'preparing',readyCount=kitchenItems.filter(i=>i.kitchen_ready_at).length,cookingCount=kitchenItems.filter(i=>itemState(i)==='cooking').length;return <article className={`ticket ${begun?'preparing':'new'} ${age>=10?'late':''}`} key={o.id}><div className="ticket-head"><h2>#{o.receipt_label??o.receipt_no} <span className="ticket-table">{o.table_name??'Takeout'}</span></h2><span className="ticket-age">{waited(age)} · {time(o.created_at)}</span></div><div className="ticket-state">{begun?'Preparing':'New'}{cookingCount>0&&` · ${cookingCount} ${names.making.toLowerCase()}`}{readyCount>0&&` · ${readyCount} of ${kitchenItems.length} ready`} {o.edit_count>0&&<span className="pill">Edited</span>}</div><ul>{kitchenItems.map((i,n)=>{const st=itemState(i);return <li key={i.id??n}><button type="button" className={`ticket-item ${st}`} aria-label={`${i.qty} ${i.name}: ${ITEM_LABEL[st]}`} disabled={!i.id} onClick={()=>void stepItem(o,i)}><span className="tick" aria-hidden="true">{st==='ready'?'✓':st==='cooking'?names.mark:''}</span><span className="ti-body"><span><b className="q">{i.qty}×</b><span className="ti-name">{i.name}</span></span>{i.note&&<span className="ti-note">{i.note}</span>}<small className="ti-state">{ITEM_LABEL[st]}</small></span></button></li>;})}</ul><button className={`btn ${next==='ready'?'primary':''}`} onClick={()=>void update(o,next)}>{next==='ready'?'All done':'Start all'}</button></article>})}{tickets.filter(open).length===0&&tableTickets===0&&<div className="kitchen-empty"><Logo large/><p>No open tickets</p></div>}</main>{printerOpen&&<KitchenPrinterSettings printing={printing} onClose={()=>setPrinterOpen(false)}/>}{historyOpen&&<Dialog title="Undo a past action" onClose={()=>setHistoryOpen(false)}><DiningHistory role={station} open/></Dialog>}{!started&&<button className="start-overlay" onClick={()=>void begin()}><Logo large/><strong>Tap to start {names.title.toLowerCase()} display</strong><span>Turns on the new-order chime and keeps the screen awake</span></button>}</div>;
}
