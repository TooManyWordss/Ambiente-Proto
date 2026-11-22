// Runs only on the café tablet (Termux). While the café internet is up it:
//   - opens a secure internet link (cloudflared, TUNNEL=1), so the owner's phone reaches this tablet's
//     admin panel from anywhere, with live updates
//   - sends that link to the owner's phone as a notification (the free ntfy app, NTFY_TOPIC in .env)
//     every time it changes, since the free link gets a new address when the tablet restarts
//   - if a cloud site is linked (CLOUD_URL and CLOUD_TOKEN), sends it a copy of the sales databases
//     every 30 minutes and tells it the link, so <cloud>/cafe opens this tablet's admin.
// Without internet nothing here matters: the POS and kitchen keep working over the café Wi-Fi.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PORT } from '../core/config.js';
import { databases } from '../core/db.js';

const { CLOUD_URL, CLOUD_TOKEN, TUNNEL, NTFY_TOPIC } = process.env;
const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';
const BACKUP_EVERY = 30 * 60_000, REPORT_EVERY = 5 * 60_000, RESEND_EVERY = 12 * 3_600_000;
let tunnelUrl = null, sentUrl = null, sentAt = 0;

const send = (route, body, type = 'application/json') => fetch(`${CLOUD_URL}${route}`, {
  method: 'POST', headers: { Authorization: `Bearer ${CLOUD_TOKEN}`, 'Content-Type': type },
  body: type === 'application/json' ? JSON.stringify(body) : body, signal: AbortSignal.timeout(60_000),
});

async function backup() {
  for (const [store, database] of Object.entries(databases)) {
    const file = path.join(os.tmpdir(), `cafe-backup-${store}.db`);
    try {
      fs.rmSync(file, { force: true });
      database.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`); // a consistent copy, even mid-sale
      const res = await send(`/api/cafe-link/backup?store=${store}`, fs.readFileSync(file), 'application/octet-stream');
      if (!res.ok) console.log(`Backup of ${store} not accepted (${res.status})`);
    } catch { /* no internet right now; the next round tries again */ }
    finally { fs.rmSync(file, { force: true }); }
  }
}

async function report() {
  if (!CLOUD_URL || !CLOUD_TOKEN) return;
  try { await send('/api/cafe-link/report', { tunnelUrl }); } catch { /* offline */ }
}

// The owner's phone gets the link each time it changes, and again every 12 hours (ntfy keeps
// messages for about that long, so a phone that subscribes later still finds the current one).
// Only the address is sent: opening it still needs the owner password.
async function notifyPhone() {
  if (!NTFY_TOPIC || !tunnelUrl || (tunnelUrl === sentUrl && Date.now() - sentAt < RESEND_EVERY)) return;
  const link = `${tunnelUrl}/admin`;
  try {
    const res = await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST', body: `Owner's panel: ${link}`, signal: AbortSignal.timeout(30_000),
      headers: { Title: 'Cafe Ambiente owner link', Click: link, Tags: 'coffee' },
    });
    if (res.ok) { sentUrl = tunnelUrl; sentAt = Date.now(); }
  } catch { /* no internet right now; tried again in 5 minutes */ }
}

function startTunnel() {
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const watch = (chunk) => {
    const found = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (found && found[0] !== tunnelUrl) {
      tunnelUrl = found[0];
      console.log(`Owner link is up: ${tunnelUrl}/admin${NTFY_TOPIC ? ' (sent to your phone)' : ''}`);
      void report(); void notifyPhone();
    }
  };
  child.stdout.on('data', watch); child.stderr.on('data', watch);
  let missing = false;
  child.on('error', () => { missing = true; console.log('cloudflared is not installed; remote owner access is off.'); });
  child.on('close', () => { tunnelUrl = null; if (!missing) setTimeout(startTunnel, 30_000); }); // e.g. internet dropped; try again
}

if (CLOUD_URL && CLOUD_TOKEN) {
  setTimeout(() => void backup(), 60_000);
  setInterval(() => void backup(), BACKUP_EVERY);
  setInterval(() => void report(), REPORT_EVERY);
}
if (TUNNEL === '1') {
  startTunnel();
  if (NTFY_TOPIC) {
    console.log(`Phone alerts: in the ntfy app, subscribe to "${NTFY_TOPIC}" to get the owner link.`);
    setInterval(() => void notifyPhone(), REPORT_EVERY);
  }
}
