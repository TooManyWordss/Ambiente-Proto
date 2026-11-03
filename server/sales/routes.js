import { currentStore } from '../core/config.js';
import { prepStation, totals as diningTotals } from '../../dining-domain.js';
import { TAX_RATE } from '../core/config.js';
import { receiptLabel, requireRole, SELLERS, stationOf } from '../auth/sessions.js';
import { dayRange, localDate, money } from '../core/dates.js';
import { db } from '../core/db.js';
import { dayReport, loadOrder, logActivity, saleTime } from './orders.js';
import { app, notifyOwnerOverview, storeBroadcast } from '../core/http.js';
import { applyRecipes } from '../inventory/routes.js';
import { announceTables, openTableOrders } from '../tables/routes.js';
import { byWeight, weighedLine } from '../../weighed.js';

// ---------- Sales ----------

export const findSellable = {
  get(id) { return db.prepare("SELECT * FROM menu_items WHERE id = ? AND active = 1 AND status = 'approved'").get(id); },
};

// A cook's instruction on one item ("Medium rare, not spicy"). Empty when there is none; null if it's too long.
const NOTE_MAX = 140;
const cleanNote = (note) => note == null ? '' : typeof note === 'string' && note.trim().length <= NOTE_MAX ? note.trim() : null;
// What one line sells: a weighed steak is named and priced by its weight. Returns an error message instead if the weight is missing or wrong.
function sellAs(menuItem, grams) {
  if (!byWeight(menuItem)) return grams == null ? { name: menuItem.name, unit_price_cents: menuItem.price_cents, grams: null } : `${menuItem.name} isn't sold by weight`;
  if (grams == null) return `Weigh the ${menuItem.name} first: it's sold by weight`;
  const line = weighedLine(menuItem, grams);
  return line.error ?? line;
}
// Lines of a receipt are told apart by item and, for weighed steaks, weight: a 55 g and an 85 g Wagyu are two lines.
const lineKey = (menuItemId, grams) => `${menuItemId}:${grams ?? ''}`;

