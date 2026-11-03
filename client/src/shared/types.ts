export type Role = 'pos' | 'barista' | 'kitchen' | 'inventory' | 'admin';
export type User = { role: Role; name?: string; staff?: { id: number; name: string; role: Role } | null };
export type MenuItem = { id: number; name: string; category: string; price_cents: number; available: number; sends_to_kitchen?: number; per_grams?: number | null; sizes?: string | null; description?: string; descriptionNote?: string; descriptionSources?: { title: string; url: string }[] };
export type Line = { id?: number; menu_item_id: number; name?: string; qty: number; unit_price_cents?: number; sends_to_kitchen?: number; kitchen_ready_at?: string | null; kitchen_started_at?: string | null; note?: string | null; grams?: number | null; station?: string | null };
export type Party = { seated_at: string; guests: number; customer_tag: string | null; total_cents: number; unpaid_cents?: number; receipts: { id: number; label: string; total_cents: number; created_at: string; paid?: boolean }[];
  // The unpaid orders with their items (and any saved on this tablet while offline), for billing out offline.
  orders?: Order[] };
export type DiningTable = { id: number; name: string; seats: number; x: number; y: number; w: number; h: number; party: Party | null };
export type TableChoice = { id: number; name: string; guests: number; tag: 'vip' | 'repeat' | null; seatedAt: string };
// qty 0: linked, amount not entered yet (nothing comes out of stock).
export type Recipe ={ menu_item_id: number; inventory_item_id: number; qty: number; name: string; unit: string };
export type PrepRow = { portion_id: number; ingredient_id: number; qty: number; name: string; unit: string };
export type Order = { offline?: boolean; version?: number; discount_json?: string; discount_cents?: number; visit_id?: string; table_id?: number | null; table_name?: string | null; guests?: number | null; customer_tag?: string | null; seated_at?: string | null; billed_out_at?: string | null; id: number; client_id?: string; station: string; receipt_no: number; receipt_label?: string; created_at: string; items: Line[]; total_cents: number; subtotal_cents: number; tax_cents: number; cash_tendered_cents?: number; change_cents?: number; status: string; kitchen_status: string; edit_count: number; bill_id?: string | null; paid_at?: string | null; void_reason?: string; voided_at?: string; staff_name?: string };
export type Summary = { gross_cents: number; order_count: number; void_count: number; void_cents: number; edited_count?: number; trading_days?: number };
export type DayReport = { date: string; isToday: boolean; summary: Summary; topItems: { name: string; qty: number; revenue_cents: number }[]; orders: Order[]; logs: any[] };
// A portion is a serving the kitchen preps ahead; dishes take portions out, prepping takes ingredients out.
export type InventoryItem = { version: number; id: number; name: string; unit: string; quantity: number; threshold: number; low: boolean; updated_by?: string; updated_at: string; kind?: 'ingredient' | 'portion' | 'supply' | null; section?: string | null; used_in?: string[]; prep_uses?: string[] };
export type EventRow = { key?: string; custom_id?: number; name: string; start: string; end: string; kind: string; note?: string; hidden?: boolean; status?: string; during?: any; baseline_per_day_cents?: number; lift_pct?: number; last_year?: any };
