import { useState } from 'react';
import { createPortal } from 'react-dom';
import { diningRequest } from '../dining-store';
import { api } from '../shared/api';
import { money, shiftDate, todayDate } from '../shared/format';
import { STORE, STORE_NAME } from '../shared/store';
import { downloadWorkbook, type Cell, type Sheet } from '../shared/xlsx';

type Line = { name: string; category: string; qty: number; unit_price_cents: number; note: string };
type Row = { order: string; status: 'paid' | 'open' | 'voided'; station: string; date: string; day: string; hour: string; time: string; table: string; guests: number | null; customer: string; items: Line[]; item_count: number; subtotal_cents: number; discount_cents: number; discount: string; tax_cents: number; total_cents: number; cash_cents: number | null; change_cents: number | null; paid_by: '' | 'Cash' | 'Card'; paid_time: string; staff: string; billed_by: string; edits: number; void_reason: string };
type Totals = { orders: number; guests: number; items: number; gross_cents: number; net_cents: number; discount_cents: number; tax_cents: number };
export type SalesReportData = { from: string; to: string; summary: Totals & { average_order_cents: number; cash_cents: number; card_cents: number; voided: number; voided_cents: number; unpaid: number; edited: number }; byDay: (Totals & { date: string; day: string })[]; byHour: (Totals & { hour: string })[]; bestSellers: { name: string; category: string; qty: number; revenue_cents: number }[]; orders: Row[] };
type Average = { count: number; average_minutes: number | null };
type Service = { paid_visits: number; guests_served: number; net_sales_cents: number; average_spend_cents: number | null } & Record<string, Average | number | null>;

const STATUS = { paid: 'Paid', open: 'Unpaid (on a table’s tab)', voided: 'Voided' } as const;
const SERVICE_TIMES = [['preparation', 'Kitchen preparation'], ['arrival_to_order', 'Arrival to first order'], ['eating', 'Eating duration'], ['bill_to_payment', 'Bill request to payment'], ['occupancy', 'Table occupancy']] as const;
const peso = (cents: number | null | undefined): Cell => cents == null ? '' : { peso: cents / 100 };
const ordered = (o: Row) => o.items.map((i) => `${i.qty} × ${i.name}${i.note ? ` (${i.note})` : ''}`).join(', ');
const minutes = (a?: Average) => a?.average_minutes == null ? '' : Math.round(a.average_minutes * 10) / 10;