// POS or barista bar -> server: ring up a cash sale.
app.post('/api/orders', requireRole(...SELLERS), (req, res) => {
  const { clientId, items, createdAt, cashTenderedCents } = req.body ?? {};
  // A table's order can be paid later, at bill out: it goes to the kitchen now, and the discount and cash come then.
  const payLater = req.body?.payLater === true;
  if (payLater && !req.body?.table) return res.status(400).json({ error: 'Only a table’s order can be paid at bill out' });
  const discount = currentStore() === 'ambiente' && !payLater ? req.body?.discount ?? null : null;
  const station = stationOf(req, req.body?.station);
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 100) {
    return res.status(400).json({ error: 'clientId is required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order has no items' });
  }

  // A retry of an order we already saved: return it instead of charging twice.
  const existing = db.prepare('SELECT id FROM orders WHERE client_id = ?').get(clientId);
  if (existing) return res.json(loadOrder(existing.id));

  // Prices come from the database, never from the client.
  const lines = [];
  const rungUpAt = saleTime(createdAt);
  for (const { menuItemId, qty, note: rawNote, grams } of items) {
    const menuItem = findSellable.get(Number(menuItemId));
    if (!menuItem) return res.status(400).json({ error: `Item ${menuItemId} is not on the menu` });
    // A sale saved offline before the item ran out still goes through.
    if (menuItem.unavailable_since && rungUpAt >= menuItem.unavailable_since) {
      return res.status(400).json({ error: `${menuItem.name} is marked unavailable` });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return res.status(400).json({ error: `Invalid quantity for ${menuItem.name}` });
    }
    const note = cleanNote(rawNote);
    if (note === null) return res.status(400).json({ error: `The note on ${menuItem.name} is too long (${NOTE_MAX} characters at most)` });
    const sold = sellAs(menuItem, grams);
    if (typeof sold === 'string') return res.status(400).json({ error: sold });
    lines.push({ menuItem, qty, note, station: prepStation(menuItem), ...sold });
  }

  let bill;
  try { bill = diningTotals({ discount, submissions: [{ lines: lines.map(l => ({ qty: l.qty, unit_price_cents: l.unit_price_cents })) }] }, TAX_RATE); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const { subtotal_cents: subtotal, tax_cents: tax, total_cents: total } = bill;
  let tendered = null;
  if (!payLater && cashTenderedCents !== undefined && cashTenderedCents !== null) {
    if (!Number.isInteger(cashTenderedCents) || cashTenderedCents < 0) {
      return res.status(400).json({ error: 'Invalid cash amount' });
    }
    if (cashTenderedCents < total) return res.status(400).json({ error: 'Cash received is less than the total' });
    tendered = cashTenderedCents;
  }
  const kitchenStatus = lines.some((l) => l.station) ? 'new' : 'none';

  // Dine-in: which table, how many, and when they sat down. No table = takeout / counter.
  let table = null, guests = null, customerTag = null, seatedAt = null;
  if (req.body?.table) {
    const { tableId, guests: g, customerTag: tag, seatedAt: seated } = req.body.table;
    table = db.prepare('SELECT * FROM floor_tables WHERE id = ?').get(Number(tableId));
    if (!table) return res.status(400).json({ error: 'That table no longer exists' });
    if (g !== undefined && g !== null && (!Number.isInteger(g) || g < 1 || g > 50)) return res.status(400).json({ error: 'Guests must be 1–50' });
    if (tag && !['vip', 'repeat'].includes(tag)) return res.status(400).json({ error: 'Unknown customer type' });
    guests = g ?? null;
    customerTag = tag || null;
    // A party adding to their table keeps the time they first sat down.
    const already = openTableOrders(table.id)[0];
    seatedAt = already ? already.seated_at ?? already.created_at : seated ? saleTime(seated) : rungUpAt;
    if (seatedAt > rungUpAt) seatedAt = rungUpAt;
  }

  let orderId, announceStockChanges;
  db.exec('SAVEPOINT order_write');
  try {
    // Cashier receipts run 1001, 1002…; the barista bar has its own series, printed B-0001, B-0002…
    const { next } = db
      .prepare('SELECT COALESCE(MAX(receipt_no), ?) + 1 AS next FROM orders WHERE station = ?')
      .get(station === 'barista' ? 0 : 1000, station);
    orderId = Number(
      db
        .prepare(
          `INSERT INTO orders (client_id, station, receipt_no, created_at, payment_method, subtotal_cents, tax_cents,
             total_cents, kitchen_status, cash_tendered_cents, change_cents, staff_id, staff_name,
             table_id, table_name, guests, customer_tag, seated_at, discount_cents, discount_json, status)
           VALUES (?, ?, ?, ?, 'cash', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(clientId, station, next, rungUpAt, subtotal, tax, total, kitchenStatus, tendered,
          tendered === null ? null : tendered - total, req.staff?.id ?? null, req.staff?.name ?? null,
          table?.id ?? null, table?.name ?? null, guests, customerTag, seatedAt, bill.discount_cents, JSON.stringify(discount), payLater ? 'open' : 'paid')
        .lastInsertRowid
    );
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, menu_item_id, name, unit_price_cents, qty, sends_to_kitchen, note, grams, station)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const { menuItem, qty, note, name, unit_price_cents, grams, station } of lines) {
      insertItem.run(orderId, menuItem.id, name, unit_price_cents, qty, station ? 1 : 0, note, grams, station);
    }
    const sold = new Map();
    for (const { menuItem, qty } of lines) sold.set(menuItem.id, (sold.get(menuItem.id) ?? 0) + qty);
    announceStockChanges = applyRecipes(req, sold, `Order #${receiptLabel({ station, receipt_no: next })}`);
    db.exec('RELEASE order_write');
  } catch (err) {
    db.exec('ROLLBACK TO order_write; RELEASE order_write');
    throw err;
  }
  announceStockChanges();

  const order = loadOrder(orderId);
  storeBroadcast(['kitchen', 'admin', 'pos', 'barista']).emit('order.created', order);
  if (order.table_id) announceTables();
  notifyOwnerOverview();
  res.status(201).json(order);
});

// Cashiers and baristas may change or void today's receipts from their own till; the owner may change any.
export function changeProblem(order, req) {
  if (!order) return [404, 'Order not found'];
  if (order.status === 'voided') return [409, `Order #${order.receipt_label} is already voided`];
  if (req.role !== 'admin' && order.station !== stationOf(req)) {
    return [403, `Order #${order.receipt_label} belongs to the ${order.station === 'barista' ? 'barista bar' : 'cashier'}. Change it there.`];
  }
  const [from, to] = dayRange();
  if (req.role !== 'admin' && !(order.created_at >= from && order.created_at < to)) {
    return [403, "Only today's orders can be changed here. Ask the owner."];
  }
  return null;
}

// POS -> server: the customer changed their mind. Replaces the receipt's items.
// Items already on the receipt keep the price they were sold at; new items use today's price.
app.patch('/api/orders/:id', requireRole(...SELLERS), (req, res) => {
  const order = loadOrder(Number(req.params.id));
  const problem = changeProblem(order, req);
  if (problem) return res.status(problem[0]).json({ error: problem[1] });

  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'An order needs at least one item. Use Void to cancel the whole order.' });
  }

  const before = new Map(); // line key -> { name, unit_price_cents, sends_to_kitchen, qty }
  for (const i of order.items) {
    const key = lineKey(i.menu_item_id, i.grams), prev = before.get(key);
    before.set(key, { ...i, qty: (prev?.qty ?? 0) + i.qty, ready_qty: (prev?.ready_qty ?? 0) + i.ready_qty });
  }

  const wanted = new Map(), notes = new Map(), weights = new Map();
  for (const { menuItemId, qty, note, grams } of items) {
    const id = lineKey(Number(menuItemId), grams);
    if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'Invalid quantity' });
    wanted.set(id, (wanted.get(id) ?? 0) + qty);
    weights.set(id, [Number(menuItemId), grams ?? null]);
    // A till that doesn't send notes leaves the ones already on the receipt alone.
    if (note !== undefined) {
      const clean = cleanNote(note);
      if (clean === null) return res.status(400).json({ error: `A note is too long (${NOTE_MAX} characters at most)` });
      notes.set(id, clean);
    }
  }

  const lines = [];
  for (const [id, qty] of wanted) {
    if (qty > 99) return res.status(400).json({ error: 'Invalid quantity' });
    const prev = before.get(id);
    if (prev) {
      lines.push({ key: id, id: prev.id, ready_qty: Math.min(prev.ready_qty, qty), note: notes.get(id) ?? prev.note ?? '', menu_item_id: prev.menu_item_id, name: prev.name, unit_price_cents: prev.unit_price_cents, sends_to_kitchen: prev.sends_to_kitchen, grams: prev.grams ?? null, qty });
      continue;
    }
    const [menuItemId, grams] = weights.get(id);
    const menuItem = findSellable.get(menuItemId);
    if (!menuItem) return res.status(400).json({ error: `Item ${menuItemId} is not on the menu` });
    if (menuItem.unavailable_since) return res.status(400).json({ error: `${menuItem.name} is marked unavailable` });
    const sold = sellAs(menuItem, grams);
    if (typeof sold === 'string') return res.status(400).json({ error: sold });
    const station = prepStation(menuItem);
    lines.push({ key: id, menu_item_id: menuItemId, sends_to_kitchen: station ? 1 : 0, station, qty, note: notes.get(id) ?? '', ...sold });
  }

  // "+1 Fries, −1 Iced Tea" for the activity log.
  const changes = [];
  for (const id of new Set([...before.keys(), ...wanted.keys()])) {
    const diff = (wanted.get(id) ?? 0) - (before.get(id)?.qty ?? 0);
    const name = before.get(id)?.name ?? lines.find((l) => l.key === id).name;
    if (diff) changes.push(`${diff > 0 ? '+' : '−'}${Math.abs(diff)} ${name}`);
    const prev = before.get(id), line = lines.find((l) => l.key === id);
    if (prev && line && (prev.note ?? '') !== line.note) changes.push(line.note ? `Note on ${name}: "${line.note}"` : `Note on ${name} removed`);
  }
  // A table's unpaid order gets its discount when the table pays.
  const discount = order.status === 'open' ? null : currentStore() === 'ambiente' && Object.hasOwn(req.body, 'discount') ? req.body.discount : JSON.parse(order.discount_json ?? 'null');
  if (JSON.stringify(discount) !== JSON.stringify(JSON.parse(order.discount_json ?? 'null'))) changes.push('Discount updated');
  if (changes.length === 0) return res.status(400).json({ error: 'Nothing was changed' });

  let bill;
  try { bill = diningTotals({ discount, submissions: [{ lines }] }, TAX_RATE); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const { subtotal_cents: subtotal, tax_cents: tax, total_cents: total } = bill;

  // Keep the kitchen in step: new kitchen items reopen a finished ticket,
  // and a ticket with no kitchen items left disappears.
  // An item the kitchen already marked ready stays ready unless more of it was added.
  const readyAt = new Map();
  for (const i of order.items) {
    const key = lineKey(i.menu_item_id, i.grams);
    const ready = readyAt.has(key) ? readyAt.get(key) && i.kitchen_ready_at : i.kitchen_ready_at;
    readyAt.set(key, ready || null);
  }
  const startedAt = new Map(order.items.map((i) => [lineKey(i.menu_item_id, i.grams), i.kitchen_started_at ?? null]));
  for (const l of lines) {
    const kept = l.qty <= (before.get(l.key)?.qty ?? 0);
    l.kitchen_ready_at = kept ? readyAt.get(l.key) ?? null : null;
    l.kitchen_started_at = kept ? startedAt.get(l.key) ?? null : null;
  }
  const hasKitchenItems = lines.some((l) => l.sends_to_kitchen);
  const moreForKitchen = lines.some((l) => l.sends_to_kitchen && l.qty > (before.get(l.key)?.qty ?? 0));
  const allReady = hasKitchenItems && lines.every((l) => !l.sends_to_kitchen || l.kitchen_ready_at);
  let kitchenStatus = order.kitchen_status;
  if (!hasKitchenItems && ['new', 'preparing', 'none'].includes(kitchenStatus)) kitchenStatus = 'none';
  else if (hasKitchenItems && kitchenStatus === 'none') kitchenStatus = 'new';
  else if (moreForKitchen && kitchenStatus === 'ready') kitchenStatus = 'new';
  else if (allReady && ['new', 'preparing'].includes(kitchenStatus)) kitchenStatus = 'ready';
  const reopened = kitchenStatus === 'new' && order.kitchen_status !== 'new';
  const finished = kitchenStatus === 'ready' && order.kitchen_status !== 'ready';
  // Stock follows the menu item: steaks of any weight use the same recipe.
  const sold = new Map();
  for (const id of new Set([...before.keys(), ...wanted.keys()])) {
    const menuItemId = before.get(id)?.menu_item_id ?? weights.get(id)[0];
    sold.set(menuItemId, (sold.get(menuItemId) ?? 0) + (wanted.get(id) ?? 0) - (before.get(id)?.qty ?? 0));
  }
  let announceStockChanges;

  db.exec('SAVEPOINT order_write');
  try {
    const retained = new Set(lines.filter(l => l.id).map(l => l.id));
    for (const old of order.items) if (!retained.has(old.id)) db.prepare('DELETE FROM order_items WHERE id = ?').run(old.id);
    const insertItem = db.prepare('INSERT INTO order_items (order_id, menu_item_id, name, unit_price_cents, qty, sends_to_kitchen, ready_qty, note, kitchen_ready_at, kitchen_started_at, grams, station) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const l of lines) {
      if (l.id) db.prepare('UPDATE order_items SET qty = ?, ready_qty = ?, note = ?, kitchen_ready_at = ?, kitchen_started_at = ? WHERE id = ?').run(l.qty, l.ready_qty, l.note ?? '', l.kitchen_ready_at, l.kitchen_started_at, l.id);
      else insertItem.run(order.id, l.menu_item_id, l.name, l.unit_price_cents, l.qty, l.sends_to_kitchen, 0, l.note, l.kitchen_ready_at, l.kitchen_started_at, l.grams, l.station);
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE orders SET subtotal_cents = ?, tax_cents = ?, total_cents = ?, discount_cents = ?, discount_json = ?, kitchen_status = ?,
         kitchen_started_at = CASE WHEN ? THEN NULL ELSE kitchen_started_at END,
         kitchen_ready_at   = CASE WHEN ? THEN NULL WHEN ? THEN ? ELSE kitchen_ready_at END,
         edited_at = ?, edit_count = edit_count + 1
       WHERE id = ?`
    ).run(subtotal, tax, total, bill.discount_cents, JSON.stringify(discount), kitchenStatus, reopened ? 1 : 0, reopened ? 1 : 0, finished ? 1 : 0, now, now, order.id);
    logActivity(req, 'order.edited',
      `Edited order #${order.receipt_label}: ${changes.join(', ')} (${money(order.total_cents)} → ${money(total)})`, order.id);
    announceStockChanges = applyRecipes(req, sold, `Order #${order.receipt_label} edited`);
    db.exec('RELEASE order_write');
  } catch (err) {
    db.exec('ROLLBACK TO order_write; RELEASE order_write');
    throw err;
  }
  announceStockChanges();

  const updated = loadOrder(order.id);
  storeBroadcast(['kitchen', 'admin', 'pos', 'barista']).emit('order.updated', updated);
  if (updated.table_id) announceTables();
  notifyOwnerOverview();
  res.json({ order: updated, differenceCents: total - order.total_cents });
});

