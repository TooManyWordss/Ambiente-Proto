import { currentStore } from '../core/config.js';
import { db } from '../core/db.js';
import { getSetting, setSetting } from '../core/settings.js';

// Café Ambiente's paper inventory sheets (Oct 2026), section by section, as [name, unit]. Names follow the
// sheets so staff find them the same way; plain misspellings are corrected (Butler → Butter).
const SHEETS = [
  ['Spices & market', 'ingredient', [
    ['Celery', 'g'], ['Red Onion', 'g'], ['White Onion', 'g'], ['Luy-a', 'g'], ['Ahos', 'g'], ['Parsley', 'g'], ['Lime', 'pcs'],
    ['Basil', 'g'], ['Mint', 'g'], ['Green Bell Pepper', 'g'], ['Red Bell Pepper', 'g'], ['Atsal', 'g'], ['Tanglad', 'pcs'],
    ['Kamatis', 'g'], ['Dahunan', 'g'], ['Biyasong', 'pcs'], ['Guso', 'g'], ['Uling', 'sack'], ['Amihan', 'kg'], ['Aswete', 'pck'],
    ['Sili', 'g'], ['S-Spada', 'g'],
  ]],
  ['Vegetables', 'ingredient', [
    ['Radish', 'g'], ['Bionda', 'g'], ['Romaine', 'g'], ['Pipino', 'g'], ['Carrots', 'g'], ['Lettuce', 'g'], ['C-Pitchay', 'g'],
    ['Cabbage', 'g'], ['Cauli', 'g'], ['Mais', 'pcs'], ['Talong', 'g'], ['Lemon', 'g'], ['Patatas', 'g'], ['Kamote', 'g'],
  ]],
  ['Groceries', 'ingredient', [
    ['W-Peeled Tomato', 'can'], ['Century Tuna', 'can'], ['Coconut Milk', 'can'], ['W-Corn Kernel', 'can'], ['Mushroom', 'can'],
    ['Alpine', 'can'], ['Nestle Cream', 'pck'], ['Flour', 'pck'], ['Corn Starch', 'pck'], ['Gardenia', 'pck'], ['Olive Oil', 'gal'],
    ['Veg. Oil', 'gal'], ['Toyo', 'gal'], ['Oyster Sauce', 'gal'], ['Catsup', 'gal'], ['Liquid Seasoning', 'gal'], ['Tuba', 'L'],
    ['Lea & Perrins', 'btl'], ['Patis', 'btl'], ['Rice Wine', 'btl'], ['Truffle Oil', 'btl'], ['B-Olives', 'btl'], ['G-Olives', 'btl'],
    ['Honey', 'btl'], ['Capers', 'btl'], ['Hoisin', 'btl'], ['Garlic Powder', 'btl'], ['F-Chicken', 'btl'], ['Paprika', 'btl'],
    ['Cayenne', 'btl'], ['Ginger Powder', 'btl'], ['Oregano', 'btl'], ['Onion Powder', 'btl'], ['Cinnamon', 'btl'], ['Cloves', 'btl'],
    ['Thyme Leaves (btl)', 'btl'], ['Rosemary (btl)', 'btl'], ['Basil (dried)', 'btl'], ['Anchovies', 'btl'], ['Biscott', 'pck'],
    ['Bread Crumbs', 'pck'],
    ['Fusilli', 'pck'], ['Macaroni', 'pck'], ['Penne', 'pck'], ['Pesto', 'btl'], ['Fettuccine', 'pck'], ['Spaghetti Pasta', 'pck'],
    ['Tomato Sauce', 'can'], ['Nacho Cheese', 'can'], ['Jalapeños', 'btl'], ['Rock Salt', 'kg'], ['Lemon Powder', 'pck'],
    ['Pistachio', 'pck'], ['Truffle Mayo', 'btl'], ['Dijon Mustard', 'btl'], ['Real Mayonnaise', 'tub'], ['Red Hot', 'gal'],
    ['Parmesan', 'pck'], ['Mozzarella', 'bar'], ['Cheddar Cheese', 'bar'], ['Quickmelt', 'bar'], ['Eden', 'bar'], ['Butter', 'bar'],
    ['Grana Padano', 'pck'], ['Parmesan (bar)', 'bar'], ['White Choco', 'bar'], ['Dark Choco', 'bar'], ['Bread Flour', 'pck'],
    ['Cake Flour', 'pck'], ['Baking Powder', 'pck'], ['Super Red', 'btl'], ['Premium Mix Mushroom', 'pck'], ['W-Pepper', 'pck'],
    ['Tomato Paste', 'btl'], ['C-Spice', 'btl'], ['Sukang Iloko', 'btl'], ['Red Wine Vinegar', 'btl'], ['Thyme Leaves (pck)', 'pck'],
    ['Rosemary Leaves (pck)', 'pck'], ['Sotanghon', 'pck'], ['C-Stocks', 'can'], ['P-Juice', 'can'],
    ['Corn Flakes', 'pck'], ['Carbonara', 'pck'], ['C-of Mushroom', 'pck'], ['Bay Leaves', 'pck'], ['B-Stock', 'pck'],
    ['Black Fungus', 'pck'], ['MSG', 'pck'], ['Iodized Salt', 'pck'], ['W-Black Pepper', 'pck'], ['Xanthan Gum', 'pck'],
    ['Shiitake Mushroom', 'pck'], ['Egg', 'pcs'], ['White Sugar', 'kg'], ['B-Sugar', 'kg'], ['Confectioner Sugar', 'pck'],
    ['Vanilla Ice Cream', 'box'], ['Beetroot', 'g'], ['Cream Cheese', 'bar'], ['Sesame Seeds', 'pck'], ['May Wine', 'btl'],
    ['Nutmeg Powder', 'btl'],
  ]],
  ['Supplies', 'supply', [
    ['Vacuum Bag 20x25', 'pck'], ['Vacuum Bag 20x30', 'pck'], ['Vacuum Bag Small', 'pck'], ['Vacuum Bag Transparent', 'pck'],
    ['Whipping Bag', 'bag'], ['Foil', 'roll'], ['Wax Paper', 'roll'], ['Gloves', 'box'], ['Cling Wrap', 'roll'], ['Microwavable', 'pck'],
    ['Cocktail Toothpick', 'pck'], ['Scotch Brite', 'pcs'], ['Axion', 'pck'], ['Take Out Box', 'pck'], ['Target', 'pcs'],
  ]],
  ['Beef', 'portion', [['Putanesca / Mushroom', 'pcs'], ['Artisanal Meatballs', 'pcs'], ['Beef Belly Steak', 'pcs']]],
  ['Chicken', 'portion', [
    ['Chicken Kebab', 'pcs'], ['Adobo Sal', 'pcs'], ['Cheesy Fried Chicken', 'pcs'], ['BBQ / Spice Chicken', 'pcs'], ['Fried Chicken', 'pcs'],
    ['Popcorn', 'pcs'], ['Chicken Strips', 'pcs'], ['Drum Stick', 'pcs'], ['Wings', 'pcs'],
  ]],
  ['Steak', 'portion', [['AS Ribeye', 'pcs'], ['USDA Prime', 'pcs'], ['Demkota', 'pcs'], ['Japanese Wagyu', 'pcs']]],
  ['Seafood', 'portion', [
    ['Squid', 'pcs'], ['Calamari', 'pcs'], ['Camaron', 'pcs'], ['Waray', 'pcs'], ['Salmon', 'pcs'], ['Tuna Belly', 'pcs'],
    ['Roasted Shrimp', 'pcs'], ['Seafood Sotanghon', 'pcs'], ['Marinara / Seafood Pasta', 'pcs'], ['Shrimp Pasta', 'pcs'], ['Shrimp Pasta 2', 'pcs'],
    ['Fried Shrimp', 'pcs'],
  ]],
  ['Burgers', 'portion', [['Angus Patty', 'pcs'], ['Fried Chicken Burger', 'pcs']]],
  ['Pica-pica', 'portion', [
    ['Fiesta Strips', 'pcs'], ['Danish', 'pcs'], ['Cinnamon Roll', 'pcs'], ['Croissants', 'pcs'], ['Chocolat', 'pcs'], ['Veg. Kebab', 'pcs'],
    ['Biscoff Sandwich', 'pcs'], ['Ambiente Bruschetta', 'pcs'], ['Coffee Mousse', 'pcs'], ['Chips and Dip', 'pcs'], ['Fries', 'kg'],
    ['Sweet Corn', 'pcs'], ['Mozzarella Sticks', 'pcs'], ['Steam Salmon', 'pcs'],
  ]],
];

