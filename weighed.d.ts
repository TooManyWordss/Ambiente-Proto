type Weighable = { name: string; price_cents: number; per_grams?: number | null; sizes?: string | null };
export const MAX_GRAMS: number;
export function byWeight(item: Partial<Weighable> | null | undefined): boolean;
export function sizeBands(item: Partial<Weighable> | null | undefined): { name: string; from: number; below: number | null }[];
export function sizeOf(item: Partial<Weighable>, grams: number): string;
export function perLabel(item: Partial<Weighable>): string;
export function weighedLine(item: Weighable, grams: number): { name: string; unit_price_cents: number; grams: number; error?: undefined } | { error: string; name?: undefined; unit_price_cents?: undefined; grams?: undefined };
