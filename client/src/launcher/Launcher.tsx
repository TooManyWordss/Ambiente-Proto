import { roleName } from '../shared/format';
import { STORE, STORE_NAME, storeUrl } from '../shared/store';
import { Logo } from '../shared/ui';
import { PANELS } from '../terminal/Picker';

export function Launcher() { return <main className="home"><a className="store-switch" href={STORE === 'rairock' ? '/' : '/rairock/'}>Open {STORE === 'rairock' ? 'Café Ambiente' : 'RaiRock Seafoods'}</a><Logo large /><p>{STORE_NAME} · Open each screen on its own device.</p><div className="home-links">{PANELS.map(([r,d]) => <a href={storeUrl(`/login?role=${r}`)} key={r}><strong>{roleName[r]}</strong><span>{d}</span></a>)}<a href={storeUrl('/terminal')}><strong>General terminal</strong><span>One device for every panel: pick one and sign in with its PIN</span></a><a href={storeUrl('/admin#live')}><strong>General panel</strong><span>Every screen at a glance: tills, kitchen, tables and stock (owner)</span></a></div></main>; }
