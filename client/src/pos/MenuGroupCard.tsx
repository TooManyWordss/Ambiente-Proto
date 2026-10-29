import { useEffect, useRef } from 'react';
import { byWeight, perLabel } from '../../../weighed.js';
import { money } from '../shared/format';
import type { MenuItem } from '../shared/types';
import type { MenuGroup } from './menuGroups';

// One menu card. Tapping an item (or one of its sizes) adds it; that's all a tap does. The small "i"
// opens the description, and a count shows how many are already in the order.
export function MenuGroupCard({ group, qtyOf, pending = false, availabilityMode, expanded, onAdd, onAvailability, onDetails, onClose }: {
  group: MenuGroup; qtyOf: (id: number) => number; pending?: boolean; availabilityMode: boolean; expanded: boolean;
  onAdd: (item: MenuItem) => void; onAvailability: (item: MenuItem) => void; onDetails: () => void; onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null), first = group.items[0].item, single = group.items.length === 1;
  const totalQty = group.items.reduce((n, { item }) => n + qtyOf(item.id), 0);
  useEffect(() => {
    if (!expanded) return;
    const outside = (e: PointerEvent) => { if (!card.current?.contains(e.target as Node)) onClose(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [expanded, onClose]);
  const tap = (item: MenuItem) => { if (pending) onDetails(); else if (availabilityMode) onAvailability(item); else if (item.available) onAdd(item); };
  const label = (item: MenuItem) => pending ? 'Awaiting approval' : !item.available ? 'Sold out' : availabilityMode ? 'Available' : byWeight(item) ? `${money(item.price_cents)} / ${perLabel(item)}` : money(item.price_cents);
  const state = (item: MenuItem) => pending ? 'pending' : !item.available ? 'unavailable' : '';
  // The count remounts when it changes, so it pops each time an item is added.
  const count = (n: number) => n > 0 ? <span key={n} className="in-order" aria-hidden="true">{n}</span> : null;
  const spoken = (item: MenuItem) => `${item.name}, ${label(item)}${qtyOf(item.id) ? `, ${qtyOf(item.id)} in order` : ''}${availabilityMode && !pending ? '. Tap to change availability' : ''}`;
  return <div ref={card} className={`menu-card ${single ? '' : 'sized'} ${totalQty ? 'ordered' : ''}`} data-expanded={expanded}>
    {single
      ? <button type="button" className={`menu-item ${state(first)}`} aria-label={spoken(first)} onClick={() => tap(first)}>
          <span className="name">{first.name}</span><span className="price">{label(first)}</span>{count(qtyOf(first.id))}
        </button>
      : <div className={`menu-item-group ${group.items.every(({ item }) => !item.available) ? 'unavailable' : ''}`}>
          <span className="name">{group.name}</span>
          <div className="sizes">{group.items.map(({ item, variant }) => <button type="button" key={item.id} className={`menu-item size ${state(item)}`} aria-label={spoken(item)} onClick={() => tap(item)}>
            <span className="sr-only">{item.name} </span><span className="size-name">{variant}</span><span className="price">{label(item)}</span>{count(qtyOf(item.id))}
          </button>)}</div>
        </div>}
    {first.description && <button type="button" className="menu-info" aria-label={`About ${group.name}`} aria-expanded={expanded} onClick={() => expanded ? onClose() : onDetails()}>i</button>}
    {expanded && first.description && <div className="menu-card-description" id={`menu-description-${first.id}`} role="region" aria-label={`${group.name} description`} tabIndex={0}>
      <div className="menu-description-toolbar"><button type="button" className="menu-description-close" aria-label={`Close ${group.name} description`} onClick={onClose}>Close <span aria-hidden="true">×</span></button></div>
      <p>{first.description}</p>
      {first.descriptionNote && <p className="menu-card-note">{first.descriptionNote}</p>}
    </div>}
  </div>;
}