// POS -> server: cancel a whole receipt. It stays on record, marked voided, and no longer counts as a sale.
app.post('/api/orders/:id/void', requireRole(...SELLERS), (req, res) => {
  const order = loadOrder(Number(req.params.id));
  const problem = changeProblem(order, req);
  if (problem) return res.status(problem[0]).json({ error: problem[1] });

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 200) return res.status(400).json({ error: 'Give a reason for voiding (up to 200 characters)' });

  const kitchenStatus = ['new', 'preparing'].includes(order.kitchen_status) ? 'cancelled' : order.kitchen_status;
  const returned = new Map();
  for (const i of order.items) returned.set(i.menu_item_id, (returned.get(i.menu_item_id) ?? 0) - i.qty);
  let announceStockChanges;
  db.exec('SAVEPOINT order_write');
  try {
    db.prepare(
      `UPDATE orders SET status = 'voided', void_reason = ?, voided_at = ?, voided_by = ?, kitchen_status = ? WHERE id = ?`
    ).run(reason, new Date().toISOString(), req.role, kitchenStatus, order.id);
    logActivity(req, 'order.voided', `Voided order #${order.receipt_label} (${money(order.total_cents)}): ${reason}`, order.id);
    announceStockChanges = applyRecipes(req, returned, `Order #${order.receipt_label} voided`);
    db.exec('RELEASE order_write');
  } catch (err) {
    db.exec('ROLLBACK TO order_write; RELEASE order_write');
    throw err;
  }
  announceStockChanges();

  const updated = loadOrder(order.id);
  storeBroadcast(['kitchen', 'admin', 'pos', 'barista']).emit('order.updated', updated);
  if (updated.table_id) announceTables();
  notifyOwnerOverview();
  res.json(updated);
});

// ---------- Cashier and barista: today only, their own till ----------

app.get('/api/pos/today', (req, res) => res.json(dayReport(localDate(), stationOf(req, req.query.station))));
