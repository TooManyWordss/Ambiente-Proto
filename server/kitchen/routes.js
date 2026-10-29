import { requireRole, stationOf } from '../auth/sessions.js';
import { currentStore } from '../core/config.js';
import { db } from '../core/db.js';
import { dayRange } from '../core/dates.js';
import { attachItems, loadOrder } from '../sales/orders.js';
import { app, screenCounts, storeBroadcast } from '../core/http.js';
import { ticketState } from '../../dining-domain.js';

// ---------- Kitchen ----------

// How many kitchen screens are open right now. With none, the till prints a paper kitchen slip.
// It sits under /api/pos because everything under /api/kitchen is for the kitchen screen only.
app.get('/api/pos/kitchen-screens', (req, res) => {
  res.json({ screens: screenCounts().kitchen });
});

// ---------- Ready to collect ----------

// Kitchen orders finished in the last hour, for the till that took them. The POS shows each one, with a
// chime, until someone taps "Picked up". Counter orders and table orders (from Unpaid tabs) both count.
const PICKUP_WINDOW_MS = 60 * 60 * 1000;
// Ready to collect, item by item: each piece the kitchen finishes shows on the till, grouped by order,
// without waiting for the whole order. Every piece has its own key, so "Picked up" on part of an order
// leaves the rest to ring when it's done. Each group says how much of the order is ready.
const unitKeys = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}:${i + 1}`);
const group = (key, title, label, units, ready) => ready.length && ({
  key, title, label, items: ready.map(({ ready_at, ...item }) => item),
  ready_at: ready.map((r) => r.ready_at).sort().at(-1),
  ready: ready.reduce((n, r) => n + r.qty, 0), total: units, complete: ready.reduce((n, r) => n + r.qty, 0) === units,
});
export function readyForPickup(station) {
  const since = new Date(Date.now() - PICKUP_WINDOW_MS).toISOString();
  const recent = db.prepare(`SELECT DISTINCT o.* FROM orders o JOIN order_items i ON i.order_id = o.id
    WHERE o.status = 'paid' AND o.station = ? AND i.sends_to_kitchen = 1 AND i.kitchen_ready_at >= ?`).all(station, since);
  const orders = attachItems(recent).map((o) => {
    const kitchen = o.items.filter((i) => i.sends_to_kitchen && i.qty > 0);
    const ready = kitchen.filter((i) => i.kitchen_ready_at >= since)
      .map((i) => ({ name: i.name, qty: i.qty, note: i.note || null, keys: unitKeys(`item:${i.id}`, i.qty), ready_at: i.kitchen_ready_at }));
    return group(`order:${o.id}`, o.table_name ?? 'Takeout', o.receipt_label, kitchen.reduce((n, i) => n + i.qty, 0), ready);
  });
  if (station !== 'cashier' || currentStore() !== 'ambiente') return orders.filter(Boolean).sort((a, b) => a.ready_at.localeCompare(b.ready_at));
  // Older tab records have no time per line; their finished ticket's time stands in.
  const visits = db.prepare(`SELECT document FROM dining_visits WHERE EXISTS (SELECT 1 FROM json_each(document, '$.submissions') s
    WHERE json_extract(s.value, '$.ready_at') >= ?1 OR EXISTS (SELECT 1 FROM json_each(s.value, '$.lines') l WHERE json_extract(l.value, '$.ready_at') >= ?1))`).all(since).map((r) => JSON.parse(r.document));
  const tables = visits.flatMap((v) => v.submissions.filter((s) => !s.cancelled_at && ticketState(s) !== 'cancelled').map((s) => {
    const kitchen = s.lines.filter((l) => l.sends_to_kitchen && l.qty > 0);
    const ready = kitchen.map((l) => ({ l, at: l.ready_at ?? s.ready_at })).filter(({ l, at }) => l.ready_qty > 0 && at >= since)
      .map(({ l, at }) => ({ name: l.name, qty: Math.min(l.ready_qty, l.qty), note: l.note || null, keys: unitKeys(`line:${l.id}`, Math.min(l.ready_qty, l.qty)), ready_at: at }));
    return group(`table:${s.id}`, v.table_name, null, kitchen.reduce((n, l) => n + l.qty, 0), ready);
  }));
  return [...orders, ...tables].filter(Boolean).sort((a, b) => a.ready_at.localeCompare(b.ready_at));
}
app.get('/api/pos/ready', (req, res) => res.json(readyForPickup(stationOf(req, req.query.station))));
// Tells the tills to reload their ready-to-collect list.
export const announcePickup = () => storeBroadcast(['pos', 'barista']).emit('pickup.updated');

// Kitchen display: today's tickets not yet finished, oldest first. Tickets left open on earlier days
// aren't shown, so forgotten ones never push today's orders off the screen.
app.get('/api/kitchen/tickets', (req, res) => {
  const [from] = dayRange();
  const open = db
    .prepare("SELECT * FROM orders WHERE kitchen_status IN ('new', 'preparing') AND status = 'paid' AND created_at >= ? ORDER BY id")
    .all(from);
  res.json(attachItems(open));
});

// Kitchen -> server: move a ticket along (new -> preparing -> ready).
app.patch('/api/orders/:id/kitchen', requireRole('kitchen'), (req, res) => {
  const { status } = req.body ?? {};
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const now = new Date().toISOString();
  if (status === 'preparing' && order.kitchen_status === 'new') {
    // "Start all": every item on the ticket starts cooking.
    db.prepare("UPDATE orders SET kitchen_status = 'preparing', kitchen_started_at = ? WHERE id = ?").run(now, order.id);
    db.prepare('UPDATE order_items SET kitchen_started_at = COALESCE(kitchen_started_at, ?) WHERE order_id = ? AND sends_to_kitchen = 1').run(now, order.id);
  } else if (status === 'ready' && ['new', 'preparing'].includes(order.kitchen_status)) {
    db.prepare(
      "UPDATE orders SET kitchen_status = 'ready', kitchen_started_at = COALESCE(kitchen_started_at, ?), kitchen_ready_at = ? WHERE id = ?"
    ).run(now, now, order.id);
    db.prepare('UPDATE order_items SET kitchen_started_at = COALESCE(kitchen_started_at, ?), kitchen_ready_at = COALESCE(kitchen_ready_at, ?) WHERE order_id = ? AND sends_to_kitchen = 1').run(now, now, order.id);
  } else {
    return res.status(409).json({ error: `Cannot move ticket from ${order.kitchen_status} to ${status}` });
  }

  if(status==='ready')db.prepare('UPDATE order_items SET ready_qty = qty WHERE order_id = ? AND sends_to_kitchen = 1').run(order.id);
  const updated = loadOrder(order.id);
  storeBroadcast(['kitchen', 'admin']).emit('ticket.updated', updated);
  if ((updated.kitchen_status === 'ready') !== (order.kitchen_status === 'ready')) announcePickup();
  res.json(updated);
});

// Kitchen -> server: move one item along: waiting -> cooking -> ready (or back, if tapped by mistake).
// Body { state: 'waiting' | 'cooking' | 'ready' }; the older { ready: true/false } still works.
// The ticket counts as started once any item is, and is finished when the last item is ready.
app.patch('/api/orders/:id/items/:itemId/kitchen', requireRole('kitchen'), (req, res) => {
  const state = typeof req.body?.ready === 'boolean' ? (req.body.ready ? 'ready' : 'waiting') : req.body?.state;
  if (!['waiting', 'cooking', 'ready'].includes(state)) return res.status(400).json({ error: 'state must be waiting, cooking or ready' });
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'paid'").get(Number(req.params.id));
  if (!order || !['new', 'preparing'].includes(order.kitchen_status)) return res.status(409).json({ error: 'This ticket is no longer open' });
  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ? AND sends_to_kitchen = 1').get(Number(req.params.itemId), order.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this ticket' });

  const now = new Date().toISOString();
  db.exec('SAVEPOINT feature_write');
  try {
    const started = state === 'waiting' ? null : item.kitchen_started_at ?? now;
    db.prepare('UPDATE order_items SET kitchen_started_at = ?, kitchen_ready_at = ? WHERE id = ?').run(started, state === 'ready' ? now : null, item.id);
    db.prepare('UPDATE order_items SET ready_qty = ? WHERE id = ?').run(state === 'ready' ? item.qty : 0, item.id);
    const counts = db.prepare(
      `SELECT SUM(kitchen_ready_at IS NULL) AS waiting, SUM(kitchen_started_at IS NOT NULL OR kitchen_ready_at IS NOT NULL) AS touched
         FROM order_items WHERE order_id = ? AND sends_to_kitchen = 1`
    ).get(order.id);
    if (!counts.waiting) {
      db.prepare("UPDATE orders SET kitchen_status = 'ready', kitchen_started_at = COALESCE(kitchen_started_at, ?), kitchen_ready_at = ? WHERE id = ?").run(now, now, order.id);
    } else if (counts.touched) {
      db.prepare("UPDATE orders SET kitchen_status = 'preparing', kitchen_started_at = COALESCE(kitchen_started_at, ?) WHERE id = ?").run(now, order.id);
    } else {
      db.prepare("UPDATE orders SET kitchen_status = 'new', kitchen_started_at = NULL WHERE id = ?").run(order.id);
    }
    db.exec('RELEASE feature_write');
  } catch (err) {
    db.exec('ROLLBACK TO feature_write; RELEASE feature_write');
    throw err;
  }

  const updated = loadOrder(order.id);
  storeBroadcast(['kitchen', 'admin']).emit('ticket.updated', updated);
  // The till hears about every item that becomes ready (or is taken back), not just finished orders.
  if (Boolean(item.kitchen_ready_at) !== (state === 'ready')) announcePickup();
  res.json(updated);
});
