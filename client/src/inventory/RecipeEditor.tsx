import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import { peso } from '../shared/format';
import type { InventoryItem, MenuItem, PrepRow, Recipe } from '../shared/types';
import { bySheet } from './Inventory';

// An amount left blank keeps the link but takes nothing out until it's entered.
type Row = { id: number; qty: string };
const amount = (qty: number, unit: string) => qty ? `${peso(qty)} ${unit}` : 'amount not set';
const toBody = (rows: Row[]) => rows.map(r => ({ inventoryItemId: r.id, qty: r.qty.trim() ? Number(r.qty) : 0 }));
const badAmount = (rows: Row[]) => rows.some(r => r.qty.trim() && !(Number(r.qty) >= 0));

// The stock items linked to one dish or portion, each with its amount, plus a picker to add more.
function Lines({ rows, setRows, stock, per, exclude }: { rows: Row[]; setRows: (f: (v: Row[]) => Row[]) => void; stock: InventoryItem[]; per: string; exclude?: number }) {
  const [adding, setAdding] = useState('');
  return <>
    <ul className="line-editor">{rows.map(r => { const s = stock.find(x => x.id === r.id); return <li key={r.id}><span>{s?.name}</span><span className="qty"><input inputMode="decimal" placeholder="amount" aria-label={`${s?.name} used per ${per}`} value={r.qty} onChange={e => setRows(v => v.map(x => x.id === r.id ? { ...x, qty: e.target.value } : x))}/> {s?.unit}</span><button type="button" className="link danger-link" onClick={() => setRows(v => v.filter(x => x.id !== r.id))}>Remove</button></li>; })}
      {!rows.length && <li className="hint">Nothing linked yet.</li>}</ul>
    <div className="add-row"><select aria-label="Add a stock item" value={adding} onChange={e => setAdding(e.target.value)}><option value="">Add a stock item…</option>{bySheet(stock.filter(s => s.id !== exclude && !rows.some(r => r.id === s.id))).map(([section, list]) => <optgroup label={section} key={section}>{list.map(s => <option key={s.id} value={s.id}>{s.name} ({s.unit})</option>)}</optgroup>)}</select><button type="button" className="btn" disabled={!adding} onClick={() => { const s = stock.find(x => x.id === Number(adding)); setRows(v => [...v, { id: Number(adding), qty: s?.kind === 'portion' ? '1' : '' }]); setAdding(''); }}>Add</button></div>
  </>;
}

// Owner: what selling one of each menu item takes out, e.g. one Spicy Chicken Kebab takes 1 Chicken Kebab portion.
export function RecipeEditor({ menu, stock, recipes, onSaved, notify }: { menu: MenuItem[]; stock: InventoryItem[]; recipes: Recipe[]; onSaved: () => void; notify: (m: string) => void }) {
  const [menuId, setMenuId] = useState(0), [rows, setRows] = useState<Row[]>([]), [saving, setSaving] = useState(false);
  const pick = (id: number) => { setMenuId(id); setRows(recipes.filter(r => r.menu_item_id === id).map(r => ({ id: r.inventory_item_id, qty: r.qty ? String(r.qty) : '' }))); };
  const linked = menu.filter(m => recipes.some(r => r.menu_item_id === m.id));
  const item = menu.find(m => m.id === menuId);
  async function save() { if (badAmount(rows)) return notify('Amounts must be numbers, or left blank'); setSaving(true); try { await api(`/api/admin/recipes/${menuId}`, { method: 'PUT', body: { ingredients: toBody(rows) } }); notify(`${item?.name} saved`); onSaved(); } catch (e) { notify((e as Error).message); } finally { setSaving(false); } }
  return <div><h3>What each dish uses</h3><p className="hint">Every sale takes these amounts out of stock, edits adjust them, and voids put them back. A dish the kitchen preps ahead takes its portion (1 per dish); others take their ingredients. Leave an amount blank to link it now and enter the amount later: nothing comes out until then.</p>
    <div className="recipe-pick"><select aria-label="Menu item" value={menuId || ''} onChange={e => pick(Number(e.target.value))}><option value="">Choose a menu item…</option>{Array.from(new Set(menu.map(m => m.category))).map(c => <optgroup label={c} key={c}>{menu.filter(m => m.category === c).map(m => <option key={m.id} value={m.id}>{m.name}{recipes.some(r => r.menu_item_id === m.id) ? ' ✓' : ''}</option>)}</optgroup>)}</select></div>
    {item && <><Lines rows={rows} setRows={setRows} stock={stock} per={item.name}/>
      <div className="sheet-actions"><button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : `Save ${item.name}`}</button></div></>}
    {linked.length > 0 && <details><summary>Dishes linked to stock ({linked.length})</summary><ul className="recipe-list">{linked.map(m => <li key={m.id}><button className="link" onClick={() => pick(m.id)}>{m.name}</button><span className="hint">{recipes.filter(r => r.menu_item_id === m.id).map(r => `${r.name}: ${amount(r.qty, r.unit)}`).join(' · ')}</span></li>)}</ul></details>}
  </div>;
}

