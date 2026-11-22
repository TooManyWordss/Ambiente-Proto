import { menuCatalog } from '../../menu-catalog.js';
import { currentStore } from '../core/config.js';
import { db } from '../core/db.js';
import { getSetting, setSetting } from '../core/settings.js';

// Apply the supplied menu once to existing databases. Keep retired rows for old receipts.
export function seedMenu() {
const menuVersion = getSetting('menu_catalog_version', '');
if (currentStore() === 'rairock') return; // The owner will add RaiRock's menu when it is supplied.
if (menuVersion !== 'ambiente-2026-10-complete') {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (['ambiente-2026-10', 'ambiente-2026-10-oz'].includes(menuVersion)) {
      // Preserve IDs so carts and unsent offline sales still refer to the same choices.
      const rename = db.prepare("UPDATE menu_items SET name = ? WHERE name = ? AND category = ? AND price_cents = ? AND active = 1 AND status = 'approved'");
      for (const item of menuCatalog) {
        const oldName = item.name.replace('(12oz)', '(Doce)').replace('(16oz)', '(Grande)').replace('(20oz)', '(Venti)');
        if (oldName !== item.name) rename.run(item.name, oldName, item.category, item.priceCents);
      }
      // Extend the existing catalog without replacing IDs, availability, or staff additions.
      const exists = db.prepare('SELECT id FROM menu_items WHERE name = ? AND category = ?');
      const insert = db.prepare('INSERT INTO menu_items (name, category, price_cents, sends_to_kitchen) VALUES (?, ?, ?, ?)');
      for (const item of menuCatalog) {
        if (!exists.get(item.name, item.category)) insert.run(item.name, item.category, item.priceCents, item.sendsToKitchen);
      }
      db.prepare("UPDATE menu_items SET price_cents = 18100 WHERE name = 'Chocolate Cake' AND category = 'Desserts / Cakes / Pastries' AND price_cents = 17300 AND active = 1 AND status = 'approved'").run();
    } else {
      db.prepare("UPDATE menu_items SET active = 0, status = CASE WHEN status = 'pending' THEN 'rejected' ELSE status END WHERE active = 1 OR status = 'pending'").run();
      const insert = db.prepare('INSERT INTO menu_items (name, category, price_cents, sends_to_kitchen) VALUES (?, ?, ?, ?)');
      for (const item of menuCatalog) insert.run(item.name, item.category, item.priceCents, item.sendsToKitchen);
    }
    setSetting('menu_catalog_version', 'ambiente-2026-10-complete');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
// Steaks sold by weight (Oct 29, 2026): the Wagyu drops "(per gram)" from its name, keeping its ID.
if (getSetting('menu_weights_version', '') !== '2026-10-29') {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE menu_items SET name = 'Japanese Kobe A5 Wagyu Steak' WHERE name = 'Japanese Kobe A5 Wagyu Steak (per gram)' AND category = 'Beef / Chicken' AND active = 1").run();
    const weigh = db.prepare('UPDATE menu_items SET per_grams = ?, sizes = ? WHERE name = ? AND category = ? AND active = 1');
    for (const item of menuCatalog) if (item.perGrams) weigh.run(item.perGrams, item.sizes || null, item.name, item.category);
    setSetting('menu_weights_version', '2026-10-29');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
}
