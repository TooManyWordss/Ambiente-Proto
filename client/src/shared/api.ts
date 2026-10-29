import { screenPath, storageKey, storeUrl, STORE } from './store';
import type { Role } from './types';

export async function api<T = any>(url: string, options: { method?: string; body?: unknown; form?: FormData; redirectOnUnauthorized?: boolean } = {}): Promise<T> {
  const headers: HeadersInit = options.form ? {} : options.body ? { 'Content-Type': 'application/json' } : {};
  const response = await fetch(storeUrl(url), { method: options.method ?? 'GET', credentials: 'same-origin', headers, body: options.form ?? (options.body ? JSON.stringify(options.body) : undefined) });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    if (options.redirectOnUnauthorized !== false) { clearCachedSessions(); location.href = storeUrl(`/login?role=${roleFromPath()}`); }
    throw Object.assign(new Error(payload.error ?? 'Please log in'), { status: 401 });
  }
  if (!response.ok) throw Object.assign(new Error(payload.error ?? `Request failed (${response.status})`), { status: response.status });
  if (payload.undoId && STORE === 'ambiente') { window.dispatchEvent(new CustomEvent('dining.saved', { detail: payload.undoId })); window.dispatchEvent(new Event('dining.business')); }
  return payload as T;
}
export function roleFromPath(): Role { const p = screenPath().slice(1); return (['pos', 'barista', 'kitchen', 'inventory', 'admin'].includes(p) ? p : 'admin') as Role; }
export function clearCachedSessions() { for (const role of ['pos', 'barista', 'kitchen', 'inventory', 'admin']) localStorage.removeItem(storageKey(`session.${role}`)); }
// A tab opened from the general terminal goes back to its panel picker when you sign out, so the next person picks their own panel.
const TERMINAL_KEY = () => storageKey('viaTerminal');
export function markViaTerminal() { try { sessionStorage.setItem(TERMINAL_KEY(), '1'); } catch { /* storage blocked: sign-out goes to the panel's own login */ } }
export function viaTerminal() { try { return sessionStorage.getItem(TERMINAL_KEY()) === '1'; } catch { return false; } }
export async function logout() { await fetch(storeUrl('/api/logout'), { method: 'POST', credentials: 'same-origin' }).catch(() => {}); clearCachedSessions(); location.href = storeUrl(viaTerminal() ? '/terminal' : `/login?role=${roleFromPath()}`); }
