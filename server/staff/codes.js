import crypto from 'node:crypto';
import { readSession, requireRole, safeEqual, SELLERS } from '../auth/sessions.js';
import { STOCK_KEEPERS } from '../core/config.js';
import { db } from '../core/db.js';
import { app } from '../core/http.js';
import { getSetting, setSetting } from '../core/settings.js';

// Personal staff codes. The owner gives each cashier, waiter and inventory inspector a code of 4–6 digits; it's
// unique, so the code alone says who it is. Once at least one person on a screen has a code, that screen's key
// actions need one, and the person is recorded on what they did:
//   cashier (pos): every bill out (paying, freeing a table, settling on Unpaid tabs)
//   waiter (barista): every order sent and every bill request
//   inspector (inventory): every stock change
export const CODED_ROLES = ['pos', 'barista', 'inventory'];
export const isCode = (code) => typeof code === 'string' && /^\d{4,6}$/.test(code);
const matches = (code, hash) => {
  const [scheme, salt, expected] = String(hash).split(':');
  return scheme === 'scrypt' && !!salt && !!expected && safeEqual(crypto.scryptSync(code, salt, 64).toString('hex'), expected);
};
// The staff member (on one of `roles`) whose code this is, or null.
export function staffByCode(code, roles = CODED_ROLES) {
  if (!isCode(code)) return null;
  const staff = db.prepare(`SELECT id, name, role, code_hash FROM staff WHERE active = 1 AND code_hash IS NOT NULL AND role IN (${roles.map(() => '?').join(',')})`).all(...roles);
  const found = staff.find((s) => matches(code, s.code_hash));
  return found ? { id: found.id, name: found.name, role: found.role } : null;
}
// Is the code already someone's? (The owner can't give two people the same code.)
export const codeTaken = (code, exceptId = 0) => db.prepare('SELECT id, code_hash FROM staff WHERE active = 1 AND code_hash IS NOT NULL AND id != ?').all(exceptId).some((s) => matches(code, s.code_hash));
export const codeRequired = (role) => !!db.prepare('SELECT 1 FROM staff WHERE active = 1 AND code_hash IS NOT NULL AND role = ?').get(role);
// Who last used each screen with their code, for the owner.
export const lastUsers = () => Object.fromEntries(CODED_ROLES.map((role) => { try { return [role, JSON.parse(getSetting(`last_user_${role}`, 'null'))]; } catch { return [role, null]; } }));
export function rememberUser(role, staff, action) { setSetting(`last_user_${role}`, JSON.stringify({ name: staff.name, action, at: new Date().toISOString() })); }

const RULES = [
  { method: 'POST', path: /^\/api\/tables\/\d+\/(pay|bill-out)$/, role: 'pos', action: 'bill out' },
  { method: 'POST', path: /^\/api\/orders$/, role: 'barista', action: 'send an order' },
  { method: 'POST', path: /^\/api\/tables\/\d+\/request-bill$/, role: 'barista', action: 'ask for the bill' },
  { method: 'POST', path: /^\/api\/inventory\/\d+\/stock$/, role: 'inventory', action: 'change stock' },
  { method: 'PATCH', path: /^\/api\/inventory\/\d+$/, role: 'inventory', action: 'change stock' },
];
// Wrong codes are slowed down like PINs: 8 in a row from one address locks codes for 5 minutes.
const failures = new Map();
export function checkCode(req, code, roles) {
  const key = `${req.store}|${req.ip}`, failure = failures.get(key);
  if (failure?.lockedUntil > Date.now()) return { error: 'Too many wrong codes. Try again in a few minutes.' };
  const staff = staffByCode(code, roles);
  if (!staff) {
    const count = (failure?.count ?? 0) + 1;
    failures.set(key, count >= 8 ? { count: 0, lockedUntil: Date.now() + 5 * 60_000 } : { count });
    return { error: code ? 'That staff code isn’t right' : null };
  }
  failures.delete(key);
  return { staff };
}
// Runs before the routes: the screen's own login must also type a staff code for these actions. The owner doesn't.
app.use((req, res, next) => {
  const rule = RULES.find((r) => r.method === req.method && r.path.test(req.path));
  if (!rule) return next();
  const session = readSession(req.headers.cookie);
  if (session?.role !== rule.role || !codeRequired(rule.role)) return next();
  const { staff, error } = checkCode(req, req.body?.staffCode, [rule.role]);
  if (!staff) return res.status(403).json({ error: error ?? `Enter your staff code to ${rule.action}`, needsCode: true });
  req.codeStaff = req.staff = staff;
  res.on('finish', () => { if (res.statusCode < 400) rememberUser(rule.role, staff, rule.action); });
  next();
});

// Each screen asks whether it needs codes, and can check one before saving something offline.
app.get('/api/staff-codes', requireRole(...SELLERS, ...STOCK_KEEPERS), (req, res) => res.json({ required: codeRequired(req.role) }));
app.post('/api/staff-codes/check', requireRole(...SELLERS, ...STOCK_KEEPERS), (req, res) => {
  const { staff, error } = checkCode(req, req.body?.staffCode, [req.role]);
  return staff ? res.json({ name: staff.name }) : res.status(403).json({ error: error ?? 'Enter your staff code', needsCode: true });
});
