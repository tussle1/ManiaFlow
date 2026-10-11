/**
 * A minimal DOM, enough to mount ManiaFlow in Node.
 *
 * There is no browser in CI and no headless Chrome here, and a jsdom dependency would be
 * the only third-party package in the project. So this stub implements the slice of the DOM
 * ManiaFlow actually uses — the tree, attributes, classes, datasets, styles, events, a
 * selector engine covering the selectors the app really writes, a recording 2D canvas
 * context, and the window globals the pages touch.
 *
 * It is a test double, not a browser: its purpose is to prove that constructing every page
 * and tearing it down again throws nothing, leaks no listeners and leaves no animation
 * frames behind. Visual correctness is not something a stub can verify, and this does not
 * pretend to.
 */

let idSeq = 0;

/**
 * `classList` and the `class` attribute are two views of one piece of state in a real DOM.
 * Backing the list with the attribute — rather than a separate Set — is what makes
 * `setAttribute('class', …)` and `el.classList.contains(…)` agree, which the application
 * relies on constantly (elements are built with `h('div.panel')` and toggled with
 * `classList.toggle`).
 */
class ClassList {
  constructor(element) { this.el = element; }
  get _list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _write(list) {
    if (list.length) this.el.attributes.set('class', list.join(' '));
    else this.el.attributes.delete('class');
  }
  add(...names) {
    const list = this._list;
    for (const name of names) if (name && !list.includes(name)) list.push(name);
    this._write(list);
  }
  remove(...names) { this._write(this._list.filter((name) => !names.includes(name))); }
  contains(name) { return this._list.includes(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
  get length() { return this._list.length; }
  [Symbol.iterator]() { return this._list[Symbol.iterator](); }
  toString() { return this._list.join(' '); }
}

// Direct camelCase style assignment (`node.style.width = '10px'`) must reach the same store
// as setProperty, so the style object is a Proxy over one Map.
function makeStyle(element) {
  const store = new Map();
  const api = {
    setProperty: (name, value) => { store.set(name, value == null ? '' : String(value)); },
    removeProperty: (name) => { store.delete(name); },
    getPropertyValue: (name) => store.get(name) ?? '',
    get cssText() { return [...store].map(([k, v]) => `${k}: ${v};`).join(' '); },
    _store: store,
  };
  return new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string') return store.get(camelToKebab(prop)) ?? '';
      return undefined;
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && !(prop in target)) store.set(camelToKebab(prop), value == null ? '' : String(value));
      else target[prop] = value;
      return true;
    },
  });
}

function camelToKebab(name) {
  return name.startsWith('--') ? name : name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

class Node {
  constructor(nodeName) {
    this.nodeName = nodeName;
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = new Map();
    this.uid = ++idSeq;
  }

  get children() { return this.childNodes.filter((n) => n instanceof Element); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === globalThis.document;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node == null || node === false || node === true) continue;
      const child = node instanceof Node ? node : new Text(String(node));
      child.remove();
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  prepend(...nodes) {
    const list = nodes.filter((n) => n != null && n !== false).map((n) => (n instanceof Node ? n : new Text(String(n))));
    for (const child of list) child.remove();
    for (const [i, child] of list.entries()) { child.parentNode = this; this.childNodes.splice(i, 0, child); }
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }

  addEventListener(type, handler, options) {
    if (typeof handler !== 'function') return;
    const capture = options === true || options?.capture === true;
    const key = `${capture ? 'c' : 'b'}:${type}`;
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    const list = this._listeners.get(key);
    if (!list.some((entry) => entry.handler === handler)) list.push({ handler, options });
  }

  removeEventListener(type, handler, options) {
    const capture = options === true || options?.capture === true;
    const key = `${capture ? 'c' : 'b'}:${type}`;
    const list = this._listeners.get(key);
    if (!list) return;
    const index = list.findIndex((entry) => entry.handler === handler);
    if (index >= 0) list.splice(index, 1);
    if (!list.length) this._listeners.delete(key);
  }

  /** Dispatch with capture-then-target-then-bubble, as the DOM does. */
  dispatchEvent(event) {
    event.target = event.target || this;
    const path = [];
    let node = this;
    while (node) { path.unshift(node); node = node.parentNode; }

    for (const current of path) {
      event.currentTarget = current;
      for (const entry of current._listeners.get(`c:${event.type}`) || []) {
        entry.handler.call(current, event);
        if (event._stopped) return !event.defaultPrevented;
      }
    }
    event.eventPhase = 2;
    event.currentTarget = this;
    for (const entry of this._listeners.get(`b:${event.type}`) || []) {
      entry.handler.call(this, event);
      if (event._stopped) return !event.defaultPrevented;
    }
    if (event.bubbles) {
      event.eventPhase = 3;
      for (let i = path.length - 2; i >= 0; i--) {
        const current = path[i];
        event.currentTarget = current;
        for (const entry of current._listeners.get(`b:${event.type}`) || []) {
          entry.handler.call(current, event);
          if (event._stopped) return !event.defaultPrevented;
        }
      }
    }
    return !event.defaultPrevented;
  }

  get listenerCount() {
    let total = 0;
    for (const list of this._listeners.values()) total += list.length;
    return total;
  }

  /** Every descendant element, in document order. On Node so `document` can query too. */
  get descendants() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) { out.push(child); walk(child); }
    };
    walk(this);
    return out;
  }
}

