import { receiptLabel, requireRole, SELLERS } from '../auth/sessions.js';
import { currentStore, TAX_RATE } from '../core/config.js';
import { dayRange, money } from '../core/dates.js';
import { db } from '../core/db.js';
import { resized, tableSize } from './seed.js';
import { attachItems, logActivity, saleTime } from '../sales/orders.js';
import { app, notifyOwnerOverview, storeBroadcast } from '../core/http.js';
import { paymentMethod, tableBill } from '../../dining-domain.js';
import { getSetting, setSetting } from '../core/settings.js';

// ---------- Tables ----------

// Orders for a table that hasn't billed out yet: today's, and any still unpaid. A paid party left open
// overnight doesn't keep the table busy the next day, but an unpaid bill stays until it's paid.
export function openTableOrders(tableId = null) {
  const [from] = dayRange();
  return db.prepare(
    `SELECT * FROM orders WHERE table_id IS NOT NULL AND billed_out_at IS NULL
       AND (status = 'open' OR (status = 'paid' AND created_at >= ?))
       ${tableId ? 'AND table_id = ?' : ''} ORDER BY created_at, id`
  ).all(...(tableId ? [from, tableId] : [from]));
}

// Each party carries its unpaid orders with their items, so a till that loses its connection can still bill it out.
export function diningTables() {
  const open = new Map(), all = openTableOrders(), unpaid = attachItems(all.filter((o) => o.status === 'open'));
  for (const o of all) {
    const party = open.get(o.table_id) ?? { seated_at: o.seated_at ?? o.created_at, guests: 0, customer_tag: null, total_cents: 0, unpaid_cents: 0, receipts: [], orders: [] };
    party.guests = Math.max(party.guests, o.guests ?? 0);
    party.customer_tag = party.customer_tag ?? o.customer_tag;
    party.total_cents += o.total_cents;
    if (o.status === 'open') party.unpaid_cents += o.total_cents;
    party.receipts.push({ id: o.id, label: receiptLabel(o), total_cents: o.total_cents, created_at: o.created_at, paid: o.status === 'paid' });
    if (o.status === 'open') party.orders.push(unpaid.find((u) => u.id === o.id));
    open.set(o.table_id, party);
  }
  return db.prepare('SELECT * FROM floor_tables WHERE active = 1 ORDER BY id').all()
    .map(({ bill_requested_at, bill_requested_by, bill_pay_by, ...t }) => ({ ...t, party: open.has(t.id) ? { ...open.get(t.id), bill_requested_at, bill_requested_by, bill_pay_by } : null }));
}

export const announceTables = () => storeBroadcast(['pos', 'barista', 'kitchen', 'admin']).emit('tables.updated');

app.get('/api/tables', requireRole(...SELLERS, 'kitchen'), (req, res) => res.json(diningTables()));

// The balcony drawn on the floor map, in map units (the room runs from 14 to 1266 across, 76 to 704 down).
// The owner can make it bigger or smaller and move it; every screen's map shows it the same.
const BALCONY = { x: 100, y: 84, w: 166, h: 508 };
export function floorLayout() {
  let saved = null;
  try { saved = JSON.parse(getSetting('floor_balcony', 'null')); } catch { /* the standard balcony */ }
  return { balcony: saved ?? BALCONY };
}
app.get('/api/floor', requireRole(...SELLERS, 'kitchen'), (req, res) => res.json(floorLayout()));
app.put('/api/admin/floor', (req, res) => {
  const b = req.body?.balcony, whole = (n) => Number.isInteger(n);
  if (!b || ![b.x, b.y, b.w, b.h].every(whole) || b.w < 60 || b.h < 60 || b.x < 14 || b.y < 76 || b.x + b.w > 1266 || b.y + b.h > 704) {
    return res.status(400).json({ error: 'The balcony has to fit inside the room' });
  }
  const balcony = { x: b.x, y: b.y, w: b.w, h: b.h };
  setSetting('floor_balcony', JSON.stringify(balcony));
  logActivity(req, 'floor.balcony', `Balcony resized to ${balcony.w} × ${balcony.h}`);
  announceTables();
  res.json(floorLayout());
});