// Only the links that are clear from the names. Anything unclear stays unlinked for the owner to link
// on the recipe screen (AS Ribeye, Demkota, Japanese Wagyu, Marinara / Seafood Pasta, the two shrimp pasta
// rows, and most raw ingredients, whose dishes depend on the kitchen's recipes).
// [stock item, amount per dish, dishes]. A portion is 1 per dish; 0 means linked, amount not entered yet.
const DISHES = [
  ['Putanesca / Mushroom', 1, ['Beef Puttanesca', 'Beef and Mushroom']],
  ['Artisanal Meatballs', 1, ['Spaghetti and Artisanal Meatballs']],
  ['Chicken Kebab', 1, ['Spicy Chicken Kebab']],
  ['Adobo Sal', 1, ['Chicken Adobo-sal (Adobo - Inasal)']],
  ['Cheesy Fried Chicken', 1, ['Cheesy Crispy Fried Chicken']],
  ['BBQ / Spice Chicken', 1, ['Grilled BBQ Chicken', 'Spicy Grilled Chicken']],
  ['Fried Chicken', 1, ['Ambiente Style Fried Chicken']],
  ['Popcorn', 1, ['Truffle Chicken Popcorn']],
  ['Chicken Strips', 1, ['Chicken Strips']],
  ['Wings', 1, ['Spicy Chicken Wings']],
  ['USDA Prime', 1, ['USDA Prime Striploin']],
  ['Squid', 1, ['Char Grilled Squid']],
  ['Calamari', 1, ['Fried Calamari']],
  ['Camaron', 1, ['Camaron Rebosado']],
  ['Waray', 1, ['Kinilaw Waray']],
  ['Salmon', 1, ['Crispy Skin Salmon']],
  ['Tuna Belly', 1, ['Grilled Tuna Belly']],
  ['Roasted Shrimp', 1, ['Whole Roasted Garlic Butter Shrimps']],
  ['Seafood Sotanghon', 1, ['Seafood Sotanghon']],
  ['Angus Patty', 1, ['Classic American Angus Cheese Burger']],
  ['Fried Chicken Burger', 1, ['Spicy Fried Chicken Burger']],
  ['Fiesta Strips', 1, ['Fiesta Strips']],
  ['Danish', 1, ['Ensaymada Danish']],
  ['Cinnamon Roll', 1, ['Roasted Cinnamon Croissant Roll']],
  ['Croissants', 1, ['Croissant', 'Croissant Caprese Sandwich']],
  ['Chocolat', 1, ['Pain Au Chocolat']],
  ['Coffee Mousse', 1, ['Salted Caramel Coffee Mousse']],
  ['Chips and Dip', 1, ['Chips and Dip']],
  ['Sweet Corn', 1, ['Char Grilled Sweet Corn']],
  ['Mozzarella Sticks', 1, ['Mozzarella Sticks']],
  ['Steam Salmon', 1, ['Steamed Salmon']],
  ['Fries', 0, ['French Fries', 'Truffle Parmesan Fries']],
  ['Spaghetti Pasta', 0, ['Spicy Spaghetti Marinara', 'Slow Cooked Spaghetti Bolognese', 'Spaghetti Seafood Marinara', 'Spaghetti Seafood Pasta', 'Spaghetti Shrimp Pasta', 'Spaghetti and Artisanal Meatballs']],
  ['Fettuccine', 0, ['Fettuccine Alfredo Chicken']],
  ['Macaroni', 0, ['Baked Three Cheese Macaroni']],
  ['Penne', 0, ['Penne Chicken Pesto Pasta']],
  ['Pesto', 0, ['Penne Chicken Pesto Pasta', 'Clubhouse Classic / Pesto']],
  ['Romaine', 0, ['Smoked Caesar Salad']],
  ['Kamatis', 0, ['Tomato Soup', 'Croissant Caprese Sandwich']],
  ['Mozzarella', 0, ['Croissant Caprese Sandwich']],
  ['Parmesan', 0, ['Truffle Parmesan Fries']],
  ['C-of Mushroom', 0, ['Mushroom Soup']],
  ['Egg', 0, ['Kobe A5 Wagyu Egg Fried Rice']],
  ['Ahos', 0, ['1 Cup Garlic Rice']],
  ['Uling', 0, ['Char Grilled Sweet Corn', 'Char Grilled Squid', 'Char Grilled Japanese Wagyu Skewers']],
  ['Pistachio', 0, ['Pistachio Cake']],
  ['Cream Cheese', 0, ['Blueberry Cheesecake']],
];
// The owner's answers of 2026-11-03: the burgers take Angus patties (two in the Double), the pancit a drumstick,
// and two portions not on the sheets. The salad, cakes and drinks take nothing. Servers that loaded the sheets
// earlier get these once, without touching links the owner made or removed since.
const UPDATE_2026_11_03 = [
  ['Angus Patty', 1, ['Truffle Cheese Burger']],
  ['Angus Patty', 2, ['Double Cheese Burger']],
  ['Beef Belly Steak', 1, ['Beef Belly Steak']],
  ['Fried Shrimp', 1, ['Fried Shrimp Pasta']],
  ['Drum Stick', 1, ['Spicy Fried Chicken Kare-Kare Pancit']],
];
const NEW_2026_11_03 = ['Beef Belly Steak', 'Fried Shrimp'];
// What prepping a portion uses, where the portion's name says so. Amounts are entered later.
const PREP = [
  ['Seafood Sotanghon', ['Sotanghon']],
  ['Roasted Shrimp', ['Ahos', 'Butter']],
  ['Sweet Corn', ['Mais']],
];

