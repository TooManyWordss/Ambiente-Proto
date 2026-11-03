import { STOCK_KEEPERS } from '../core/config.js';
import { db } from '../core/db.js';
import { logActivity } from '../sales/orders.js';
import { app, storeBroadcast } from '../core/http.js';
import { ROLE_LABEL } from '../passkeys/routes.js';

// ---------- Inventory ----------

import { announceStock, applyPrep, applyRecipes, inventoryItems, inventoryProblem, isLow, isQty, logStock, qtyText, roundQty } from './stock.js';
export { announceStock, applyRecipes } from './stock.js';

app.get('/api/inventory', (req, res) => res.json(inventoryItems()));

const KINDS = ['ingredient', 'portion', 'supply'];
const sectionOf = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : null;

// The owner adds an item with its current stock and the level to reorder at. The inspector (the inventory
// login) counts and edits what's there but doesn't add items.
app.post('/api/inventory/items', (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only the owner adds stock items. Ask the owner.' });
  const { name, unit, quantity, threshold, kind = 'ingredient' } = req.body ?? {};
  const problem = inventoryProblem({ name, unit });
  if (problem) return res.status(400).json({ error: problem });
  if (!isQty(quantity)) return res.status(400).json({ error: 'Enter how much is in stock now' });
  if (!isQty(threshold)) return res.status(400).json({ error: 'Enter the level to reorder at' });
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Choose ingredient, portion or supply' });
  const now = new Date().toISOString();
  const id = Number(db.prepare(
    `INSERT INTO inventory_items (name, unit, quantity, threshold, created_at, updated_at, updated_by, kind, section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name.trim(), unit.trim(), roundQty(quantity), roundQty(threshold), now, now, req.staff?.name ?? ROLE_LABEL[req.role], kind, sectionOf(req.body?.section)).lastInsertRowid);
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  logStock(req, item, 'added', item.quantity);
  announceStock(req, null, item);
  res.status(201).json({ ...item, low: isLow(item) });
});

// Staff update a stock level: a fresh count, a delivery received, portions prepped (which takes out
// the ingredients prepping them uses), or some used up or thrown away.
app.post('/api/inventory/:id/stock', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { kind, amount } = req.body ?? {};
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 140) : null;
  if (!['count', 'received', 'prepped', 'used'].includes(kind)) return res.status(400).json({ error: 'Choose count, received, prepped or used' });
  if (kind === 'prepped' && item.kind !== 'portion') return res.status(400).json({ error: `${item.name} isn't a portion the kitchen preps` });
  if (!isQty(amount) || (kind !== 'count' && amount === 0)) return res.status(400).json({ error: 'Enter an amount' });
  if (kind === 'used' && amount > item.quantity + 1e-9) {
    return res.status(400).json({ error: `Only ${qtyText(item)} recorded. Do a count instead if that's wrong.` });
  }

  const quantity = roundQty(kind === 'count' ? amount : kind === 'used' ? item.quantity - amount : item.quantity + amount);
  let announceIngredients = () => {};
  db.exec('SAVEPOINT stock_write');
  try {
    db.prepare('UPDATE inventory_items SET quantity = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(quantity, new Date().toISOString(), req.staff?.name ?? ROLE_LABEL[req.role], item.id);
    logStock(req, { ...item, quantity }, kind, quantity - item.quantity, note);
    if (kind === 'prepped') announceIngredients = applyPrep(req, item, amount, `Prepped ${roundQty(amount)} ${item.name}`);
    db.exec('RELEASE stock_write');
  } catch (err) {
    db.exec('ROLLBACK TO stock_write; RELEASE stock_write');
    throw err;
  }
  const updated = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(item.id);
  announceStock(req, item, updated);
  announceIngredients();
  res.json({ ...updated, low: isLow(updated) });
});

// Owner: everything in stock plus the latest changes.
app.get('/api/admin/inventory', (req, res) => {
  const log = db.prepare(
    `SELECT l.*, i.name, i.unit FROM inventory_log l JOIN inventory_items i ON i.id = l.item_id
      ORDER BY l.id DESC LIMIT 40`
  ).all();
  res.json({ items: inventoryItems(), log });
});

// The inspector or the owner sets the level an item is reordered at. Dropping below it alerts the owner.
app.patch('/api/inventory/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const threshold = req.body?.threshold;
  if (!isQty(threshold)) return res.status(400).json({ error: 'Enter the level to reorder at' });
  db.prepare('UPDATE inventory_items SET threshold = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(roundQty(threshold), new Date().toISOString(), req.staff?.name ?? ROLE_LABEL[req.role], item.id);
  const updated = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(item.id);
  if (updated.threshold !== item.threshold) logStock(req, updated, 'edited', 0, `Reorder level ${qtyText(item, item.threshold)} → ${qtyText(updated, updated.threshold)}`);
  announceStock(req, item, updated);
  res.json({ ...updated, low: isLow(updated) });
});

// Owner: rename, change the unit, the reorder level, the sheet section, or whether it's a portion.
app.patch('/api/admin/inventory/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const edited = { name: req.body?.name ?? item.name, unit: req.body?.unit ?? item.unit, threshold: req.body?.threshold ?? item.threshold, kind: req.body?.kind ?? item.kind ?? 'ingredient', section: 'section' in (req.body ?? {}) ? sectionOf(req.body.section) : item.section };
  const problem = inventoryProblem(edited, item.id);
  if (problem) return res.status(400).json({ error: problem });
  if (!isQty(edited.threshold)) return res.status(400).json({ error: 'Enter a valid reorder level' });
  if (!KINDS.includes(edited.kind)) return res.status(400).json({ error: 'Choose ingredient, portion or supply' });
  db.prepare('UPDATE inventory_items SET name = ?, unit = ?, threshold = ?, kind = ?, section = ? WHERE id = ?')
    .run(edited.name.trim(), edited.unit.trim(), roundQty(edited.threshold), edited.kind, edited.section, item.id);
  const updated = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(item.id);
  if (updated.threshold !== item.threshold) {
    logStock(req, updated, 'edited', 0, `Reorder level ${qtyText(item, item.threshold)} → ${qtyText(updated, updated.threshold)}`);
  }
  announceStock(req, item, updated);
  res.json({ ...updated, low: isLow(updated) });
});

// Owner: stop tracking an item. Its history stays.
app.delete('/api/admin/inventory/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND active = 1').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  db.prepare('UPDATE inventory_items SET active = 0 WHERE id = ?').run(item.id);
  logActivity(req, 'inventory.removed', `Stopped tracking ${item.name}`);
  storeBroadcast([...STOCK_KEEPERS, 'admin']).emit('inventory.updated', { ...item, active: 0 });
  res.json({ ok: true });
});

