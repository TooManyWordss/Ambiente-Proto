import { hashSecret } from '../auth/secrets.js';
import { currentStore } from '../core/config.js';
import { db } from '../core/db.js';
import { getSetting, setSetting } from '../core/settings.js';

// The café's first staff roster with testing codes (November 2026). It runs once per database;
// afterwards the owner renames people, changes codes and moves them between positions in
// Staff & access. Everyone starts in the Kitchen position, whose code opens nothing, until the
// owner gives them their real position — so nobody can bill out or touch stock by accident.
const ROSTER = [
  ['Analyn', '2314'], ['Arlyn', '8426'], ['Arneda', '5173'], ['Charnelon', '9241'],
  ['Efren', '6385'], ['Jerry', '1749'], ['Joar', '4062'], ['Joean', '7538'],
  ['Lynd Edden', '3691'], ['Marife', '8157'], ['Mary Jane', '2480'], ['Melchisedec', '6924'],
  ['Primitivo', '5316'], ['Reyjay', '9073'], ['Romel', '1628'], ['Romer', '4895'],
  ['Ronie', '7250'], ['Wendel', '3547'],
];

export function seedStaff() {
  if (process.env.SEED_STAFF === '0' || currentStore() !== 'ambiente' || getSetting('seeded_staff_roster', '') === 'done') return;
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO staff (name, role, created_at, code_hash) VALUES (?, ?, ?, ?)');
  for (const [name, code] of ROSTER) {
    if (db.prepare('SELECT 1 FROM staff WHERE lower(name) = lower(?) AND active = 1').get(name)) continue;
    insert.run(name, 'kitchen', now, hashSecret(code));
  }
  setSetting('seeded_staff_roster', 'done');
}
