/**
 * Tooltip — one floating element for the whole application.
 *
 * A tooltip per control would mean hundreds of nodes and hundreds of listeners. This is a
 * single element, positioned on demand, driven by two delegated listeners on `document`.
 * Any element with a `data-tooltip` attribute gets one, including controls created later.
 *
 * It shows on hover after a short delay and immediately on keyboard focus, hides on scroll,
 * escape, blur and pointer leave, and is `aria-hidden` — the same text is always available
 * through `title` or a visible label, so nothing depends on the tooltip to be understood.
 */

const SHOW_DELAY = 420;
const SHOW_DELAY_FOCUS = 0;
const HIDE_DELAY = 90;
const OFFSET = 8;

let element = null;
let current = null;
let showTimer = 0;
let hideTimer = 0;
let installed = false;

function ensureElement() {
  if (element && element.isConnected) return element;
  element = document.createElement('div');
  element.className = 'tooltip';
  element.setAttribute('role', 'tooltip');
  element.setAttribute('aria-hidden', 'true');
  document.body.append(element);
  return element;
}

/** Read the tooltip text for a target, walking up to the nearest element that has one. */
function textFor(target) {
  let node = target;
  while (node && node !== document.body) {
    if (node.dataset && node.dataset.tooltip) return node.dataset.tooltip;
    node = node.parentElement;
  }
  return null;
}

function show(target) {
  const text = textFor(target);
  if (!text) return;
  const node = ensureElement();
  current = target;
  node.textContent = text;
  node.classList.add('is-visible');
  position(node, target);
}

function position(node, target) {
  const rect = target.getBoundingClientRect();
  if (!rect.width && !rect.height) { hide(); return; }
  // Measure after the text is set; the element is fixed-position so this does not reflow the page.
  const size = node.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  let left = rect.left + rect.width / 2 - size.width / 2;
  let top = rect.bottom + OFFSET;
  if (top + size.height > viewport.height - 6) top = rect.top - size.height - OFFSET;
  if (top < 6) top = 6;
  left = Math.max(6, Math.min(left, viewport.width - size.width - 6));

  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function hide() {
  clearTimeout(showTimer);
  showTimer = 0;
  current = null;
  if (!element) return;
  element.classList.remove('is-visible');
}

function scheduleShow(target, delay) {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  showTimer = setTimeout(() => show(target), delay);
}

function scheduleHide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, HIDE_DELAY);
}

/** Install the delegated listeners once. Returns a teardown function. */
export function installTooltips() {
  if (installed) return () => {};
  installed = true;

  const onOver = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!textFor(target)) return;
    if (target.matches(':active')) return;
    scheduleShow(target, SHOW_DELAY);
  };
  const onOut = (event) => {
    const to = event.relatedTarget;
    if (to instanceof Element && textFor(to) && textFor(to) === textFor(event.target)) return;
    scheduleHide();
  };
  const onFocus = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !textFor(target)) return;
    // Only a keyboard focus should pop a tooltip; a click already gives its own feedback.
    if (document.documentElement.classList.contains('js-focus-mouse')) return;
    scheduleShow(target, SHOW_DELAY_FOCUS);
  };
  const onBlur = () => scheduleHide();
  const onKey = (event) => { if (event.key === 'Escape') hide(); };
  const onScroll = () => hide();
  const onDown = () => hide();

  document.addEventListener('pointerover', onOver, { passive: true });
  document.addEventListener('pointerout', onOut, { passive: true });
  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onBlur, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('wheel', onScroll, { passive: true, capture: true });
  document.addEventListener('pointerdown', onDown, { passive: true, capture: true });
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);

  return () => {
    document.removeEventListener('pointerover', onOver);
    document.removeEventListener('pointerout', onOut);
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('focusout', onBlur, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('wheel', onScroll, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', hide);
    window.removeEventListener('blur', hide);
    hide();
    element?.remove();
    element = null;
    installed = false;
  };
}

export function hideTooltip() { hide(); }