// Owner: what each menu item takes out of stock.
app.get('/api/admin/recipes', (req, res) => {
  res.json(db.prepare(
    `SELECT r.menu_item_id, r.inventory_item_id, r.qty, i.name, i.unit
       FROM menu_recipes r JOIN inventory_items i ON i.id = r.inventory_item_id
      WHERE i.active = 1 ORDER BY lower(i.name)`
  ).all());
});

// Owner: replace one menu item's recipe. An empty list means selling it no longer touches stock.
// An amount of 0 keeps the link but takes nothing out until the amount is entered.
app.put('/api/admin/recipes/:menuItemId', (req, res) => {
  const menuItem = db.prepare("SELECT * FROM menu_items WHERE id = ? AND active = 1 AND status = 'approved'").get(Number(req.params.menuItemId));
  if (!menuItem) return res.status(404).json({ error: 'Menu item not found' });
  const { ingredients } = req.body ?? {};
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: 'ingredients must be a list' });
  const rows = new Map();
  for (const { inventoryItemId, qty } of ingredients) {
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND active = 1').get(Number(inventoryItemId));
    if (!item) return res.status(400).json({ error: 'Stock item not found' });
    if (!isQty(qty)) return res.status(400).json({ error: `Enter how much ${item.name} one ${menuItem.name} uses` });
    rows.set(item.id, { item, qty: roundQty(qty) });
  }
  db.exec('SAVEPOINT feature_write');
  try {
    db.prepare('DELETE FROM menu_recipes WHERE menu_item_id = ?').run(menuItem.id);
    const insert = db.prepare('INSERT INTO menu_recipes (menu_item_id, inventory_item_id, qty) VALUES (?, ?, ?)');
    for (const { item, qty } of rows.values()) insert.run(menuItem.id, item.id, qty);
    const uses = [...rows.values()].map(({ item, qty }) => (qty ? qtyText(item, qty) + ' ' : '') + item.name).join(', ');
    logActivity(req, 'menu.recipe', `${menuItem.name} now uses ${uses || 'nothing from stock'}`);
    db.exec('RELEASE feature_write');
  } catch (err) {
    db.exec('ROLLBACK TO feature_write; RELEASE feature_write');
    throw err;
  }
  storeBroadcast('admin').emit('inventory.updated', {});
  res.json({ ok: true });
});

