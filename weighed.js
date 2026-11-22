// Steaks sold by weight. Shared by the server, the till and the offline table tabs.
// A menu item's `per_grams` is how many grams its price buys (1 = per gram, 100 = per 100 g); without it
// the item is sold by the piece. `sizes` names weight bands: "S<60,M<100,L" is under 60 g S, under 100 g M,
// and anything heavier L.
export const MAX_GRAMS = 5000;
export const byWeight = (item) => Number(item?.per_grams) > 0;

export function sizeBands(item) {
  let from = 0;
  return String(item?.sizes ?? '').split(',').map((band) => band.trim()).filter(Boolean).map((band) => {
    const [name, below] = band.split('<').map((s) => s.trim());
    const result = { name, from, below: below ? Number(below) : null };
    if (below) from = Number(below);
    return result;
  });
}
export const sizeOf = (item, grams) => sizeBands(item).find((b) => b.below == null || grams < b.below)?.name ?? '';

// "₱20.00 / g", "₱899.00 / 100 g": what the menu shows instead of a piece price.
export const perLabel = (item) => (Number(item.per_grams) === 1 ? 'g' : `${item.per_grams} g`);

// One weighed portion: the name the kitchen and receipt show, and its price. Or an error to show the cashier.
export function weighedLine(item, grams) {
  if (!Number.isInteger(grams) || grams < 1 || grams > MAX_GRAMS) return { error: `Enter the weight of ${item.name} in whole grams (1–${MAX_GRAMS})` };
  const size = sizeOf(item, grams);
  return { name: `${item.name} (${size ? `${size} · ` : ''}${grams} g)`, unit_price_cents: Math.round((item.price_cents * grams) / item.per_grams), grams };
}
