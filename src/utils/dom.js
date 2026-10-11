/**
 * DOM helpers.
 *
 * There is no framework here on purpose: the app is a handful of screens with a canvas in
 * the middle, and a 200-line helper keeps every byte of the UI inspectable. Two rules are
 * baked in because they are the ones that cause real bugs:
 *
 *   1. `setText` / `setStyle` compare before writing, so a 60 fps update loop touching the
 *      same twelve nodes does not invalidate layout twelve times a frame.
 *   2. Every listener, timer and animation frame is registered through a `Scope`, which
 *      tears them all down when a page unmounts. Nothing is left to leak.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Set of properties that must go through the DOM API rather than setAttribute. */
const DOM_PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'textContent', 'innerHTML', 'scrollTop', 'files']);

/**
 * Create an element.
 * `h('button.btn.primary', { onclick, title }, 'Play', iconEl)`
 */
export function h(spec, props, ...children) {
  let tag = 'div';
  let id = null;
  const classes = [];
  const parts = String(spec).split(/(?=[.#])/);
  for (const part of parts) {
    if (!part) continue;
    if (part[0] === '.') classes.push(part.slice(1));
    else if (part[0] === '#') id = part.slice(1);
    else tag = part;
  }

  const isSvg = tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'rect'
    || tag === 'g' || tag === 'line' || tag === 'polyline' || tag === 'polygon' || tag === 'text';
  const node = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (classes.length) node.setAttribute('class', classes.join(' '));
  if (id) node.id = id;
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) applyProps(node, props);
  append(node, children);
  return node;
}

export function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      const list = Array.isArray(value) ? value.filter(Boolean) : String(value).split(/\s+/).filter(Boolean);
      node.setAttribute('class', list.join(' '));
    } else if (key === 'style' && typeof value === 'object') {
      setStyles(node, value);
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dk, dv] of Object.entries(value)) if (dv != null) node.dataset[dk] = dv;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'ref' && typeof value === 'function') {
      value(node);
    } else if (DOM_PROPS.has(key)) {
      node[key] = value;
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Write text only when it actually changes. */
export function setText(node, text) {
  const next = text == null ? '' : String(text);
  if (node && node.textContent !== next) node.textContent = next;
  return node;
}

/** Write inline styles only when they actually change. */
export function setStyles(node, styles) {
  if (!node) return node;
  const cache = node.__mfStyles || (node.__mfStyles = Object.create(null));
  for (const [key, value] of Object.entries(styles)) {
    const next = value == null ? '' : String(value);
    if (cache[key] === next) continue;
    cache[key] = next;
    node.style.setProperty(key, next);
  }
  return node;
}

export function setAttr(node, name, value) {
  if (!node) return node;
  const next = value == null ? null : String(value);
  if (node.getAttribute(name) === next) return node;
  if (next === null) node.removeAttribute(name);
  else node.setAttribute(name, next);
  return node;
}

export function toggleClass(node, name, on) {
  if (node) node.classList.toggle(name, !!on);
  return node;
}

export function clear(node) {
  if (node) node.replaceChildren();
  return node;
}

export const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * A teardown scope. Listeners, timers and animation frames registered through a Scope are
 * released together, which is what keeps page changes from accumulating handlers.
 */
export class Scope {
  constructor() {
    this._cleanups = [];
    this._disposed = false;
  }

  get disposed() { return this._disposed; }

  /** Register a listener and return a function that removes it. */
  on(target, type, handler, options) {
    if (this._disposed || !target) return () => {};
    target.addEventListener(type, handler, options);
    const remove = () => target.removeEventListener(type, handler, options);
    this._cleanups.push(remove);
    return remove;
  }

  /** Register a listener that removes itself after one call. */
  once(target, type, handler, options) {
    if (this._disposed || !target) return () => {};
    const wrapped = (event) => { handler(event); remove(); };
    const remove = this.on(target, type, wrapped, options);
    return remove;
  }

  interval(fn, ms) {
    if (this._disposed) return () => {};
    const id = setInterval(fn, ms);
    const stop = () => clearInterval(id);
    this._cleanups.push(stop);
    return stop;
  }

  timeout(fn, ms) {
    if (this._disposed) return () => {};
    let id = setTimeout(() => { this._forget(stop); fn(); }, ms);
    const stop = () => { clearTimeout(id); this._forget(stop); };
    this._cleanups.push(stop);
    return stop;
  }

  /** An animation-frame loop that stops when the scope is disposed. */
  frameLoop(callback) {
    if (this._disposed) return () => {};
    let frame = 0;
    let stopped = false;
    const step = (timestamp) => {
      if (stopped) return;
      frame = requestAnimationFrame(step);
      callback(timestamp);
    };
    frame = requestAnimationFrame(step);
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      this._forget(stop);
    };
    this._cleanups.push(stop);
    return stop;
  }

  /** Run something when the scope is disposed — for canvas contexts, observers, WebSockets. */
  defer(cleanup) {
    if (this._disposed) { try { cleanup(); } catch { /* teardown is best effort */ } return () => {}; }
    if (typeof cleanup === 'function') this._cleanups.push(cleanup);
    return () => this._forget(cleanup);
  }

  _forget(cleanup) {
    const index = this._cleanups.indexOf(cleanup);
    if (index >= 0) this._cleanups.splice(index, 1);
  }

  /** Run every registered cleanup, newest first, exactly once. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const cleanups = this._cleanups.reverse();
    this._cleanups = [];
    for (const cleanup of cleanups) {
      try { cleanup(); } catch (err) { console.error('[ManiaFlow] cleanup failed', err); }
    }
  }
}

/**
 * Keep focus inside a container while it is open, and give it back afterwards.
 * Used by dialogs; returns a disposer.
 */
export function trapFocus(container, { initialFocus } = {}) {
  const previous = document.activeElement;
  const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

  const focusables = () => qsa(FOCUSABLE, container).filter((node) => node.offsetParent !== null || node === document.activeElement);

  const target = initialFocus && container.contains(initialFocus) ? initialFocus : focusables()[0];
  if (target) target.focus({ preventScroll: true });

  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  container.addEventListener('keydown', onKeyDown);
  return () => {
    container.removeEventListener('keydown', onKeyDown);
    if (previous && previous.isConnected && typeof previous.focus === 'function') {
      previous.focus({ preventScroll: true });
    }
  };
}

/** Distinguish a keyboard focus from a mouse one, so clicks do not paint focus rings. */
export function installFocusMode(scope) {
  const root = document.documentElement;
  const onPointer = () => root.classList.add('js-focus-mouse');
  const onKey = (event) => {
    if (event.key === 'Tab') root.classList.remove('js-focus-mouse');
  };
  scope.on(window, 'pointerdown', onPointer, { passive: true, capture: true });
  scope.on(window, 'keydown', onKey, true);
  return () => root.classList.remove('js-focus-mouse');
}

/** Device pixel ratio, capped so a 3× phone does not allocate a 9× canvas. */
export function pixelRatio(cap = 2) {
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.min(cap, Math.max(1, ratio));
}

/**
 * Size a canvas to its box at the current device pixel ratio.
 * Returns false when nothing changed, so a resize observer can skip the redraw.
 */
export function sizeCanvas(canvas, { cap = 2 } = {}) {
  const ratio = pixelRatio(cap);
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}
