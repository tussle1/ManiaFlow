/**
 * Primitives — the small building blocks every page composes from.
 *
 * These are functions returning elements, not classes with lifecycles: a page builds its
 * tree once, then updates the specific nodes it holds references to. That is what keeps a
 * 60 fps preview from re-creating DOM, and it is why nothing here subscribes to anything.
 */

import { h, setText, setStyles, clear } from '../utils/dom.js';
import { icon } from './Icon.js';
import { button } from './Button.js';

/** A bordered surface with an optional header and footer. */
export function panel(config = {}) {
  const root = h(`div.panel${config.class ? `.${config.class.split(' ').join('.')}` : ''}`);
  const parts = { root, head: null, body: null, foot: null };

  if (config.title || config.actions) {
    parts.head = h('div.panel__head');
    if (config.title) {
      const title = h('div.panel__title');
      if (config.icon) title.append(icon(config.icon, { size: 15 }));
      title.append(h('span.truncate', config.title));
      if (config.badge) title.append(badge(config.badge));
      parts.head.append(title);
    }
    if (config.subtitle) parts.head.append(h('span.small.muted.truncate', config.subtitle));
    parts.head.append(h('div.grow'));
    if (config.actions) parts.head.append(h('div.row.shrink-0', ...(Array.isArray(config.actions) ? config.actions : [config.actions])));
    root.append(parts.head);
  }

  parts.body = h(`div.panel__body${config.flush ? '.panel__body--flush' : config.tight ? '.panel__body--tight' : ''}`);
  if (config.body != null) {
    for (const node of [].concat(config.body)) {
      if (node != null) parts.body.append(node instanceof Node ? node : h('div', String(node)));
    }
  }
  root.append(parts.body);

  if (config.footer) {
    parts.foot = h('div.panel__foot', ...[].concat(config.footer));
    root.append(parts.foot);
  }

  parts.setTitle = (text) => {
    const span = parts.head?.querySelector('.panel__title span');
    if (span) setText(span, text);
  };
  parts.setBody = (...nodes) => { clear(parts.body); parts.body.append(...nodes.filter((n) => n != null)); };
  return parts;
}

/** One labelled number. `value` is written later through `setValue`. */
export function stat(config = {}) {
  const root = h('div.stat');
  const label = h('div.stat__label', config.label || '');
  const value = h(`div.stat__value${config.accent ? '.stat__value--accent' : ''}`, config.value ?? '—');
  const hint = config.hint ? h('div.stat__hint', config.hint) : null;
  root.append(label, value, hint);
  if (config.tooltip) root.dataset.tooltip = config.tooltip;
  return {
    root,
    setValue(next, { flash = false } = {}) {
      const text = next == null || next === '' ? '—' : String(next);
      if (value.textContent === text) return;
      setText(value, text);
      if (flash) {
        value.classList.remove('value-flash');
        // Restarting a CSS animation needs a reflow between removing and adding the class.
        void value.offsetWidth;
        value.classList.add('value-flash');
      }
    },
    setHint(next) { if (hint) setText(hint, next ?? ''); },
    setLabel(next) { setText(label, next); },
  };
}

/** A small pill. `variant` colours it; the text always says what it means. */
export function badge(config = {}) {
  if (typeof config === 'string') return h(`span.badge`, config);
  const variant = config.variant ? `.badge--${config.variant}` : '';
  const node = h(`span.badge${variant}`);
  if (config.icon) node.append(icon(config.icon, { size: 11 }));
  node.append(h('span', config.label ?? config.text ?? ''));
  if (config.tooltip) node.dataset.tooltip = config.tooltip;
  node.setLabel = (text) => setText(node.lastElementChild, text);
  return node;
}

