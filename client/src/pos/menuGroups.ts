import type { MenuItem } from '../shared/types';

// Sizes of one drink share a card: "Cappuccino Frappe (16oz)" and "(20oz)" become "Cappuccino Frappe"
// with a 16oz and a 20oz button. An item with no sibling keeps its full name.
export type MenuGroup = { key: string; name: string; items: { item: MenuItem; variant: string }[] };
const VARIANT = /^(.*\S)\s*\(([^()]+)\)\s*$/;

export function groupMenu(items: MenuItem[]): MenuGroup[] {
  const groups = new Map<string, MenuGroup>();
  for (const item of items) {
    const match = item.name.match(VARIANT), name = match ? match[1] : item.name;
    const key = `${item.category}|${name.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { key, name, items: [] });
    groups.get(key)!.items.push({ item, variant: match ? match[2] : '' });
  }
  return [...groups.values()].map(g => g.items.length === 1 ? { ...g, name: g.items[0].item.name, items: [{ ...g.items[0], variant: '' }] } : g);
}

// The category list reads as three short groups instead of one long column.
export const SECTIONS = ['Drinks', 'Food', 'Bar'] as const;
export function sectionOf(category: string): (typeof SECTIONS)[number] {
  if (/wine|whisk|beer|cocktail|spirit|liquor|vodka|rum|gin|tequila|shot/i.test(category)) return 'Bar';
  if (/frappe|coffee|tea|smoothie|chocolate|juice|drink|soda|shake|latte|milk/i.test(category)) return 'Drinks';
  return 'Food';
}