class Text extends Node {
  constructor(data) { super('#text'); this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class Element extends Node {
  constructor(tagName, namespace = null) {
    super(tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.namespaceURI = namespace;
    this.attributes = new Map();
    this.classList = new ClassList(this);
    this.style = makeStyle(this);
    this.dataset = makeDataset(this);
    this.scrollTop = 0;
    this.clientWidth = 640;
    this.clientHeight = 360;
    this.offsetWidth = 640;
    this.offsetHeight = 360;
    this.offsetParent = {};
    this._value = '';
  }

  get className() { return this.attributes.get('class') || ''; }
  set className(value) { this.setAttribute('class', String(value).trim()); }

  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.setAttribute('id', value); }

  setAttribute(name, value) { this.attributes.set(name, value == null ? '' : String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== '' && value != null) this.append(new Text(String(value)));
  }

  get innerHTML() { return ''; }
  set innerHTML(value) {
    // Only used to clear a container; parsing HTML is deliberately not implemented.
    if (value === '' || value == null) this.textContent = '';
    else throw new Error('the DOM stub does not parse innerHTML; use textContent or append()');
  }

  get value() { return this._value; }
  set value(v) { this._value = v == null ? '' : String(v); }
  get disabled() { return this.hasAttribute('disabled') && this.getAttribute('disabled') !== 'false'; }
  get tabIndex() {
    const raw = this.getAttribute('tabindex');
    return raw == null ? 0 : (Number.isFinite(Number.parseInt(raw, 10)) ? Number.parseInt(raw, 10) : 0);
  }
  set tabIndex(value) { this.setAttribute('tabindex', String(value)); }
  set disabled(on) { if (on) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get hidden() { return this.attributes.has('hidden'); }
  set hidden(on) { if (on) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get inert() { return this.attributes.has('inert'); }
  set inert(on) { if (on) this.setAttribute('inert', ''); else this.removeAttribute('inert'); }

  focus() { globalThis.document.activeElement = this; }
  blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = globalThis.document.body; }
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getAnimations() { return []; }
  getBoundingClientRect() { return { top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight, x: 0, y: 0 }; }

  querySelector(selector) { return queryAll(this, selector, true)[0] || null; }
  querySelectorAll(selector) { return queryAll(this, selector, false); }
  matches(selector) { return matchesSelector(this, selector); }
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  closest(selector) {
    let node = this;
    while (node instanceof Element) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  getContext(kind) {
    if (kind !== '2d') return null;
    if (!this._ctx) this._ctx = makeContext2D(this);
    return this._ctx;
  }
}

function makeDataset(element) {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      const value = element.getAttribute(`data-${camelToKebab(prop)}`);
      return value == null ? undefined : value;
    },
    set(_t, prop, value) {
      if (value == null) element.removeAttribute(`data-${camelToKebab(prop)}`);
      else element.setAttribute(`data-${camelToKebab(prop)}`, String(value));
      return true;
    },
    deleteProperty(_t, prop) { element.removeAttribute(`data-${camelToKebab(prop)}`); return true; },
    has(_t, prop) { return element.hasAttribute(`data-${camelToKebab(prop)}`); },
    ownKeys() {
      return [...element.attributes.keys()].filter((k) => k.startsWith('data-'))
        .map((k) => k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
    },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
}

/* ── selectors ───────────────────────────────────────────────────────── */

/**
 * Supported: comma lists, `tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`, `*`,
 * descendant (space) and child (`>`) combinators, `:not(...)`, `:first-child`,
 * `:last-child`. That is the whole set the application writes.
 */
function parseCompound(text) {
  const parts = { tag: null, classes: [], id: null, attrs: [], nots: [], pseudo: [] };
  const re = /(^[a-zA-Z][\w-]*)|(\*)|(\.[-\w]+)|(#[-\w]+)|(\[[^\]]+\])|(:[-\w]+(?:\([^)]*\))?)/g;
  for (const match of text.matchAll(re)) {
    const token = match[0];
    if (token.startsWith('.')) parts.classes.push(token.slice(1));
    else if (token.startsWith('#')) parts.id = token.slice(1);
    else if (token.startsWith('[')) {
      const inner = token.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq < 0) parts.attrs.push({ name: inner.trim(), value: null });
      else parts.attrs.push({ name: inner.slice(0, eq).trim(), value: inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '') });
    } else if (token.startsWith(':')) {
      if (token.startsWith(':not(')) parts.nots.push(token.slice(5, -1));
      else parts.pseudo.push(token.slice(1));
    } else if (token === '*') { /* matches anything */ }
    else parts.tag = token.toLowerCase();
  }
  return parts;
}

function matchesCompound(element, parts) {
  if (!(element instanceof Element)) return false;
  if (parts.tag && element.localName !== parts.tag) return false;
  if (parts.id && element.id !== parts.id) return false;
  for (const className of parts.classes) if (!element.classList.contains(className)) return false;
  for (const attr of parts.attrs) {
    if (!element.hasAttribute(attr.name)) return false;
    if (attr.value !== null && element.getAttribute(attr.name) !== attr.value) return false;
  }
  for (const not of parts.nots) if (matchesSelector(element, not)) return false;
  for (const pseudo of parts.pseudo) {
    const siblings = element.parentElement?.children || [];
    if (pseudo === 'first-child' && siblings[0] !== element) return false;
    if (pseudo === 'last-child' && siblings[siblings.length - 1] !== element) return false;
    if (pseudo === 'active') return false;   // nothing is :active in a stub
  }
  return true;
}

function matchesSelector(element, selector) {
  return String(selector).split(',').some((group) => matchesGroup(element, group.trim()));
}

function matchesGroup(element, group) {
  // Split on combinators, keeping them, then walk right to left.
  const tokens = group.split(/\s*(>)\s*|\s+/).filter((t) => t !== undefined && t !== '');
  const steps = [];
  for (const token of tokens) steps.push(token);
  let index = steps.length - 1;
  if (!matchesCompound(element, parseCompound(steps[index]))) return false;
  let current = element;
  index--;
  while (index >= 0) {
    const combinator = steps[index] === '>' ? '>' : ' ';
    if (steps[index] === '>') index--;
    const selectorPart = steps[index];
    if (!selectorPart) return false;
    const compound = parseCompound(selectorPart);
    let ancestor = combinator === '>' ? current.parentElement : current.parentElement;
    if (combinator === '>') {
      if (!ancestor || !matchesCompound(ancestor, compound)) return false;
      current = ancestor;
    } else {
      let found = null;
      let walk = ancestor;
      while (walk) { if (matchesCompound(walk, compound)) { found = walk; break; } walk = walk.parentElement; }
      if (!found) return false;
      current = found;
    }
    index--;
  }
  return true;
}

function queryAll(root, selector, firstOnly) {
  const groups = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  const found = [];
  for (const element of root.descendants) {
    if (groups.some((group) => matchesGroup(element, group))) {
      found.push(element);
      if (firstOnly) return found;
    }
  }
  return found;
}

/* ── canvas ──────────────────────────────────────────────────────────── */

/** A 2D context that records calls instead of painting, so a draw loop can be verified. */
function makeContext2D(canvas) {
  const calls = { fillRect: 0, stroke: 0, fill: 0, beginPath: 0, fillText: 0, arc: 0, moveTo: 0, lineTo: 0 };
  const noop = () => {};
  const ctx = {
    canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '',
    textAlign: 'start', textBaseline: 'alphabetic', lineJoin: 'miter', lineCap: 'butt',
    setTransform: noop, clearRect: noop, save: noop, restore: noop, clip: noop,
    quadraticCurveTo: noop, closePath: noop, rect: noop, setLineDash: noop,
    translate: noop, scale: noop, rotate: noop,
    beginPath() { calls.beginPath++; },
    moveTo() { calls.moveTo++; },
    lineTo() { calls.lineTo++; },
    arc() { calls.arc++; },
    fill() { calls.fill++; },
    stroke() { calls.stroke++; },
    fillRect() { calls.fillRect++; },
    fillText() { calls.fillText++; },
    measureText(text) { return { width: String(text).length * 6 }; },
    _calls: calls,
  };
  return ctx;
}

/* ── events ──────────────────────────────────────────────────────────── */

class DomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this._stopped = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 1;
    this.timeStamp = performance.now();
    Object.assign(this, init);
  }

  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; }
}