/** A selectable pill, used for speed chips and filter toggles. */
export function chip(config = {}) {
  const node = h(`button.chip${config.static ? '.chip--static' : ''}`, {
    type: 'button',
    'data-tooltip': config.tooltip || null,
    'aria-pressed': config.on == null ? null : config.on ? 'true' : 'false',
    disabled: config.static ? null : !!config.disabled,
  });
  if (config.icon) node.append(icon(config.icon, { size: 12 }));
  node.append(h('span', config.label ?? ''));
  node.classList.toggle('is-on', !!config.on);
  if (!config.static && typeof config.onClick === 'function') {
    node.addEventListener('click', () => config.onClick(node));
  }
  node.setOn = (on) => {
    node.classList.toggle('is-on', !!on);
    if (node.getAttribute('aria-pressed') !== null) node.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  node.setLabel = (text) => setText(node.lastElementChild, text);
  return node;
}

/** A status dot plus text — never colour alone. */
export function statusDot(config = {}) {
  const level = config.level || 'idle';
  const node = h('span.row.shrink-0', { style: { gap: '6px' } });
  const dot = h(`span.dot.dot--${level}${config.live ? '.dot--live' : ''}`);
  const text = h('span.truncate', config.label || '');
  node.append(dot, text);
  if (config.tooltip) node.dataset.tooltip = config.tooltip;
  node.set = (next) => {
    dot.className = `dot.dot--${next.level || 'idle'}${next.live ? ' dot--live' : ''}`;
    setText(text, next.label || '');
    if (next.tooltip) node.dataset.tooltip = next.tooltip;
    else delete node.dataset.tooltip;
  };
  return { root: node, dot, text, set: node.set };
}

/** An empty state that says what is missing and what to do about it. */
export function emptyState(config = {}) {
  const root = h('div.empty');
  if (config.icon) root.append(h('div.empty__icon', icon(config.icon, { size: 19 })));
  if (config.title) root.append(h('div.empty__title', config.title));
  if (config.body) root.append(h('div.empty__body', config.body));
  if (config.actions?.length) root.append(h('div.empty__actions', ...config.actions));
  if (config.secondary) root.append(h('div.small.faint', { style: { marginTop: '4px' } }, config.secondary));
  return root;
}

/** A row of label/value pairs, for metadata and diagnostics. */
export function definitionList(rows = []) {
  const root = h('dl.dl');
  const cells = [];
  for (const row of rows) {
    const dt = h('dt', row.label);
    const dd = h('dd');
    dd.append(row.value instanceof Node ? row.value : h('span', row.value == null ? '—' : String(row.value)));
    if (row.mono) dd.classList.add('num');
    if (row.tooltip) dd.dataset.tooltip = row.tooltip;
    root.append(dt, dd);
    cells.push({ dt, dd, key: row.key || row.label });
  }
  return {
    root,
    set(key, value) {
      const cell = cells.find((c) => c.key === key);
      if (!cell) return;
      if (value instanceof Node) { clear(cell.dd); cell.dd.append(value); }
      else setText(cell.dd.firstElementChild || cell.dd, value == null ? '—' : String(value));
    },
  };
}

export function spinner(size = 'md') {
  return h(`div.spinner${size === 'lg' ? '.spinner--lg' : ''}`, { role: 'progressbar', 'aria-label': 'Working' });
}

/** A labelled note used for warnings and honest limitations. */
export function note(config = {}) {
  const variant = config.variant ? `.note--${config.variant}` : '';
  const root = h(`div.note${variant}`);
  root.append(icon(config.icon || 'info', { size: 15 }));
  const body = h('div.grow');
  if (config.title) body.append(h('div.strong', { style: { marginBottom: '2px' } }, config.title));
  body.append(h('div', config.text instanceof Node ? config.text : String(config.text ?? '')));
  if (config.actions?.length) body.append(h('div.row', { style: { marginTop: '8px' } }, ...config.actions));
  root.append(body);
  return root;
}

/** The "this is a simulation, not gameplay" banner. It appears wherever that matters. */
export function simulationBanner(text) {
  return h('div.sim-banner',
    icon('alert', { size: 14 }),
    h('div', h('strong', 'Simulation. '), text || 'This is ManiaFlow’s own playback of the chart. It is not a play inside Ashtonk!mania and it is not scored.'),
  );
}

/** A horizontal meter. */
export function meter(config = {}) {
  const root = h('div.meter', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' });
  const fill = h(`div.meter__fill${config.variant ? `.meter__fill--${config.variant}` : ''}`);
  root.append(fill);
  if (config.label) root.setAttribute('aria-label', config.label);
  return {
    root,
    set(ratio) {
      const value = Math.max(0, Math.min(1, Number(ratio) || 0));
      setStyles(fill, { width: `${value * 100}%` });
      root.setAttribute('aria-valuenow', String(Math.round(value * 100)));
    },
  };
}

/** A key cap, used by the mapping tester and the shortcut reference. */
export function keycap(config = {}) {
  const root = h('div.keycap', { 'data-tooltip': config.tooltip || null });
  const label = h('span', config.label ?? '—');
  root.append(label);
  if (config.lane != null) root.append(h('span.keycap__lane', `Lane ${config.lane + 1}`));
  return {
    root,
    setDown(down) { root.classList.toggle('is-down', !!down); },
    setLabel(text) { setText(label, text); },
    setTarget(on) { root.classList.toggle('is-target', !!on); },
  };
}

/** A row of tabs sharing one aria-selected state. */
export function tabs(config = {}) {
  const id = config.id || `tabs-${Math.random().toString(36).slice(2, 8)}`;
  const list = h('div.tabs', { role: 'tablist', 'aria-label': config.label || 'Sections' });
  const nodes = new Map();
  // Tracked here rather than read back from `config.active`. The config holds the value the
  // caller started with; navigating from that would make every arrow press after the first
  // move relative to the wrong tab.
  let active = config.active;

  for (const tab of config.tabs) {
    const node = h('button.tab', {
      type: 'button', role: 'tab', id: `${id}-${tab.id}`,
      'aria-selected': tab.id === active ? 'true' : 'false',
      'aria-controls': `${id}-panel-${tab.id}`,
      tabindex: tab.id === active ? '0' : '-1',
    }, tab.label);
    if (tab.count != null) node.append(h('span.badge', { style: { marginLeft: '6px' } }, String(tab.count)));
    node.addEventListener('click', () => select(tab.id));
    list.append(node);
    nodes.set(tab.id, node);
  }

  function select(tabId) {
    active = tabId;
    for (const [key, node] of nodes) {
      const on = key === tabId;
      node.setAttribute('aria-selected', on ? 'true' : 'false');
      node.tabIndex = on ? 0 : -1;
    }
    config.onChange?.(tabId);
  }

  // Roving tabindex: arrow keys move between tabs, as the ARIA authoring practice expects.
  list.addEventListener('keydown', (event) => {
    const ids = [...nodes.keys()];
    const index = ids.indexOf(active);
    let next = null;
    if (event.key === 'ArrowRight') next = ids[(index + 1) % ids.length];
    else if (event.key === 'ArrowLeft') next = ids[(index - 1 + ids.length) % ids.length];
    else if (event.key === 'Home') next = ids[0];
    else if (event.key === 'End') next = ids[ids.length - 1];
    if (!next) return;
    event.preventDefault();
    select(next);
    nodes.get(next)?.focus();
  });

  return {
    root: list,
    get value() { return active; },
    select,
    setCount: (tabId, count) => { const node = nodes.get(tabId)?.querySelector('.badge'); if (node) setText(node, String(count)); },
  };
}

/**
 * A tiny line chart drawn on a canvas, reused across the Statistics and Timing Lab pages.
 * One canvas, redrawn on demand — no library and no per-point DOM.
 */
export function sparkline(config = {}) {
  const canvas = h('canvas', { width: '300', height: '48', 'aria-hidden': 'true', style: { width: '100%', height: `${config.height || 48}px`, display: 'block' } });
  const label = config.label ? h('span.sr-only', config.label) : null;

  function draw(values, options = {}) {
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, canvas.clientWidth || 300);
    const height = config.height || 48;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const list = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(+v)).map(Number);
    if (list.length < 2) {
      ctx.fillStyle = cssVar('--fg-faint');
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('Not enough data', 8, height / 2 + 4);
      return;
    }
    const min = options.min ?? Math.min(...list);
    const max = options.max ?? Math.max(...list);
    const span = max - min || 1;
    const pad = 3;
    const x = (i) => pad + (i / (list.length - 1)) * (width - pad * 2);
    const y = (v) => height - pad - ((v - min) / span) * (height - pad * 2);

    if (options.zeroLine && min < 0 && max > 0) {
      ctx.strokeStyle = cssVar('--line-soft');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, y(0));
      ctx.lineTo(width - pad, y(0));
      ctx.stroke();
    }
    if (options.fill !== false) {
      ctx.beginPath();
      ctx.moveTo(x(0), y(list[0]));
      for (let i = 1; i < list.length; i++) ctx.lineTo(x(i), y(list[i]));
      ctx.lineTo(x(list.length - 1), height);
      ctx.lineTo(x(0), height);
      ctx.closePath();
      ctx.fillStyle = options.fillColor || 'color-mix(in srgb, var(--accent) 14%, transparent)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(x(0), y(list[0]));
    for (let i = 1; i < list.length; i++) ctx.lineTo(x(i), y(list[i]));
    ctx.strokeStyle = options.color || cssVar('--accent');
    ctx.lineWidth = options.lineWidth || 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    if (options.points) {
      ctx.fillStyle = options.color || cssVar('--accent');
      for (let i = 0; i < list.length; i++) {
        ctx.beginPath();
        ctx.arc(x(i), y(list[i]), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const root = label ? h('div', canvas, label) : canvas;
  return { root, canvas, draw };
}

/** Read a CSS custom property once; canvases cannot use var() in a fill style. */
export function cssVar(name, fallback = '#888') {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** A section heading with an optional note on the right. */
export function sectionHead(title, noteText, actions) {
  return h('div.section__head',
    h('h2.section__title', title),
    noteText ? h('span.section__note', noteText) : null,
    actions ? h('div.row.shrink-0', ...[].concat(actions)) : null,
  );
}

/** A button with a keyboard hint beside it, for the shortcut reference. */
export function shortcutRow(label, keys, description) {
  return h('div.shortcut-row',
    h('div',
      h('div', label),
      description ? h('div.xs.muted', description) : null,
    ),
    h('div.shortcut-row__keys', ...[].concat(keys).map((key) => h('span.kbd', key))),
  );
}

export { button, icon };
