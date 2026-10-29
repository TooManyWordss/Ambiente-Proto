import { useEffect } from 'react';
import { markViaTerminal } from '../shared/api';
import { roleName } from '../shared/format';
import { STORE_NAME, storeUrl } from '../shared/store';
import type { Role } from '../shared/types';
import { Logo } from '../shared/ui';

export const PANELS: [Role, string][] = [['pos', 'Ring up orders and take payment'], ['barista', "The barista's own till and receipts"], ['kitchen', 'Live queue of tickets to prepare'], ['inventory', 'Count stock, log deliveries and usage'], ['admin', 'Sales, reports, receipts, staff and inventory']];

// The general terminal: one shared device for every panel. Pick a panel, sign in with that panel's
// PIN (or the owner's password), and signing out comes back here for the next person.
export function Picker() {
  useEffect(markViaTerminal, []);
  return <main className="login picker"><section className="login-card picker-card">
    <Logo large />
    <div className="picker-title"><h1>General terminal</h1><p>{STORE_NAME} · pick a panel, then sign in with its PIN.</p></div>
    <nav className="picker-panels" aria-label="Panels">
      {PANELS.map(([role, about]) => <a className={`picker-panel picker-${role}`} href={storeUrl(`/login?role=${role}`)} key={role}>
        <strong>{roleName[role]}</strong><span>{about}</span><i aria-hidden="true">›</i>
      </a>)}
    </nav>
    <a className="link picker-all" href={storeUrl('/terminal/all')}>Owner: every screen side by side</a>
  </section></main>;
}
