import { useEffect, useState } from 'react';
import { api } from '../shared/api';
import { storageKey } from '../shared/store';

// The balcony on the floor map, as the owner sized it in map units (the room runs 14–1266 across, 76–704 down).
// Remembered on this device so the map draws it the same offline.
export type Box = { x: number; y: number; w: number; h: number };
export const STANDARD_BALCONY: Box = { x: 100, y: 84, w: 166, h: 508 };
const key = () => storageKey('floor.balcony');
function remembered(): Box { try { return { ...STANDARD_BALCONY, ...JSON.parse(localStorage.getItem(key()) ?? '{}') }; } catch { return STANDARD_BALCONY; } }
let current = remembered();
const watchers = new Set<(b: Box) => void>();
export function setBalcony(b: Box) {
  current = b;
  try { localStorage.setItem(key(), JSON.stringify(b)); } catch { /* not remembered on this device */ }
  watchers.forEach((w) => w(b));
}
// Asks the server again whenever `refresh` changes (each map passes its tables, which reload when the floor changes).
export function useBalcony(refresh?: unknown) {
  const [balcony, set] = useState(current);
  useEffect(() => { watchers.add(set); return () => { watchers.delete(set); }; }, []);
  useEffect(() => { api<{ balcony: Box }>('/api/floor', { redirectOnUnauthorized: false }).then((r) => setBalcony(r.balcony)).catch(() => {}); }, [refresh]);
  return balcony;
}