// Owner: what prepping one portion takes out, e.g. one Chicken Kebab portion uses 120 g chicken and 5 g Ahos.
// The kitchen records "Prepped 13" on the inventory screen, which takes out 13 × these amounts.
export function PrepEditor({ stock, prep, onSaved, notify }: { stock: InventoryItem[]; prep: PrepRow[]; onSaved: () => void; notify: (m: string) => void }) {
  const [portionId, setPortionId] = useState(0), [rows, setRows] = useState<Row[]>([]), [saving, setSaving] = useState(false);
  const portions = stock.filter(s => s.kind === 'portion'), portion = portions.find(p => p.id === portionId);
  const pick = (id: number) => { setPortionId(id); setRows(prep.filter(r => r.portion_id === id).map(r => ({ id: r.ingredient_id, qty: r.qty ? String(r.qty) : '' }))); };
  const linked = portions.filter(p => prep.some(r => r.portion_id === p.id));
  async function save() { if (badAmount(rows)) return notify('Amounts must be numbers, or left blank'); setSaving(true); try { await api(`/api/admin/prep/${portionId}`, { method: 'PUT', body: { ingredients: toBody(rows) } }); notify(`${portion?.name} saved`); onSaved(); } catch (e) { notify((e as Error).message); } finally { setSaving(false); } }
  return <div><h3>What prepping a portion uses</h3><p className="hint">When the kitchen records portions prepped on the inventory screen, these amounts (for one portion) come out of stock for each one made.</p>
    <div className="recipe-pick"><select aria-label="Portion" value={portionId || ''} onChange={e => pick(Number(e.target.value))}><option value="">Choose a portion…</option>{bySheet(portions).map(([section, list]) => <optgroup label={section} key={section}>{list.map(p => <option key={p.id} value={p.id}>{p.name}{prep.some(r => r.portion_id === p.id) ? ' ✓' : ''}</option>)}</optgroup>)}</select></div>
    {portion && <><Lines rows={rows} setRows={setRows} stock={stock.filter(s => s.kind !== 'portion')} per={`${portion.name} portion`} exclude={portion.id}/>
      <div className="sheet-actions"><button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : `Save ${portion.name}`}</button></div></>}
    {linked.length > 0 && <details><summary>Portions with a prep list ({linked.length})</summary><ul className="recipe-list">{linked.map(p => <li key={p.id}><button className="link" onClick={() => pick(p.id)}>{p.name}</button><span className="hint">{prep.filter(r => r.portion_id === p.id).map(r => `${r.name}: ${amount(r.qty, r.unit)}`).join(' · ')}</span></li>)}</ul></details>}
  </div>;
}

// Owner, from the menu editor: what selling one of this dish takes out of stock. The same list as "What each
// dish uses" on the Inventory page. A dish with nothing listed (drinks, the salad, cakes) takes nothing out.
export function DishIngredients({ menuItemId, name }: { menuItemId: number; name: string }) {
  const [stock, setStock] = useState<InventoryItem[] | null>(null), [rows, setRows] = useState<Row[]>([]), [saving, setSaving] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    Promise.all([api<{ items: InventoryItem[] }>('/api/admin/inventory'), api<Recipe[]>('/api/admin/recipes')])
      .then(([inventory, recipes]) => { setStock(inventory.items); setRows(recipes.filter(r => r.menu_item_id === menuItemId).map(r => ({ id: r.inventory_item_id, qty: r.qty ? String(r.qty) : '' }))); })
      .catch(e => setMessage((e as Error).message));
  }, [menuItemId]);
  async function save() { if (badAmount(rows)) return setMessage('Amounts must be numbers, or left blank'); setSaving(true); try { await api(`/api/admin/recipes/${menuItemId}`, { method: 'PUT', body: { ingredients: toBody(rows) } }); setMessage(rows.length ? `${name}’s ingredients saved` : `${name} takes nothing out of stock now`); } catch (e) { setMessage((e as Error).message); } finally { setSaving(false); } }
  return <section className="dish-ingredients"><h3>Ingredients</h3><p className="hint">What selling one {name} takes out of stock. Leave an amount blank to link it now and enter it later; leave the list empty for a dish that uses nothing from stock.</p>
    {stock ? <><Lines rows={rows} setRows={setRows} stock={stock} per={name}/>
      <div className="sheet-actions"><button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save ingredients'}</button></div></> : !message && <p className="hint">Opening the stock list…</p>}
    {message && <p className="status" role="status">{message}</p>}
  </section>;
}