class KeyboardEventStub extends DomEvent {
  constructor(type, init = {}) {
    super(type, { bubbles: true, cancelable: true, ...init });
    this.key = init.key ?? '';
    this.code = init.code ?? '';
    this.repeat = !!init.repeat;
    this.ctrlKey = !!init.ctrlKey;
    this.shiftKey = !!init.shiftKey;
    this.altKey = !!init.altKey;
    this.metaKey = !!init.metaKey;
    this.isTrusted = false;   // exactly what a constructed event reports in a browser
  }
}

/* ── storage ─────────────────────────────────────────────────────────── */

export class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
  /** Test hook: pretend the store is full. */
  failWritesWith(error) { this._failure = error; }
  setItemOrFail(key, value) { if (this._failure) throw this._failure; this.setItem(key, value); }
}

/* ── window / document ───────────────────────────────────────────────── */

export function installDom(options = {}) {
  const document = new Node('#document');
  Object.assign(document, {
    nodeType: 9,
    hidden: false,
    visibilityState: 'visible',
    activeElement: null,
    createElement: (tag) => new Element(tag),
    createElementNS: (ns, tag) => new Element(tag, ns),
    createTextNode: (text) => new Text(text),
    createDocumentFragment: () => new Element('#fragment'),
    getElementById: (id) => queryAll(document, `#${id}`, true)[0] || null,
    querySelector: (sel) => queryAll(document, sel, true)[0] || null,
    querySelectorAll: (sel) => queryAll(document, sel, false),
    execCommand: () => true,
  });
  document.documentElement = new Element('html');
  document.body = new Element('body');
  document.head = new Element('head');
  document.documentElement.append(document.head, document.body);
  document.append(document.documentElement);
  document.activeElement = document.body;

  const frames = new Map();
  let frameSeq = 0;
  let currentTime = 0;

  const location = {
    href: options.url || 'http://127.0.0.1:4310/',
    hash: options.hash || '',
    pathname: '/', search: '', origin: 'http://127.0.0.1:4310', protocol: 'http:',
    host: '127.0.0.1:4310',
  };

  const window = new Node('#window');
  Object.assign(window, {
    document,
    location,
    history: { replaceState: (_s, _t, url) => { if (url) location.hash = String(url).split('#')[1] ? `#${String(url).split('#')[1]}` : location.hash; }, pushState() {} },
    navigator: { userAgent: 'ManiaFlow test stub', clipboard: null, language: 'en' },
    innerWidth: options.width || 1440,
    innerHeight: options.height || 900,
    devicePixelRatio: options.dpr || 2,
    localStorage: new MemoryStorage(),
    performance,
    Element, Node, Text,
    KeyboardEvent: KeyboardEventStub,
    Event: DomEvent,
    CustomEvent: DomEvent,
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} },
    WebSocket: options.WebSocket || FakeWebSocket,
    Audio: class { constructor(src) { this.src = src; this.currentTime = 0; this.duration = 60; this.paused = true; this.playbackRate = 1; this.preservesPitch = true; this.volume = 1; } play() { this.paused = false; return Promise.resolve(); } pause() { this.paused = true; } load() {} addEventListener() {} removeEventListener() {} removeAttribute() {} },
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    matchMedia: (query) => ({
      matches: options.reducedMotion === true && /prefers-reduced-motion/.test(query),
      media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }),
    getComputedStyle: () => ({ getPropertyValue: (name) => CSS_VARS[name] ?? '' }),
    requestAnimationFrame(cb) { const id = ++frameSeq; frames.set(id, cb); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    fetch: options.fetch || (async () => ({ ok: false, status: 0, json: async () => ({}) })),
    open: () => null,
    scrollX: 0, scrollY: 0,
    __frames: frames,
    __runFrames(times = 1, advanceMs = 16) {
      for (let i = 0; i < times; i++) {
        currentTime += advanceMs;
        const batch = [...frames.entries()];
        frames.clear();
        for (const [, cb] of batch) cb(currentTime);
      }
    },
    __frameCount: () => frames.size,
  });
  window.window = window;
  window.self = window;
  window.globalThis = window;
  window.top = window;

  const CSS_VARS = {
    '--bg-sunken': '#0b0c0f', '--grid': 'rgba(255,255,255,0.045)', '--grid-major': 'rgba(255,255,255,0.09)',
    '--receptor': 'rgba(255,255,255,0.24)', '--accent': '#7c5cff', '--accent-bright': '#a48bff',
    '--note-hold': '#6a48e0', '--note-past': '#3a4048', '--note-sim': '#d9a441', '--fg-dim': '#a4abb7',
    '--fg-faint': '#565d69', '--ok': '#5ecf92', '--danger': '#e97373', '--warn': '#e3b268',
    '--info': '#6cb6e8', '--line-soft': 'rgba(255,255,255,0.085)', '--line-solid': 'rgba(255,255,255,0.13)',
    '--bg-active': '#232830', '--bg-app': '#08090b',
  };

  const globals = {
    window, document, location: window.location, navigator: window.navigator,
    localStorage: window.localStorage, performance,
    Element, Node, Text, HTMLElement: Element, HTMLButtonElement: Element, HTMLCanvasElement: Element,
    KeyboardEvent: KeyboardEventStub, Event: DomEvent, CustomEvent: DomEvent,
    requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame,
    matchMedia: window.matchMedia, getComputedStyle: window.getComputedStyle,
    ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver,
    WebSocket: window.WebSocket, Audio: window.Audio,
    fetch: window.fetch,
    __CSS_VARS: CSS_VARS,
  };
  const saved = new Map();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, globalThis[key]);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }

  return {
    window, document, Element, Node, Text,
    /** Every listener still registered on window and document. */
    listenerCount: () => window.listenerCount + document.listenerCount
      + document.documentElement.listenerCount + document.body.listenerCount,
    runFrames: window.__runFrames,
    frameCount: window.__frameCount,
    uninstall() {
      for (const [key, value] of saved) {
        if (value === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
      }
    },
  };
}

/** A WebSocket double that records what was sent and lets a test drive the other side. */
export class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this._listeners = new Map();
    FakeWebSocket.instances.push(this);
    // The real thing opens asynchronously; so does this one.
    setTimeout(() => this._open(), 0);
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  _emit(type, event = {}) {
    for (const handler of this._listeners.get(type) || []) handler({ type, ...event, target: this });
  }

  /** Idempotent: a socket opens once, so a second call must not re-emit `open`. */
  _open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this._emit('open');
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    this.sent.push(JSON.parse(data));
  }

  /** Test hooks. */
  simulateMessage(message) { this._emit('message', { data: JSON.stringify(message) }); }
  simulateClose(code = 1006, reason = '') { this.readyState = 3; this._emit('close', { code, reason }); }
  simulateError() { this._emit('error', {}); }
  get lastSent() { return this.sent[this.sent.length - 1] || null; }
  sentOfType(type) { return this.sent.filter((m) => m.type === type); }
  close() { this.simulateClose(1000, 'closed by the test'); }
  static reset() { FakeWebSocket.instances = []; }
}

export { Element, Text, DomEvent, KeyboardEventStub, queryAll, matchesSelector };
