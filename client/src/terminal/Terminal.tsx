import { useEffect, useRef, useState } from 'react';
import { useSession } from '../shared/hooks';
import { STORE_NAME, storeUrl } from '../shared/store';
import type { Role } from '../shared/types';
import { Logo } from '../shared/ui';

const SCREENS: [Role, string][] = [['pos', 'POS'], ['kitchen', 'Kitchen'], ['barista', 'Waiter'], ['inventory', 'Inventory'], ['admin', 'Admin']];
// Each screen is laid out as on a tablet this wide, then shrunk to fit its tile, so it looks as it does on the real device.
const TABLET_WIDTH = 1024;

function Screen({ role, label, focused, onFocus }: { role: Role; label: string; focused: boolean; onFocus: () => void }) {
  const box = useRef<HTMLDivElement>(null), [size, setSize] = useState({ w: 0, h: 0 }), [reloads, setReloads] = useState(0);
  useEffect(() => {
    const watch = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    watch.observe(box.current!);
    return () => watch.disconnect();
  }, []);
  const scale = size.w ? Math.min(1, size.w / TABLET_WIDTH) : 1;
  return <section className={`term-screen term-${role} ${focused ? 'focused' : ''}`} aria-label={label}>
    <header>
      <strong>{label}</strong>
      <div className="term-actions">
        <button className="btn ghost small" onClick={onFocus}>{focused ? 'Show all' : 'Enlarge'}</button>
        <button className="btn ghost small" onClick={() => setReloads(reloads + 1)} aria-label={`Reload ${label}`}>Reload</button>
        <a className="btn ghost small" href={storeUrl(`/${role}`)} target="_blank" rel="noopener">Open ↗</a>
      </div>
    </header>
    <div className="term-frame" ref={box}>
      {size.w > 0 && <iframe key={reloads} src={storeUrl(`/${role}`)} title={`${label} screen`} allow="bluetooth; fullscreen; screen-wake-lock; autoplay"
        style={{ width: size.w / scale, height: size.h / scale, transform: `scale(${scale})` }} />}
    </div>
  </section>;
}

// The owner's general terminal: every screen live on one page, each one fully usable.
export function Terminal() {
  const { ready } = useSession('admin'), [focus, setFocus] = useState<Role | null>(null);
  if (!ready) return <div className="loading">Opening the general terminal…</div>;
  return <div className="terminal">
    <header className="term-head">
      <Logo mark home />
      <div><h1>General terminal</h1><p>{STORE_NAME} · every screen, live. You’re signed in as the owner, so anything done here is real.</p></div>
      <a className="btn ghost small" href={storeUrl('/admin')}>Back to admin</a>
    </header>
    <main className={`term-grid ${focus ? 'has-focus' : ''}`}>
      {SCREENS.map(([role, label]) => <Screen key={role} role={role} label={label} focused={focus === role} onFocus={() => setFocus(focus === role ? null : role)} />)}
    </main>
  </div>;
}
