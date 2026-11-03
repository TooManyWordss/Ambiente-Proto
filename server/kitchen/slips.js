import { answeringScreens, handToTill, io } from '../core/http.js';
import { currentStore } from '../core/config.js';

// A waiter's order, once it's saved: the drinks print at the till (there's no barista screen; drink slips go
// with the till's prints), and the food too when no kitchen screen is up to print it. If no till takes them,
// the waiters' panels are told, so the waiter can tell the cashier.
export async function printWaiterSlips(order, store = currentStore()) {
  const lines = (at) => order.items.filter((i) => i.sends_to_kitchen && (i.station ?? 'kitchen') === at && i.qty > 0);
  const kitchenUp = (await answeringScreens(['kitchen'], store)).kitchen > 0;
  const slips = ['barista', ...(kitchenUp ? [] : ['kitchen'])].filter((at) => lines(at).length).map((prep) => ({
    prep, label: order.receipt_label ?? String(order.receipt_no), table_name: order.table_name ?? null, guests: order.guests ?? null,
    created_at: order.created_at, items: lines(prep).map((i) => ({ qty: i.qty, name: i.name, note: i.note || null })),
  }));
  if (!slips.length || await handToTill({ slips }, store)) return;
  io.to(`${store}:barista`).emit('slips.unprinted', { label: slips[0].label, table_name: order.table_name, preps: slips.map((s) => s.prep) });
}
