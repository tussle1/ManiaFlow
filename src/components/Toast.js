/**
 * Toast — transient, dismissible feedback that never blocks the user.
 *
 * Browser `alert()` is not used anywhere in ManiaFlow: it stops the event loop, which would
 * freeze a running preview and an input session with it. These queue in the corner, expire,
 * and are announced to assistive technology through a polite live region rather than by
 * taking focus away from whatever the user is doing.
 *
 * Deliberately quiet: a toast is for something that finished, failed, or needs a decision
 * later. Routine interactions (a toggle, a tab change) do not produce one.
 */

import { h, setText } from '../utils/dom.js';
import { icon } from './Icon.js';
import { button } from './Button.js';

const DURATIONS = { success: 3600, info: 4200, warning: 6500, error: 9000 };
const ICONS = { success: 'check', info: 'info', warning: 'alert', error: 'alert' };
const LABELS = { success: 'Done', info: 'Note', warning: 'Warning', error: 'Error' };
const MAX_VISIBLE = 4;

let container = null;
let liveRegion = null;
const active = [];
let seq = 0;

function ensureContainer() {
  if (container && container.isConnected) return container;
  container = h('div.toasts');
  // A polite live region: screen readers announce a toast without stealing focus.
  liveRegion = h('div.sr-only', { 'aria-live': 'polite', 'aria-atomic': 'false', role: 'status' });
  document.body.append(container, liveRegion);
  return container;
}

/**
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.message]
 * @param {'success'|'info'|'warning'|'error'} [options.variant]
 * @param {number} [options.duration] ms; 0 keeps it until dismissed
 * @param {{ label: string, onClick: Function }} [options.action]
 * @returns {{ id: number, dismiss: () => void }}
 */
export function toast(options = {}) {
  const text = typeof options === 'string' ? { message: options } : options;
  const variant = ICONS[text.variant] ? text.variant : 'info';
  const duration = Number.isFinite(+text.duration) ? +text.duration : DURATIONS[variant];
  ensureContainer();

  const id = ++seq;
  const node = h(`div.toast.toast--${variant}`, { role: variant === 'error' ? 'alert' : 'status' });
  node.append(h('span.toast__icon', icon(ICONS[variant], { size: 15 })));

  const body = h('div.toast__body');
  if (text.title) body.append(h('div.toast__title', text.title));
  if (text.message) body.append(h('div.toast__text', text.message));
  node.append(body);

  const entry = { id, node, timer: 0 };
  entry.dismiss = () => dismiss(id);

  node.append(button({
    icon: 'close', size: 'sm', variant: 'ghost', class: 'toast__close',
    ariaLabel: 'Dismiss notification', onClick: () => dismiss(id),
  }));

  if (text.action && typeof text.action.onClick === 'function') {
    body.append(button({
      label: text.action.label || 'Action', size: 'sm', variant: 'ghost',
      onClick: () => { text.action.onClick(); dismiss(id); },
    }));
  }

  active.push(entry);
  container.append(node);
  setText(liveRegion, `${LABELS[variant]}${text.title ? `: ${text.title}` : ''}${text.message ? `. ${text.message}` : ''}`);

  // Only the newest few stay visible; older ones are dropped rather than stacked off-screen.
  while (active.length > MAX_VISIBLE) dismiss(active[0].id);

  if (duration > 0) entry.timer = setTimeout(() => dismiss(id), duration);
  // Hovering holds a toast open; leaving restarts the countdown.
  node.addEventListener('pointerenter', () => { clearTimeout(entry.timer); entry.timer = 0; });
  node.addEventListener('pointerleave', () => {
    if (!entry.timer && duration > 0) entry.timer = setTimeout(() => dismiss(id), Math.max(1200, duration / 2));
  });

  return entry;
}

export function dismiss(id) {
  const index = active.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  const [entry] = active.splice(index, 1);
  clearTimeout(entry.timer);
  entry.node.classList.add('is-leaving');
  const remove = () => entry.node.remove();
  entry.node.addEventListener('animationend', remove, { once: true });
  // If motion is off there is no animation to wait for.
  setTimeout(remove, 400);
  return true;
}

export const ok = (message, title) => toast({ variant: 'success', message, title });
export const info = (message, title) => toast({ variant: 'info', message, title });
export const warn = (message, title) => toast({ variant: 'warning', message, title });
export const error = (message, title) => toast({ variant: 'error', message, title: title || 'Something went wrong' });

/** Drop everything — used when a page unmounts mid-burst. */
export function clearToasts() {
  for (const entry of [...active]) dismiss(entry.id);
}

export const Toast = { toast, dismiss, ok, info, warn, error, clear: clearToasts, get count() { return active.length; } };