// The KPI figures and every sale in the range as spreadsheet sheets: Summary, Orders, Items sold, By day, By hour
// and Best sellers. Times are Asia/Manila.
export function reportSheets(r: SalesReportData, service: Service | null): Sheet[] {
  const s = r.summary;
  return [
    { name: 'Summary', rows: [
      ['Figure', 'Value', 'Notes'],
      ['Store', STORE_NAME], ['From', r.from], ['Through', r.to],
      ['Net sales', peso(s.net_cents), 'Paid orders, after discounts, before tax'],
      ['Gross sales', peso(s.gross_cents), 'What customers paid, tax included'],
      ['Paid orders', s.orders], ['Average order', peso(s.average_order_cents), 'Gross sales ÷ paid orders'],
      ['Guests', s.guests, 'From table orders; counter orders have no guest count'], ['Items sold', s.items],
      ['Paid in cash', peso(s.cash_cents)], ['Paid by card', peso(s.card_cents)],
      ['Discounts', peso(s.discount_cents)], ['Tax', peso(s.tax_cents)],
      ['Voided orders', s.voided], ['Voided amount', peso(s.voided_cents), 'Not counted in sales'],
      ['Unpaid table orders', s.unpaid, 'Still on a table’s tab; counted when paid'], ['Edited orders', s.edited],
      ...(service ? [[], ['Table service (KPI dashboard)'] as Cell[],
        ['Paid visits', service.paid_visits], ['Guests served', service.guests_served], ['Table net sales', peso(service.net_sales_cents)],
        ['Spend per guest', peso(service.average_spend_cents)],
        ...SERVICE_TIMES.map(([key, label]) => [`${label} (minutes)`, minutes(service[key] as Average), `${(service[key] as Average | undefined)?.count ?? 0} complete samples`])] : []),
    ] },
    { name: 'Orders', rows: [
      ['Order #', 'Date', 'Day', 'Hour', 'Time', 'Station', 'Table', 'Guests', 'Customer', 'What they ordered', 'Items', 'Subtotal', 'Discount', 'Discount type', 'Tax', 'Total', 'Paid by', 'Cash', 'Change', 'Status', 'Paid at', 'Taken by', 'Billed out by', 'Times edited', 'Void reason'],
      ...r.orders.map((o) => [o.order, o.date, o.day, o.hour, o.time, o.station, o.table, o.guests, o.customer, ordered(o), o.item_count, peso(o.subtotal_cents), peso(o.discount_cents), o.discount, peso(o.tax_cents), peso(o.total_cents), o.paid_by, peso(o.cash_cents), peso(o.change_cents), STATUS[o.status], o.paid_time, o.staff, o.billed_by, o.edits || '', o.void_reason]),
    ], widths: [9, 11, 11, 7, 7, 9, 14, 8, 9, 60] },
    { name: 'Items sold', rows: [
      ['Order #', 'Date', 'Day', 'Time', 'Table', 'Item', 'Category', 'Qty', 'Unit price', 'Line total', 'Note', 'Status'],
      ...r.orders.flatMap((o) => o.items.map((i) => [o.order, o.date, o.day, o.time, o.table, i.name, i.category, i.qty, peso(i.unit_price_cents), peso(i.qty * i.unit_price_cents), i.note, STATUS[o.status]])),
    ] },
    { name: 'By day', rows: [['Date', 'Day', 'Paid orders', 'Guests', 'Items', 'Net sales', 'Discounts', 'Tax', 'Gross sales'], ...r.byDay.map((d) => [d.date, d.day, d.orders, d.guests, d.items, peso(d.net_cents), peso(d.discount_cents), peso(d.tax_cents), peso(d.gross_cents)])] },
    { name: 'By hour', rows: [['Hour', 'Paid orders', 'Guests', 'Items', 'Net sales', 'Gross sales'], ...r.byHour.map((h) => [h.hour, h.orders, h.guests, h.items, peso(h.net_cents), peso(h.gross_cents)])] },
    { name: 'Best sellers', rows: [['Rank', 'Item', 'Category', 'Qty sold', 'Sales'], ...r.bestSellers.map((b, i) => [i + 1, b.name, b.category, b.qty, peso(b.revenue_cents)])] },
  ];
}

// Owner: the sales of any range of days, as an Excel file or printed. Same figures either way.
export function SalesReport({ notify }: { notify: (message: string) => void }) {
  const [range, setRange] = useState({ from: shiftDate(todayDate(), -6), to: todayDate() }), [busy, setBusy] = useState(''), [printing, setPrinting] = useState<{ r: SalesReportData; service: Service | null } | null>(null);
  const load = async () => {
    const [r, service] = await Promise.all([api<SalesReportData>(`/api/admin/sales-report?from=${range.from}&to=${range.to}`),
      STORE === 'ambiente' ? diningRequest(`/metrics?from=${range.from}&to=${range.to}`).catch(() => null) as Promise<Service | null> : Promise.resolve(null)]);
    return { r, service };
  };
  const run = async (what: string, job: () => Promise<void>) => { setBusy(what); try { await job(); } catch (e) { notify((e as Error).message); } finally { setBusy(''); } };
  const excel = () => run('excel', async () => { const { r, service } = await load(); downloadWorkbook(`${STORE_NAME} sales ${r.from} to ${r.to}`, reportSheets(r, service)); notify(`Sales report saved · ${r.orders.length} orders`); });
  const print = () => run('print', async () => {
    const data = await load(); setPrinting(data); document.documentElement.classList.add('printing-report');
    const done = () => { document.documentElement.classList.remove('printing-report'); setPrinting(null); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.setTimeout(() => window.print(), 150);
  });
  const preset = (from: string, to = todayDate()) => setRange({ from, to });
  return <section className="panel sales-report"><h2>Sales report</h2>
    <p className="hint">Every order in the chosen days, with its day, hour and time, what was ordered, the total and the guests, plus the totals by day, by hour and by item and the KPI dashboard’s figures. Download it as an Excel file, or print it.</p>
    <div className="dining-actions"><button className="btn small" type="button" onClick={() => preset(todayDate())}>Today</button><button className="btn small" type="button" onClick={() => preset(shiftDate(todayDate(), -6))}>Last 7 days</button><button className="btn small" type="button" onClick={() => preset(shiftDate(todayDate(), -29))}>Last 30 days</button><button className="btn small" type="button" onClick={() => preset(`${todayDate().slice(0, 7)}-01`)}>This month</button></div>
    <div className="report-range"><label>From<input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })}/></label><label>Through<input type="date" value={range.to} min={range.from} max={todayDate()} onChange={(e) => setRange({ ...range, to: e.target.value })}/></label></div>
    <div className="sheet-actions"><button className="btn" disabled={!!busy} onClick={() => void print()}>{busy === 'print' ? 'Preparing…' : 'Print report'}</button><button className="btn primary" disabled={!!busy} onClick={() => void excel()}>{busy === 'excel' ? 'Preparing…' : 'Download Excel'}</button></div>
    {printing && createPortal(<PrintedReport {...printing}/>, document.body)}
  </section>;
}

