import { requireRole, stationOf } from '../auth/sessions.js';
import { currentStore } from '../core/config.js';
import { db } from '../core/db.js';
import { dayRange } from '../core/dates.js';
import { attachItems, loadOrder } from '../sales/orders.js';
import { answeringScreens, app, handToTill, storeBroadcast } from '../core/http.js';
import { ticketState } from '../../dining-domain.js';

// ---------- Kitchen ----------

// How many kitchen and barista screens answer right now. A station with none gets its paper slip from
// the till. It sits under /api/pos because everything under /api/kitchen is for the station screens only.
app.get('/api/pos/kitchen-screens', async (req, res) => {
  const open = await answeringScreens(['kitchen', 'barista']);
  res.json({ screens: open.kitchen, barista: open.barista });
});

// A station tablet whose printer is off, unpaired or out of reach sends the slips it couldn't print; a till
// prints them instead. 503 when no till is open to take them, and the station keeps them waiting.
app.post('/api/kitchen/takeover', requireRole('kitchen', 'barista'), async (req, res) => {
  const slips = req.body?.slips, prep = req.role === 'barista' ? 'barista' : 'kitchen';
  if (!Array.isArray(slips) || !slips.length || slips.length > 50 || !slips.every((s) => s && Array.isArray(s.items))) return res.status(400).json({ error: 'Send the slips to print' });
  const clean = slips.map((s) => ({ label: String(s.label ?? '').slice(0, 40), table_name: s.table_name == null ? null : String(s.table_name).slice(0, 60), guests: Number.isInteger(s.guests) ? s.guests : null, created_at: typeof s.created_at === 'string' ? s.created_at : null, banner: typeof s.banner === 'string' ? s.banner.slice(0, 40) : undefined, late: !!s.late, prep,
    items: s.items.slice(0, 100).map((i) => ({ qty: Number(i.qty) || 0, name: String(i.name ?? '').slice(0, 120), note: i.note ? String(i.note).slice(0, 300) : null })) }));
  if (!(await handToTill({ slips: clean }))) return res.status(503).json({ error: 'No till is open to print them' });
  res.json({ ok: true });
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
    WHERE o.status IN ('paid', 'open') AND o.station = ? AND i.sends_to_kitchen = 1 AND i.kitchen_ready_at >= ?`).all(station, since);
  const orders = attachItems(recent).map((o) => {
    const kitchen = o.items.filter((i) => i.sends_to_kitchen && i.qty > 0);
    const ready = kitchen.filter((i) => i.kitchen_ready_at >= since)
      .map((i) => ({ name: i.name, qty: i.qty, note: i.note || null, from: i.station ?? 'kitchen', keys: unitKeys(`item:${i.id}`, i.qty), ready_at: i.kitchen_ready_at }));
    return group(`order:${o.id}`, o.table_name ?? 'Takeout', o.receipt_label, kitchen.reduce((n, i) => n + i.qty, 0), ready);
  });
  if (station !== 'cashier' || currentStore() !== 'ambiente') return orders.filter(Boolean).sort((a, b) => a.ready_at.localeCompare(b.ready_at));
  // Older tab records have no time per line; their finished ticket's time stands in.
  const visits = db.prepare(`SELECT document FROM dining_visits WHERE EXISTS (SELECT 1 FROM json_each(document, '$.submissions') s
    WHERE json_extract(s.value, '$.ready_at') >= ?1 OR EXISTS (SELECT 1 FROM json_each(s.value, '$.lines') l WHERE json_extract(l.value, '$.ready_at') >= ?1))`).all(since).map((r) => JSON.parse(r.document));
  const tables = visits.flatMap((v) => v.submissions.filter((s) => !s.cancelled_at && ticketState(s) !== 'cancelled').map((s) => {
    const kitchen = s.lines.filter((l) => l.sends_to_kitchen && l.qty > 0);
    const ready = kitchen.map((l) => ({ l, at: l.ready_at ?? s.ready_at })).filter(({ l, at }) => l.ready_qty > 0 && at >= since)
      .map(({ l, at }) => ({ name: l.name, qty: Math.min(l.ready_qty, l.qty), note: l.note || null, from: l.station ?? 'kitchen', keys: unitKeys(`line:${l.id}`, Math.min(l.ready_qty, l.qty)), ready_at: at }));
    return group(`table:${s.id}`, v.table_name, null, kitchen.reduce((n, l) => n + l.qty, 0), ready);
  }));
  return [...orders, ...tables].filter(Boolean).sort((a, b) => a.ready_at.localeCompare(b.ready_at));
}
app.get('/api/pos/ready', (req, res) => res.json(readyForPickup(stationOf(req, req.query.station))));
// Tells the tills to reload their ready-to-collect list.
export const announcePickup = () => storeBroadcast(['pos', 'barista']).emit('pickup.updated');

// Which station a screen is: the barista's drinks display, or the kitchen. Older lines without one are the kitchen's.
const stationOfScreen = (req) => (req.role === 'barista' || req.query?.station === 'barista' || req.body?.station === 'barista' ? 'barista' : 'kitchen');
const ON_STATION = "COALESCE(station, 'kitchen') = ?";

// Kitchen or barista display: today's tickets with something still to make there, oldest first. Tickets left
// open on earlier days aren't shown, so forgotten ones never push today's orders off the screen.
app.get('/api/kitchen/tickets', (req, res) => {
  const [from] = dayRange();
  const open = db
    .prepare(`SELECT * FROM orders o WHERE kitchen_status IN ('new', 'preparing') AND status IN ('paid', 'open') AND created_at >= ?
      AND EXISTS (SELECT 1 FROM order_items WHERE order_id = o.id AND sends_to_kitchen = 1 AND qty > 0 AND kitchen_ready_at IS NULL AND ${ON_STATION}) ORDER BY id`)
    .all(from, stationOfScreen(req));
  res.json(attachItems(open));
});

// After a station moves items along, the order is new until something starts, preparing while anything is
// left to make (at either station), and ready when the last item is.
function settleTicket(order, now) {
  const counts = db.prepare(
    `SELECT SUM(kitchen_ready_at IS NULL) AS waiting, SUM(kitchen_started_at IS NOT NULL OR kitchen_ready_at IS NOT NULL) AS touched
       FROM order_items WHERE order_id = ? AND sends_to_kitchen = 1`
  ).get(order.id);
  if (!counts.waiting) db.prepare("UPDATE orders SET kitchen_status = 'ready', kitchen_started_at = COALESCE(kitchen_started_at, ?), kitchen_ready_at = ? WHERE id = ?").run(now, now, order.id);
  else if (counts.touched) db.prepare("UPDATE orders SET kitchen_status = 'preparing', kitchen_started_at = COALESCE(kitchen_started_at, ?) WHERE id = ?").run(now, order.id);
  else db.prepare("UPDATE orders SET kitchen_status = 'new', kitchen_started_at = NULL WHERE id = ?").run(order.id);
}

// Kitchen or barista -> server: start or finish everything on a ticket that is made at that station.
app.patch('/api/orders/:id/kitchen', requireRole('kitchen', 'barista'), (req, res) => {
  const { status } = req.body ?? {}, station = stationOfScreen(req);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!['new', 'preparing'].includes(order.kitchen_status) || !['preparing', 'ready'].includes(status)) {
    return res.status(409).json({ error: `Cannot move ticket from ${order.kitchen_status} to ${status}` });
  }

  const now = new Date().toISOString(), mine = `order_id = ? AND sends_to_kitchen = 1 AND ${ON_STATION}`;
  db.exec('SAVEPOINT ticket_write');
  try {
    // "Start all" starts this station's items; "All done" finishes them.
    db.prepare(`UPDATE order_items SET kitchen_started_at = COALESCE(kitchen_started_at, ?) WHERE ${mine}`).run(now, order.id, station);
    if (status === 'ready') db.prepare(`UPDATE order_items SET kitchen_ready_at = COALESCE(kitchen_ready_at, ?), ready_qty = qty WHERE ${mine}`).run(now, order.id, station);
    settleTicket(order, now);
    db.exec('RELEASE ticket_write');
  } catch (err) {
    db.exec('ROLLBACK TO ticket_write; RELEASE ticket_write');
    throw err;
  }
  const updated = loadOrder(order.id);
  storeBroadcast(['kitchen', 'barista', 'admin']).emit('ticket.updated', updated);
  if (status === 'ready') announcePickup();
  res.json(updated);
});

// Kitchen -> server: move one item along: waiting -> cooking -> ready (or back, if tapped by mistake).
// Body { state: 'waiting' | 'cooking' | 'ready' }; the older { ready: true/false } still works.
// The ticket counts as started once any item is, and is finished when the last item is ready.
app.patch('/api/orders/:id/items/:itemId/kitchen', requireRole('kitchen', 'barista'), (req, res) => {
  const state = typeof req.body?.ready === 'boolean' ? (req.body.ready ? 'ready' : 'waiting') : req.body?.state;
  if (!['waiting', 'cooking', 'ready'].includes(state)) return res.status(400).json({ error: 'state must be waiting, cooking or ready' });
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status IN ('paid', 'open')").get(Number(req.params.id));
  if (!order || !['new', 'preparing'].includes(order.kitchen_status)) return res.status(409).json({ error: 'This ticket is no longer open' });
  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ? AND sends_to_kitchen = 1').get(Number(req.params.itemId), order.id);
  if (!item) return res.status(404).json({ error: 'Item not found on this ticket' });

  const now = new Date().toISOString();
  db.exec('SAVEPOINT feature_write');
  try {
    const started = state === 'waiting' ? null : item.kitchen_started_at ?? now;
    db.prepare('UPDATE order_items SET kitchen_started_at = ?, kitchen_ready_at = ? WHERE id = ?').run(started, state === 'ready' ? now : null, item.id);
    db.prepare('UPDATE order_items SET ready_qty = ? WHERE id = ?').run(state === 'ready' ? item.qty : 0, item.id);
    settleTicket(order, now);
    db.exec('RELEASE feature_write');
  } catch (err) {
    db.exec('ROLLBACK TO feature_write; RELEASE feature_write');
    throw err;
  }

  const updated = loadOrder(order.id);
  storeBroadcast(['kitchen', 'barista', 'admin']).emit('ticket.updated', updated);
  // The till hears about every item that becomes ready (or is taken back), not just finished orders.
  if (Boolean(item.kitchen_ready_at) !== (state === 'ready')) announcePickup();
  res.json(updated);
});