// Every item starts at 100 in its unit, as the owner asked; the kitchen's next count sets the real figure.
const STARTING_STOCK = 100;

// Loads the sheets into Café Ambiente's inventory once, then each later update once. Items already in the
// inventory (same name) are kept as they are and linked, and links the owner already made are left alone.
export function seedInventory() {
  const version = getSetting('inventory_sheets_version', '');
  if (currentStore() !== 'ambiente' || version >= '2026-11-03') return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    const find = db.prepare('SELECT id FROM inventory_items WHERE lower(name) = lower(?) AND active = 1');
    const insert = db.prepare(
      `INSERT INTO inventory_items (name, unit, quantity, threshold, created_at, updated_at, updated_by, kind, section)
       VALUES (?, ?, ?, 0, ?, ?, 'Paper sheets', ?, ?)`
    );
    const label = db.prepare('UPDATE inventory_items SET kind = COALESCE(kind, ?), section = COALESCE(section, ?) WHERE id = ?');
    const log = db.prepare(
      `INSERT INTO inventory_log (item_id, at, actor, actor_name, kind, change, quantity_after, note)
       VALUES (?, ?, 'admin', 'Paper sheets', 'added', ?, ?, 'From the kitchen inventory sheets')`
    );
    const dish = db.prepare("SELECT id FROM menu_items WHERE name = ? AND active = 1 AND status = 'approved'");
    const link = db.prepare('INSERT OR IGNORE INTO menu_recipes (menu_item_id, inventory_item_id, qty) VALUES (?, ?, ?)');
    const ids = new Map();
    // Each sheet row (or only the named ones) as a stock item: found by name, or added at the starting count.
    const load = (only = null) => {
      for (const [section, kind, items] of SHEETS) {
        for (const [name, unit] of items) {
          if (only && !only.includes(name)) continue;
          let id = find.get(name)?.id;
          if (id) label.run(kind, section, id);
          else {
            id = Number(insert.run(name, unit, STARTING_STOCK, now, now, kind, section).lastInsertRowid);
            log.run(id, now, STARTING_STOCK, STARTING_STOCK);
          }
          ids.set(name, id);
        }
      }
    };
    const linkDishes = (list) => {
      for (const [item, qty, dishes] of list) {
        const id = ids.get(item) ?? find.get(item)?.id;
        for (const name of dishes) { const menuItem = dish.get(name); if (menuItem && id) link.run(menuItem.id, id, qty); }
      }
    };
    if (version < '2026-11-01') {
      load();
      linkDishes(DISHES);
      const prep = db.prepare('INSERT OR IGNORE INTO prep_recipes (portion_id, ingredient_id, qty) VALUES (?, ?, 0)');
      for (const [portion, ingredients] of PREP) for (const name of ingredients) prep.run(ids.get(portion), ids.get(name));
    } else load(NEW_2026_11_03);
    linkDishes(UPDATE_2026_11_03);
    setSetting('inventory_sheets_version', '2026-11-03');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
