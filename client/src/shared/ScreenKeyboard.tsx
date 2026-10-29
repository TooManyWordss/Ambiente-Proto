import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { storageKey } from './store';

// The café's own on-screen keyboard, for every text and number box on the tablets: a number pad for amounts,
// PINs and weights, and letters for names, notes and searches. It replaces the tablet's keyboard, which
// covers half the screen; "Tablet keyboard" switches back to that one. Computers with a real keyboard
// don't get it unless it's switched on.
type Layout = 'letters' | 'symbols' | 'numbers' | 'decimal';
const TEXT_TYPES = new Set(['text', 'search', 'password', 'number', 'tel', 'email', 'url', '']);
const prefKey = () => storageKey('keyboard');
const preference = (): 'screen' | 'system' => { try { const v = localStorage.getItem(prefKey()); if (v === 'screen' || v === 'system') return v; } catch { /* default below */ } return matchMedia('(pointer: coarse)').matches ? 'screen' : 'system'; };

const typeable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_TYPES.has(el.type))) && !el.readOnly && !el.disabled && !el.closest('[data-no-keyboard]');
// The box's own keyboard hint, kept before it's switched off so the tablet's keyboard stays away.
const modeOf = (el: HTMLInputElement | HTMLTextAreaElement) => el.dataset.kbMode ?? el.getAttribute('inputmode') ?? '';
const layoutFor = (el: HTMLInputElement | HTMLTextAreaElement): Layout => {
  const mode = modeOf(el), type = el instanceof HTMLInputElement ? el.type : 'text';
  if (mode === 'decimal' || (type === 'number' && (el as HTMLInputElement).step !== '1' && (el as HTMLInputElement).step !== '')) return 'decimal';
  return mode === 'numeric' || mode === 'tel' || type === 'tel' || type === 'number' ? 'numbers' : 'letters';
};
function quiet(el: HTMLInputElement | HTMLTextAreaElement) { if (el.dataset.kbMode === undefined) el.dataset.kbMode = el.getAttribute('inputmode') ?? ''; el.setAttribute('inputmode', 'none'); }
function restore(el: HTMLInputElement | HTMLTextAreaElement) { if (el.dataset.kbMode === undefined) return; if (el.dataset.kbMode) el.setAttribute('inputmode', el.dataset.kbMode); else el.removeAttribute('inputmode'); delete el.dataset.kbMode; }
const everyBox = () => [...document.querySelectorAll('input, textarea')].filter(typeable) as (HTMLInputElement | HTMLTextAreaElement)[];

// Typing goes through the box's own value setter and an input event, so React sees it like a real key.
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const caret = (el: HTMLInputElement | HTMLTextAreaElement) => { try { return el.selectionStart == null ? null : [el.selectionStart, el.selectionEnd ?? el.selectionStart] as const; } catch { return null; } };