// Owner: what prepping one of each portion uses.
app.get('/api/admin/prep', (req, res) => {
  res.json(db.prepare(
    `SELECT p.portion_id, p.ingredient_id, p.qty, i.name, i.unit
       FROM prep_recipes p JOIN inventory_items i ON i.id = p.ingredient_id
      WHERE i.active = 1 ORDER BY lower(i.name)`
  ).all());
});

// Owner: replace what prepping one portion uses. An amount of 0 keeps the link, taking nothing out yet.
app.put('/api/admin/prep/:portionId', (req, res) => {
  const portion = db.prepare("SELECT * FROM inventory_items WHERE id = ? AND active = 1 AND kind = 'portion'").get(Number(req.params.portionId));
  if (!portion) return res.status(404).json({ error: 'Portion not found' });
  const { ingredients } = req.body ?? {};
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: 'ingredients must be a list' });
  const rows = new Map();
  for (const { inventoryItemId, qty } of ingredients) {
    const item = db.prepare('SELECT * FROM inventory_items WHERE id = ? AND active = 1').get(Number(inventoryItemId));
    if (!item) return res.status(400).json({ error: 'Stock item not found' });
    if (item.id === portion.id) return res.status(400).json({ error: `${portion.name} can't use itself` });
    if (!isQty(qty)) return res.status(400).json({ error: `Enter how much ${item.name} one ${portion.name} uses` });
    rows.set(item.id, { item, qty: roundQty(qty) });
  }
  db.exec('SAVEPOINT feature_write');
  try {
    db.prepare('DELETE FROM prep_recipes WHERE portion_id = ?').run(portion.id);
    const insert = db.prepare('INSERT INTO prep_recipes (portion_id, ingredient_id, qty) VALUES (?, ?, ?)');
    for (const { item, qty } of rows.values()) insert.run(portion.id, item.id, qty);
    const uses = [...rows.values()].map(({ item, qty }) => (qty ? qtyText(item, qty) + ' ' : '') + item.name).join(', ');
    logActivity(req, 'inventory.prep', `Prepping ${portion.name} now uses ${uses || 'nothing from stock'}`);
    db.exec('RELEASE feature_write');
  } catch (err) {
    db.exec('ROLLBACK TO feature_write; RELEASE feature_write');
    throw err;
  }
  storeBroadcast([...STOCK_KEEPERS, 'admin']).emit('inventory.updated', {});
  res.json({ ok: true });
});

// Cashier or barista: mark an item unavailable (sold out, machine down…) or available again.
// Every till sees it straight away.
app.post('/api/menu/:id/availability', (req, res) => {
  const item = db.prepare("SELECT * FROM menu_items WHERE id = ? AND active = 1 AND status = 'approved'").get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { available } = req.body ?? {};
  if (typeof available !== 'boolean') return res.status(400).json({ error: 'available must be true or false' });
  if (available === (item.unavailable_since === null)) return res.json({ id: item.id, available });
  db.prepare('UPDATE menu_items SET unavailable_since = ? WHERE id = ?').run(available ? null : new Date().toISOString(), item.id);
  logActivity(req, available ? 'menu.available' : 'menu.unavailable', `Marked ${item.name} ${available ? 'available again' : 'unavailable'}`);
  storeBroadcast(['pos', 'barista', 'admin']).emit('menu.updated');
  res.json({ id: item.id, available });
});
