import React, { useEffect, useMemo, useState } from 'react';
import { discountLines, tableBill } from '../../../dining-domain.js';
import DiscountEditor from '../discount-editor';
import { api } from '../shared/api';
import { money, rid, time } from '../shared/format';
import type { DiningTable, Order } from '../shared/types';
import { Dialog } from '../shared/ui';

// A table's bill as receipt data: unpaid (printed as the bill to check), or paid (the receipt).
export type TableReceipt = Record<string, any>;
export function billReceipt(table: DiningTable, orders: Order[], discount: any, taxRate: number): TableReceipt {
  const bill = tableBill(orders, discount, taxRate);
  return { heading: 'BILL - NOT AN OFFICIAL RECEIPT', receipt_label: orders.map(o => o.receipt_label).join(', '), station: 'cashier', table_name: table.name, guests: table.party?.guests ?? null, created_at: new Date().toISOString(), items: orders.flatMap(o => o.items.filter(i => i.qty > 0)), subtotal_cents: bill.subtotal_cents, discount_cents: bill.discount_cents, tax_cents: bill.tax_cents, total_cents: bill.total_cents, discount_json: JSON.stringify(discount) };
}

// Bill out: what the table ordered, any discount (seniors and PWDs by group share), the cash, and the receipt.
export function BillOut({ table, taxRate, onClose, onPrintBill, onPaid, onFree }: { table: DiningTable; taxRate: number; onClose: () => void; onPrintBill: (r: TableReceipt) => void; onPaid: (r: TableReceipt) => void; onFree: () => void }) {
  const [orders, setOrders] = useState<Order[] | null>(null), [error, setError] = useState(''), [discount, setDiscount] = useState<any>(null), [discountOpen, setDiscountOpen] = useState(false);
  const [cash, setCash] = useState(''), [saving, setSaving] = useState(false), [billId] = useState(rid);
  useEffect(() => { api<{ orders: Order[] }>(`/api/tables/${table.id}/bill`).then(r => setOrders(r.orders)).catch(e => setError((e as Error).message)); }, [table.id]);
  const bill = useMemo(() => { try { return orders?.length ? tableBill(orders, discount, taxRate) : null; } catch { return null; } }, [orders, discount, taxRate]);
  const lines = bill && discount ? discountLines(bill.subtotal_cents, discount, taxRate) : [];
  const paid = Math.round((Number(cash.replace(/,/g, '')) || 0) * 100), total = bill?.total_cents ?? 0, change = paid - total;
  async function pay() {
    if (!bill || paid < total || saving) return;
    setSaving(true); setError('');
    try {
      const r = await api<any>(`/api/tables/${table.id}/pay`, { method: 'POST', body: { billId, discount, cashTenderedCents: paid, totalCents: total } });
      onPaid({ ...r, receipt_label: r.labels.join(', ') });
    } catch (e) { setError((e as Error).message); setSaving(false); }
  }
  if (discountOpen && bill) return <Dialog title={`Discount · ${table.name}`} onClose={() => setDiscountOpen(false)}><DiscountEditor discount={discount} guests={table.party?.guests} subtotal={bill.subtotal_cents} taxRate={taxRate} onClose={() => setDiscountOpen(false)} onSave={d => { setDiscount(d); setDiscountOpen(false); }}/></Dialog>;
  return <Dialog title={`Bill out · ${table.name}`} onClose={onClose}>
    <div className="bill-out">
      <p className="hint">{table.party ? `${table.party.guests ? `${table.party.guests} guests · ` : ''}seated ${time(table.party.seated_at)}` : ''}</p>
      {!orders && !error && <p className="hint">Opening the bill…</p>}
      {orders && !orders.length && <><p className="confirm-text">{table.name} has nothing left to pay.</p><div className="sheet-actions"><button className="btn" onClick={onClose}>Close</button><button className="btn primary" onClick={onFree}>Free the table</button></div></>}
      {orders && orders.length > 0 && bill && <>
        <ul className="bill-orders">{orders.map(o => <li key={o.id}><div className="bill-order-head"><strong>#{o.receipt_label}</strong><span>{time(o.created_at)}</span></div>
          {o.items.filter(i => i.qty > 0).map(i => <div className="bill-line" key={i.id}><span>{i.qty} × {i.name}{i.note && <small className="line-note-text">{i.note}</small>}</span><span>{money(i.qty * (i.unit_price_cents ?? 0))}</span></div>)}</li>)}</ul>
        <dl className="totals">
          <dt>Subtotal</dt><dd>{money(bill.subtotal_cents)}</dd>
          {lines.map(l => <React.Fragment key={l.label}><dt>{l.label}</dt><dd>−{money(l.cents)}</dd></React.Fragment>)}
          {bill.tax_cents > 0 && <><dt>Tax</dt><dd>{money(bill.tax_cents)}</dd></>}
          <dt className="grand">Total bill</dt><dd className="grand">{money(total)}</dd>
        </dl>
        <div className="bill-tools">
          <button className="btn" onClick={() => setDiscountOpen(true)}>{discount ? `Discount · ${discount.label || 'Other'}` : 'Discount (Senior / PWD)'}</button>
          {discount && <button className="link" onClick={() => setDiscount(null)}>Remove discount</button>}
          <button className="btn" onClick={() => onPrintBill(billReceipt(table, orders, discount, taxRate))}>Print bill</button>
        </div>
        <div className="pay-area">
          <div className="tender"><label htmlFor="bill-cash">Cash received</label><button className="link" onClick={() => setCash('')}>Reset</button><input id="bill-cash" inputMode="decimal" placeholder="0.00" value={cash} onChange={e => setCash(e.target.value)}/></div>
          <div className="quick-cash">{[1000, 500, 200, 100, 50, 20, 10, 5, 1].map(d => <button className="cash-btn" key={d} onClick={() => setCash(String((Number(cash) || 0) + d))}>₱{d.toLocaleString('en-PH')}</button>)}<button className="cash-btn exact" onClick={() => setCash((total / 100).toFixed(2))}>Exact</button></div>
          <div className="change-row"><span>{paid && change < 0 ? 'Still needed' : 'Change'}</span><strong className={change < 0 ? 'short' : ''}>{paid ? money(Math.abs(change)) : '—'}</strong></div>
          <button className="btn primary big" disabled={paid < total || saving} onClick={() => void pay()}>{saving ? 'Saving…' : 'Pay & print receipt'}</button>
        </div>
      </>}
      {error && <p className="status error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}
