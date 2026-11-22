import { db } from '../core/db.js';
import { attachItems } from '../sales/orders.js';
import { localDate } from '../core/dates.js';

// Floor-plan receipts are already paid. Group repeat orders for the same seating
// into one visit, without pretending that missing service timestamps were recorded.
export function floorMetricsVisits() {
  const orders = attachItems(db.prepare("SELECT * FROM orders WHERE table_id IS NOT NULL AND visit_id IS NULL AND status = 'paid' ORDER BY created_at, id").all());
  const visits = new Map();
  for (const order of orders) {
    const key = 'floor:' + order.table_id + ':' + (order.seated_at ?? order.id);
    let visit = visits.get(key);
    if (!visit) {
      visit = { id: key, status: 'settled', arrived_at: order.seated_at ?? order.created_at, first_order_at: order.created_at, settled_at: order.created_at, released_at: order.billed_out_at, guests: order.guests ?? 1, bill: { subtotal_cents: 0, discount_cents: 0 }, submissions: [] };
      visits.set(key, visit);
    }
    visit.guests = Math.max(visit.guests, order.guests ?? 1);
    visit.settled_at = order.created_at;
    visit.released_at = order.billed_out_at;
    visit.bill.subtotal_cents += order.subtotal_cents;
    visit.bill.discount_cents += order.discount_cents ?? 0;
    visit.submissions.push({ submitted_at: order.created_at, ready_at: order.kitchen_ready_at, lines: order.items });
  }
  return [...visits.values()];
}

// How much each table on the floor map was used over the last `days` days (1 = today): how many parties sat
// there, how many guests, and for how long (counted once the party has left). Counts floor-map seatings and tabs opened under Unpaid tabs;
// a tab's table is matched to the floor map by name, and tabs at tables not on the map are listed apart.
export function tableHeat(days, now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const since = from.toISOString(), minutes = (a, b) => a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : 0;
  const tables = db.prepare('SELECT id, name, seats FROM floor_tables WHERE active = 1 ORDER BY id').all()
    .map((t) => ({ ...t, seatings: 0, guests: 0, minutes: 0, timed: 0 }));
  const byId = new Map(tables.map((t) => [t.id, t])), byName = new Map(tables.map((t) => [t.name.toLowerCase(), t])), others = new Map();

  // Floor-map seatings: each party's receipts share the table and the time they sat down.
  const parties = new Map();
  for (const o of db.prepare("SELECT id, table_id, seated_at, created_at, guests, billed_out_at FROM orders WHERE table_id IS NOT NULL AND status = 'paid' AND COALESCE(seated_at, created_at) >= ?").all(since)) {
    const key = `${o.table_id}:${o.seated_at ?? o.id}`, party = parties.get(key) ?? { table_id: o.table_id, seated_at: o.seated_at ?? o.created_at, guests: 0, left_at: null };
    party.guests = Math.max(party.guests, o.guests ?? 1);
    party.left_at = o.billed_out_at ?? party.left_at;
    parties.set(key, party);
  }
  // `timed` counts the seatings whose leaving time is known, for the average stay.
  const add = (t, guests, mins) => { t.seatings += 1; t.guests += guests; t.minutes += mins; if (mins) t.timed += 1; };
  for (const p of parties.values()) { const t = byId.get(p.table_id); if (t) add(t, p.guests, minutes(p.seated_at, p.left_at)); }

  // Unpaid tabs (Café Ambiente's table service). Seatings that were reversed don't count.
  const visits = db.prepare("SELECT document FROM dining_visits WHERE json_extract(document, '$.arrived_at') >= ?").all(since).map((r) => JSON.parse(r.document));
  for (const v of visits.filter((v) => v.status !== 'cancelled')) {
    const name = String(v.table_name ?? ''), t = byName.get(name.toLowerCase()) ?? others.get(name) ?? { name, seats: null, seatings: 0, guests: 0, minutes: 0, timed: 0 };
    if (!byName.has(name.toLowerCase())) others.set(name, t);
    add(t, v.guests ?? 1, minutes(v.arrived_at, v.released_at ?? v.settled_at));
  }
  return { from: localDate(from), days, tables, others: [...others.values()] };
}