const ROWS: Record<'letters' | 'symbols', string[][]> = {
  letters: [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ñ'], ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'back']],
  symbols: [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'], ['@', '#', '₱', '&', '-', '+', '(', ')', '/', '%'], ['=', '*', '"', "'", ':', ';', '!', '?', 'back']],
};

export function ScreenKeyboard() {
  const [pref, setPref] = useState(preference), [target, setTarget] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [layout, setLayout] = useState<Layout>('letters'), [shift, setShift] = useState(false);
  // A number box can't hold "12." while it's being typed, so the typed text is kept here.
  const numberText = useRef(new WeakMap<HTMLInputElement, string>()), board = useRef<HTMLDivElement>(null), repeat = useRef<number | undefined>(undefined);

  // Keeps the tablet's keyboard away from every box, including ones that appear later.
  useEffect(() => {
    if (pref !== 'screen') { everyBox().forEach(restore); return; }
    everyBox().forEach(quiet);
    let queued = 0;
    const watch = new MutationObserver(() => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; everyBox().forEach(quiet); }); });
    watch.observe(document.body, { childList: true, subtree: true });
    return () => { watch.disconnect(); cancelAnimationFrame(queued); };
  }, [pref]);

  useEffect(() => {
    const focus = (e: FocusEvent) => {
      const el = e.target as Element;
      if (!typeable(el)) return;
      if (pref === 'screen') quiet(el);
      setTarget(el); setLayout(layoutFor(el)); setShift(false);
      if (el instanceof HTMLInputElement && el.type === 'number') numberText.current.set(el, el.value);
    };
    // Leaving a box for anything but another box closes the keyboard.
    const blur = () => window.setTimeout(() => { if (!typeable(document.activeElement)) setTarget(null); }, 0);
    document.addEventListener('focusin', focus); document.addEventListener('focusout', blur);
    if (typeable(document.activeElement)) focus({ target: document.activeElement } as unknown as FocusEvent);
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('focusout', blur); };
  }, [pref]);

  const open = pref === 'screen' && !!target && target.isConnected;
  // Room for the keyboard: the page and dialogs end above it, and the box being typed in stays in view.
  useEffect(() => {
    if (!open) { document.body.classList.remove('kb-open'); return; }
    const height = board.current?.offsetHeight ?? 0;
    document.documentElement.style.setProperty('--kb-h', `${height}px`);
    document.body.classList.add('kb-open');
    target!.scrollIntoView({ block: 'nearest' });
  }, [open, layout, target]);
  useEffect(() => () => document.body.classList.remove('kb-open'), []);

  // What's typed in a number box so far, unless something else changed the box since.
  const typedNumber = (el: HTMLInputElement) => { const typed = numberText.current.get(el); return typed != null && Number(typed.replace(/\.$/, '') || 0) === Number(el.value || 0) ? typed : el.value; };
  const type = (text: string) => {
    const el = target; if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'number') {
      const typed = typedNumber(el) + text;
      if (!/^-?\d*\.?\d*$/.test(typed) || (el.maxLength > 0 && typed.length > el.maxLength)) return;
      numberText.current.set(el, typed); setValue(el, typed.endsWith('.') ? typed.slice(0, -1) : typed); return;
    }
    const at = caret(el), value = el.value, next = at ? value.slice(0, at[0]) + text + value.slice(at[1]) : value + text;
    if (el.maxLength > 0 && next.length > el.maxLength) return;
    setValue(el, next);
    if (at) el.setSelectionRange(at[0] + text.length, at[0] + text.length);
    if (shift) setShift(false);
  };
  const back = () => {
    const el = target; if (!el) return;
    if (el instanceof HTMLInputElement && el.type === 'number') { const typed = typedNumber(el).slice(0, -1); numberText.current.set(el, typed); setValue(el, typed.endsWith('.') ? typed.slice(0, -1) : typed); return; }
    const at = caret(el), value = el.value;
    if (!at) return setValue(el, value.slice(0, -1));
    const [start, end] = at, from = start === end ? Math.max(0, start - 1) : start;
    setValue(el, value.slice(0, from) + value.slice(end)); el.setSelectionRange(from, from);
  };
  const enter = () => {
    const el = target; if (!el) return;
    if (el instanceof HTMLTextAreaElement) return type('\n');
    // Enter does what it does on a real keyboard: other listeners see it, and a form is sent.
    const allowed = el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    if (allowed && el.form) el.form.requestSubmit(); else if (allowed) el.blur();
  };
  const toTablet = () => { try { localStorage.setItem(prefKey(), 'system'); } catch { /* this visit only */ } const el = target; setPref('system'); if (el) { restore(el); el.blur(); window.setTimeout(() => el.focus(), 50); } };
  const toScreen = () => { try { localStorage.setItem(prefKey(), 'screen'); } catch { /* this visit only */ } setPref('screen'); if (target) { quiet(target); target.blur(); window.setTimeout(() => target.focus(), 50); } };

  // Keys act on press, without taking the focus from the box. Holding ⌫ keeps deleting.
  const press = (action: () => void, hold = false) => (e: PointerEvent) => {
    e.preventDefault(); action();
    if (hold) { window.clearInterval(repeat.current); const start = Date.now(); repeat.current = window.setInterval(() => { if (Date.now() - start > 400) action(); }, 70); }
  };
  const stop = () => window.clearInterval(repeat.current);
  const key = (label: string, action: () => void, className = '', aria?: string, hold = false) =>
    <button type="button" key={aria ?? label} className={`kb-key ${className}`} aria-label={aria ?? label} onPointerDown={press(action, hold)} onPointerUp={stop} onPointerLeave={stop} onClick={e => e.preventDefault()}>{label}</button>;

  if (pref !== 'screen') return target?.isConnected && matchMedia('(pointer: coarse)').matches
    ? <button type="button" className="kb-switch" onPointerDown={e => { e.preventDefault(); toScreen(); }}>⌨ Café keyboard</button> : null;
  if (!open) return null;
  const numeric = layout === 'numbers' || layout === 'decimal';
  const label = target instanceof HTMLInputElement && target.labels?.[0]?.textContent?.trim();
  return <div ref={board} className={`screen-keyboard ${numeric ? 'kb-numeric' : ''}`} role="group" aria-label="On-screen keyboard" onPointerDown={e => e.preventDefault()}>
    <div className="kb-bar"><span className="kb-for">{label || target!.getAttribute('placeholder') || target!.getAttribute('aria-label') || ''}</span>
      {!numeric && key(layout === 'letters' ? '123' : 'ABC', () => setLayout(layout === 'letters' ? 'symbols' : 'letters'), 'kb-small', layout === 'letters' ? 'Numbers and symbols' : 'Letters')}
      {key('Tablet keyboard', toTablet, 'kb-small', 'Use the tablet’s keyboard')}
      {key('Hide ⌄', () => target!.blur(), 'kb-small', 'Hide the keyboard')}</div>
    {numeric ? <div className="kb-pad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => key(d, () => type(d)))}
      {layout === 'decimal' ? key('.', () => type('.')) : <span/>}{key('0', () => type('0'))}{key('⌫', back, 'kb-back', 'Delete', true)}
      {key('Done', enter, 'kb-enter kb-wide', 'Enter')}
    </div> : <div className="kb-rows">
      {ROWS[layout === 'symbols' ? 'symbols' : 'letters'].map((row, i) => <div className="kb-row" key={i}>{row.map(k => k === 'shift' ? key('⇧', () => setShift(!shift), `kb-mod ${shift ? 'active' : ''}`, 'Shift')
        : k === 'back' ? key('⌫', back, 'kb-mod', 'Delete', true)
        : key(shift ? k.toUpperCase() : k, () => type(shift ? k.toUpperCase() : k)))}</div>)}
      <div className="kb-row">{key(',', () => type(','))}{key('space', () => type(' '), 'kb-space', 'Space')}{key('.', () => type('.'))}{key('⏎', enter, 'kb-enter', 'Enter')}</div>
    </div>}
  </div>;
}