// The report on paper: the summary, table service, the days, hours and best sellers, then every order.
function PrintedReport({ r, service }: { r: SalesReportData; service: Service | null }) {
  const s = r.summary;
  return <div className="report-print">
    <h1>{STORE_NAME} · Sales report</h1><p>{r.from === r.to ? r.from : `${r.from} to ${r.to}`} · Asia/Manila · printed {new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</p>
    <div className="rp-figures">{([['Net sales', money(s.net_cents)], ['Gross sales', money(s.gross_cents)], ['Paid orders', s.orders], ['Average order', money(s.average_order_cents)], ['Guests', s.guests], ['Items sold', s.items], ['Discounts', money(s.discount_cents)], ['Tax', money(s.tax_cents)], ['Cash', money(s.cash_cents)], ['Card', money(s.card_cents)], ['Voided', `${s.voided} · ${money(s.voided_cents)}`]] as const).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    {service && <><h2>Table service</h2><div className="rp-figures">{([['Paid visits', service.paid_visits], ['Guests served', service.guests_served], ['Spend per guest', service.average_spend_cents == null ? '—' : money(service.average_spend_cents)], ...SERVICE_TIMES.map(([key, label]) => [label, minutes(service[key] as Average) === '' ? '—' : `${minutes(service[key] as Average)} min`])] as [string, string | number][]).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></>}
    <div className="rp-columns">
      <table><caption>By day</caption><thead><tr><th>Date</th><th>Day</th><th>Orders</th><th>Guests</th><th>Gross</th></tr></thead><tbody>{r.byDay.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.day}</td><td>{d.orders}</td><td>{d.guests}</td><td>{money(d.gross_cents)}</td></tr>)}</tbody></table>
      <table><caption>By hour</caption><thead><tr><th>Hour</th><th>Orders</th><th>Gross</th></tr></thead><tbody>{r.byHour.map((h) => <tr key={h.hour}><td>{h.hour}</td><td>{h.orders}</td><td>{money(h.gross_cents)}</td></tr>)}</tbody></table>
      <table><caption>Best sellers</caption><thead><tr><th>Item</th><th>Qty</th><th>Sales</th></tr></thead><tbody>{r.bestSellers.slice(0, 15).map((b) => <tr key={b.name}><td>{b.name}</td><td>{b.qty}</td><td>{money(b.revenue_cents)}</td></tr>)}</tbody></table>
    </div>
    <table className="rp-orders"><caption>Orders ({r.orders.length})</caption><thead><tr><th>Order #</th><th>Date</th><th>Day</th><th>Time</th><th>Table</th><th>Guests</th><th>What they ordered</th><th>Total</th><th>Paid by</th><th>Status</th></tr></thead>
      <tbody>{r.orders.map((o) => <tr key={`${o.station}-${o.order}`} className={o.status}><td>{o.order}</td><td>{o.date}</td><td>{o.day.slice(0, 3)}</td><td>{o.time}</td><td>{o.table}</td><td>{o.guests ?? ''}</td><td>{ordered(o)}</td><td>{money(o.total_cents)}</td><td>{o.paid_by}</td><td>{STATUS[o.status]}</td></tr>)}</tbody></table>
    {!r.orders.length && <p>No orders in these days.</p>}
  </div>;
}