const clearBillRequest = (tableId) => db.prepare('UPDATE floor_tables SET bill_requested_at = NULL, bill_requested_by = NULL, bill_pay_by = NULL WHERE id = ?').run(tableId);

// A waiter asks for a table's bill, saying whether they'll pay by cash or card. The cashier's till shows the
// request and opens Bill out with that method picked; the cashier takes the payment (the waiter can't). The request clears once they pay, or when the cashier dismisses it.
app.post('/api/tables/:id/request-bill', requireRole(...SELLERS), (req, res) => {
  const table = db.prepare('SELECT * FROM floor_tables WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  if (!openTableOrders(table.id).some((o) => o.status === 'open')) return res.status(409).json({ error: `${table.name} has nothing to pay` });
  const by = req.staff?.name ?? (req.role === 'barista' ? 'Waiter' : 'Cashier'), payBy = paymentMethod(req.body?.paymentMethod);
  db.prepare('UPDATE floor_tables SET bill_requested_at = COALESCE(bill_requested_at, ?), bill_requested_by = COALESCE(bill_requested_by, ?), bill_pay_by = ? WHERE id = ?').run(new Date().toISOString(), by, payBy, table.id);
  logActivity(req, 'table.bill_requested', `${by} asked for ${table.name}'s bill (paying by ${payBy})`);
  announceTables();
  storeBroadcast('pos').emit('bill.requested', { table_id: table.id, table_name: table.name, by, pay_by: payBy });
  res.json({ ok: true });
});
app.delete('/api/tables/:id/request-bill', requireRole('pos'), (req, res) => {
  clearBillRequest(Number(req.params.id));
  announceTables();
  res.json({ ok: true });
});

// The cashier: the party paid up and left. The table is free and its orders get the exit time.
app.post('/api/tables/:id/bill-out', requireRole('pos'), (req, res) => {
  const table = db.prepare('SELECT * FROM floor_tables WHERE id = ?').get(Number(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  const open = openTableOrders(table.id);
  if (!open.length) return res.status(409).json({ error: `${table.name} is already free` });
  const unpaid = open.filter((o) => o.status === 'open');
  if (unpaid.length) return res.status(409).json({ error: `${table.name} still owes ${money(unpaid.reduce((n, o) => n + o.total_cents, 0))}. Take their payment first.` });
  const now = new Date().toISOString();
  const stay = Math.round((Date.parse(now) - Date.parse(open[0].seated_at ?? open[0].created_at)) / 60000);
  db.exec('BEGIN');
  try {
    const mark = db.prepare('UPDATE orders SET billed_out_at = ?, billed_by_name = COALESCE(billed_by_name, ?) WHERE id = ?');
    for (const o of open) mark.run(now, req.staff?.name ?? null, o.id);
    clearBillRequest(table.id);
    logActivity(req, 'table.billed_out',
      `${table.name} billed out after ${stay} min · ${open.map((o) => `#${receiptLabel(o)}`).join(', ')} · ${money(open.reduce((n, o) => n + o.total_cents, 0))}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  announceTables();
  res.json({ ok: true });
});

// What a table owes: its unpaid orders with their items, for the bill.
app.get('/api/tables/:id/bill', requireRole(...SELLERS), (req, res) => {
  const table = db.prepare('SELECT * FROM floor_tables WHERE id = ?').get(Number(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  res.json({ table, orders: attachItems(openTableOrders(table.id).filter((o) => o.status === 'open')) });
});

// A table's orders paid together, as one receipt.
export function paidBill(billId) {
  const orders = attachItems(db.prepare('SELECT * FROM orders WHERE bill_id = ? ORDER BY id').all(billId));
  if (!orders.length) return null;
  const sum = (key) => orders.reduce((n, o) => n + (o[key] ?? 0), 0), first = orders[0];
  const discount = JSON.parse(first.discount_json ?? 'null');
  return {
    bill_id: billId, station: first.station, table_id: first.table_id, table_name: first.table_name, guests: Math.max(...orders.map((o) => o.guests ?? 0)) || null,
    created_at: first.paid_at, staff_name: orders.at(-1).staff_name, labels: orders.map((o) => receiptLabel(o)), order_ids: orders.map((o) => o.id),
    items: orders.flatMap((o) => o.items), subtotal_cents: sum('subtotal_cents'), discount_cents: sum('discount_cents'), tax_cents: sum('tax_cents'), total_cents: sum('total_cents'),
    discount_json: JSON.stringify(discount?.kind === 'fixed' ? { ...discount, value: sum('discount_cents') } : discount),
    cash_tendered_cents: first.cash_tendered_cents, change_cents: first.change_cents, payment_method: first.payment_method, billed_by_name: first.billed_by_name,
  };
}

app.get('/api/bills/:billId', requireRole(...SELLERS), (req, res) => {
  const bill = paidBill(req.params.billId);
  return bill ? res.json(bill) : res.status(404).json({ error: 'Bill not found' });
});

// Bill out with payment: the table's unpaid orders are paid together, with any discount (seniors and PWDs by
// group share) worked out on the whole bill, and the table becomes free.
app.post('/api/tables/:id/pay', requireRole('pos'), (req, res) => {
  const table = db.prepare('SELECT * FROM floor_tables WHERE id = ?').get(Number(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  const { billId, cashTenderedCents, totalCents } = req.body ?? {};
  if (typeof billId !== 'string' || !billId || billId.length > 100) return res.status(400).json({ error: 'billId is required' });
  // A retry of a payment already taken: return it instead of charging twice.
  const done = paidBill(billId);
  if (done) return res.json(done);
  const open = openTableOrders(table.id), unpaid = attachItems(open.filter((o) => o.status === 'open'));
  if (!unpaid.length) return res.status(409).json({ error: `${table.name} has nothing left to pay` });
  const discount = currentStore() === 'ambiente' ? req.body?.discount ?? null : null;
  let bill;
  try { bill = tableBill(unpaid, discount, TAX_RATE); } catch (e) { return res.status(400).json({ error: e.message }); }
  // The cashier took cash for the bill they saw; if an order changed since, they check it again.
  if (totalCents !== undefined && totalCents !== bill.total_cents) return res.status(409).json({ error: `${table.name}'s bill changed to ${money(bill.total_cents)}. Check it with the customer again.` });
  // Paid by card: no cash received and no change.
  const paidBy = paymentMethod(req.body?.paymentMethod);
  if (paidBy === 'cash' && (!Number.isInteger(cashTenderedCents) || cashTenderedCents < bill.total_cents)) return res.status(400).json({ error: 'Cash received is less than the bill' });
  const cash = paidBy === 'cash' ? cashTenderedCents : null;
  // A payment taken while the till was offline keeps the time it was taken.
  const now = saleTime(req.body?.paidAt), change = cash === null ? null : cash - bill.total_cents;
  db.exec('BEGIN');
  try {
    const pay = db.prepare(`UPDATE orders SET status = 'paid', subtotal_cents = ?, discount_cents = ?, tax_cents = ?, total_cents = ?, discount_json = ?,
      cash_tendered_cents = ?, change_cents = ?, payment_method = ?, billed_by_name = ?, bill_id = ?, paid_at = ?, version = version + 1 WHERE id = ? AND status = 'open'`);
    for (const o of bill.orders) pay.run(o.subtotal_cents, o.discount_cents, o.tax_cents, o.total_cents, JSON.stringify(o.discount), cash, change, paidBy, req.staff?.name ?? null, billId, now, o.id);
    const free = db.prepare('UPDATE orders SET billed_out_at = ? WHERE id = ?');
    for (const o of open) free.run(now, o.id);
    clearBillRequest(table.id);
    const stay = Math.round((Date.parse(now) - Date.parse(open[0].seated_at ?? open[0].created_at)) / 60000);
    logActivity(req, 'table.paid', `${table.name} paid ${money(bill.total_cents)}${bill.discount_cents ? ` (discount ${money(bill.discount_cents)})` : ''} ${paidBy === 'card' ? 'by card' : `in cash, change ${money(change)}`}, and billed out after ${stay} min · ${unpaid.map((o) => `#${receiptLabel(o)}`).join(', ')}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  announceTables();
  storeBroadcast(['pos', 'barista', 'admin']).emit('order.paid');
  notifyOwnerOverview();
  res.json(paidBill(billId));
});

export function tableProblem({ name, seats }, ignoreId = 0) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 30) return 'Table name must be 1–30 characters';
  if (!Number.isInteger(seats) || seats < 1 || seats > 50) return 'Seats must be 1–50';
  if (db.prepare('SELECT 1 FROM floor_tables WHERE lower(name) = lower(?) AND id != ? AND active = 1').get(name.trim(), ignoreId)) {
    return `There is already a table called "${name.trim()}"`;
  }
  return null;
}
export const onMap = (n, max) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;

app.get('/api/admin/tables', (req, res) => res.json(diningTables()));

// Owner: a new table appears in the bottom-left corner of the map, ready to be dragged into place.
app.post('/api/admin/tables', (req, res) => {
  const name = req.body?.name, seats = Number(req.body?.seats);
  const problem = tableProblem({ name, seats });
  if (problem) return res.status(400).json({ error: problem });
  const id = Number(db.prepare('INSERT INTO floor_tables (name, seats, x, y, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name.trim(), seats, 30, 640, tableSize(seats).w, tableSize(seats).h, new Date().toISOString()).lastInsertRowid);
  logActivity(req, 'table.added', `Added ${name.trim()} (${seats} seats)`);
  announceTables();
  res.status(201).json(db.prepare('SELECT * FROM floor_tables WHERE id = ?').get(id));
});

// Owner: rename, change seats, or move a table on the map.
app.patch('/api/admin/tables/:id', (req, res) => {
  const table = db.prepare('SELECT * FROM floor_tables WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  const next = { ...table, ...req.body, seats: req.body?.seats === undefined ? table.seats : Number(req.body.seats) };
  const problem = tableProblem(next, table.id);
  if (problem) return res.status(400).json({ error: problem });
  if (!onMap(next.x, 1280) || !onMap(next.y, 720)) return res.status(400).json({ error: 'Table is off the map' });
  // Going from a 2-seater to a bigger table (or back) changes its shape.
  const shape = (next.seats <= 2) === (table.seats <= 2) ? { ...next, w: table.w, h: table.h } : { ...next, ...resized({ ...table, x: next.x, y: next.y }, next.seats) };
  db.prepare('UPDATE floor_tables SET name = ?, seats = ?, x = ?, y = ?, w = ?, h = ? WHERE id = ?')
    .run(next.name.trim(), next.seats, Math.round(shape.x), Math.round(shape.y), shape.w, shape.h, table.id);
  if (next.name.trim() !== table.name || next.seats !== table.seats) {
    logActivity(req, 'table.edited', `${table.name} (${table.seats} seats) → ${next.name.trim()} (${next.seats} seats)`);
  }
  announceTables();
  res.json(db.prepare('SELECT * FROM floor_tables WHERE id = ?').get(table.id));
});

// Owner: remove a table. Past receipts keep the table's name.
app.delete('/api/admin/tables/:id', (req, res) => {
  const table = db.prepare('SELECT * FROM floor_tables WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  if (openTableOrders(table.id).length) return res.status(409).json({ error: `${table.name} has guests. Bill them out first.` });
  db.prepare('UPDATE floor_tables SET active = 0 WHERE id = ?').run(table.id);
  logActivity(req, 'table.removed', `Removed ${table.name}`);
  announceTables();
  res.json({ ok: true });
});
