/**
 * Form controls.
 *
 * Each control owns its DOM, reports changes through one callback, and exposes a `setValue`
 * that updates the DOM without re-firing the callback. That last part is what stops the
 * classic loop where a preference change re-renders the settings page, which writes the same
 * preference again.
 */

import { h, setText, setStyles, setAttr } from '../utils/dom.js';
import { icon } from './Icon.js';
import { num } from '../utils/validation.js';
import { formatRate, formatMs } from '../utils/formatters.js';
import { scrollSpeedToTimeRange } from '../playback/TimingEngine.js';

/** Wrap a control in a label, hint and optional error line. */
function field({ label, hint, error, control, htmlFor, layout = 'stack', actions }) {
  const root = h(`div.field${layout === 'row' ? '' : ''}`);
  const head = h('div.row.row--between', { style: { gap: '8px' } });
  const labelNode = label ? h('label.field__label', { for: htmlFor || null }, label) : null;
  if (labelNode) head.append(labelNode);
  head.append(h('div.grow'));
  if (actions) head.append(h('div.row.shrink-0', ...[].concat(actions)));
  const hintNode = hint ? h('div.field__hint', hint) : null;
  const errorNode = h('div.field__error', { style: { display: 'none' } });
  root.append(head, control, hintNode, errorNode);
  if (layout === 'row') {
    root.classList.add('row');
    root.style.alignItems = 'center';
    root.style.justifyContent = 'space-between';
    root.style.gap = '12px';
    root.replaceChildren(head, h('div.grow'), control);
    if (hintNode) root.append(hintNode);
  }
  return {
    root,
    labelNode,
    setError(message) {
      setText(errorNode, message || '');
      setStyles(errorNode, { display: message ? '' : 'none' });
      if (control.setAttribute) setAttr(control, 'aria-invalid', message ? 'true' : null);
    },
    setHint(message) { if (hintNode) setText(hintNode, message || ''); },
  };
}

/** A labelled text input. */
export function textInput(config = {}) {
  const input = h('input.input', {
    type: config.type || 'text',
    value: config.value ?? '',
    placeholder: config.placeholder || '',
    'aria-label': config.ariaLabel || config.label || null,
    disabled: config.disabled ? true : null,
    spellcheck: config.spellcheck === false ? 'false' : null,
  });
  if (config.mono) input.classList.add('input--mono');
  if (config.min != null) input.min = String(config.min);
  if (config.max != null) input.max = String(config.max);
  if (config.step != null) input.step = String(config.step);

  let current = config.value ?? '';
  input.addEventListener('input', () => {
    current = input.value;
    config.onInput?.(current);
  });
  input.addEventListener('change', () => {
    current = input.value;
    config.onChange?.(current);
  });

  const wrapped = config.label ? field({ ...config, control: input }).root : input;
  return {
    root: wrapped, input,
    get value() { return current; },
    setValue(next, { silent = true } = {}) {
      current = next == null ? '' : String(next);
      if (input.value !== current) input.value = current;
      if (!silent) config.onChange?.(current);
    },
    focus: () => input.focus(),
  };
}

/** A labelled `<select>`. */
export function selectInput(config = {}) {
  const select = h('select.select', { 'aria-label': config.ariaLabel || config.label || null });
  const options = Array.isArray(config.options) ? config.options : [];
  for (const option of options) {
    const node = h('option', { value: option.id }, option.label);
    if (option.id === config.value) node.selected = true;
    select.append(node);
  }
  select.value = config.value ?? options[0]?.id ?? '';
  select.addEventListener('change', () => config.onChange?.(select.value));

  const wrapped = config.label ? field({ ...config, control: select }).root : select;
  return {
    root: wrapped, select,
    get value() { return select.value; },
    setValue(next, { silent = true } = {}) {
      select.value = next;
      if (!silent) config.onChange?.(next);
    },
    setOptions(next) {
      const keep = select.value;
      select.replaceChildren(...next.map((option) => h('option', { value: option.id }, option.label)));
      if (next.some((option) => option.id === keep)) select.value = keep;
    },
  };
}

/**
 * A range slider with a live value readout.
 * `format` turns the raw number into the text beside it; the default shows the number.
 */
export function slider(config = {}) {
  const min = num(config.min, 0);
  const max = num(config.max, 100);
  const step = num(config.step, 1);
  const format = typeof config.format === 'function' ? config.format : null;

  const input = h('input.range', {
    type: 'range', min: String(min), max: String(max), step: String(step),
    value: String(num(config.value, min)),
    'aria-label': config.ariaLabel || config.label || 'Value',
  });
  const readout = h('span.num.small', { style: { minWidth: '64px', textAlign: 'right', color: 'var(--fg-dim)' } });
  const row = h('div.row', { style: { gap: '10px' } }, input, readout);

  function paint(value) {
    const ratio = max > min ? (value - min) / (max - min) : 0;
    setStyles(input, { '--range-fill': `${Math.round(ratio * 100)}%` });
    setText(readout, format ? format(value) : String(Math.round(value * 100) / 100));
  }
  paint(num(config.value, min));

  input.addEventListener('input', () => {
    const value = num(input.value, min);
    paint(value);
    config.onInput?.(value);
  });
  input.addEventListener('change', () => {
    const value = num(input.value, min);
    config.onChange?.(value);
  });

  const wrapped = config.label ? field({ ...config, control: row, actions: config.actions }).root : row;
  return {
    root: wrapped, input, readout,
    get value() { return num(input.value, min); },
    setValue(next, { silent = true } = {}) {
      const value = Math.min(max, Math.max(min, num(next, min)));
      input.value = String(value);
      paint(value);
      if (!silent) config.onChange?.(value);
    },
    setFormat(next) { paint(num(input.value, min)); void next; },
  };
}

/** A switch. Real `role="switch"` with `aria-checked`, so its state is announced. */
export function toggle(config = {}) {
  const node = h('button.switch', {
    type: 'button', role: 'switch',
    'aria-checked': config.value ? 'true' : 'false',
    'aria-label': config.ariaLabel || config.label || 'Toggle',
    disabled: config.disabled ? true : null,
  });
  let on = !!config.value;
  node.addEventListener('click', () => {
    if (node.disabled) return;
    on = !on;
    node.setAttribute('aria-checked', on ? 'true' : 'false');
    config.onChange?.(on);
  });

  if (!config.label) {
    return {
      root: node,
      get value() { return on; },
      setValue: (next, { silent = true } = {}) => {
        on = !!next;
        node.setAttribute('aria-checked', on ? 'true' : 'false');
        if (!silent) config.onChange?.(on);
      },
    };
  }

  const label = h('div.grow',
    h('div.field__label', { style: { color: 'var(--fg)', fontSize: 'var(--fs-sm)' } }, config.label),
    config.hint ? h('div.field__hint', config.hint) : null,
  );
  const row = h('div.row', { style: { gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between' } }, label, node);
  return {
    root: row, node,
    get value() { return on; },
    setValue(next, { silent = true } = {}) {
      on = !!next;
      node.setAttribute('aria-checked', on ? 'true' : 'false');
      if (!silent) config.onChange?.(on);
    },
    setDisabled(disabled, reason) {
      node.disabled = !!disabled;
      if (disabled && reason) node.dataset.tooltip = reason;
      else delete node.dataset.tooltip;
    },
  };
}

/** A segmented control: mutually exclusive options in one border. */
export function segmented(config = {}) {
  const root = h('div.segmented', { role: 'tablist', 'aria-label': config.label || 'Options' });
  const nodes = new Map();
  let value = config.value;

  for (const option of config.options || []) {
    const node = h('button.segmented__item', {
      type: 'button', role: 'tab',
      'aria-selected': option.id === value ? 'true' : 'false',
      'data-tooltip': option.tooltip || null,
    }, option.label);
    node.addEventListener('click', () => select(option.id));
    root.append(node);
    nodes.set(option.id, node);
  }

  function select(next) {
    value = next;
    for (const [key, node] of nodes) node.setAttribute('aria-selected', key === next ? 'true' : 'false');
    config.onChange?.(next);
  }

  return {
    root,
    get value() { return value; },
    // Silent by default, like every other control here: writing a value back must not fire
    // the callback that caused the write.
    setValue(next, { silent = true } = {}) {
      value = next;
      for (const [key, node] of nodes) node.setAttribute('aria-selected', key === next ? 'true' : 'false');
      if (!silent) config.onChange?.(next);
    },
    setOptions(options) {
      nodes.clear();
      root.replaceChildren();
      for (const option of options) {
        const node = h('button.segmented__item', {
          type: 'button', role: 'tab',
          'aria-selected': option.id === value ? 'true' : 'false',
          'data-tooltip': option.tooltip || null,
        }, option.label);
        node.addEventListener('click', () => select(option.id));
        root.append(node);
        nodes.set(option.id, node);
      }
    },
  };
}

/** A search field with an icon inside and a clear button that appears when it has text. */
export function searchInput(config = {}) {
  const input = h('input.input', {
    type: 'search', value: config.value ?? '', placeholder: config.placeholder || 'Search…',
    'aria-label': config.ariaLabel || config.label || 'Search',
    role: 'searchbox',
  });
  const clear = h('button.btn.btn--sm.btn--ghost.btn--icon.search__clear', {
    type: 'button', 'aria-label': 'Clear search', style: { display: 'none' } }, icon('close', { size: 12 }));
  const root = h('div.search.grow', icon('search', { size: 14 }), input, clear);

  const sync = () => { setStyles(clear, { display: input.value ? '' : 'none' }); };
  sync();
  input.addEventListener('input', () => { sync(); config.onInput?.(input.value); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (input.value) { input.value = ''; sync(); config.onInput?.(''); }
      else input.blur();
    }
    if (event.key === 'Enter') config.onSubmit?.(input.value);
  });
  clear.addEventListener('click', () => {
    input.value = '';
    sync();
    config.onInput?.('');
    input.focus();
  });

  return {
    root, input,
    get value() { return input.value; },
    setValue(next) { input.value = next ?? ''; sync(); },
    focus: () => input.focus(),
    clear: () => { input.value = ''; sync(); },
  };
}

/** Built-in formatters for the sliders ManiaFlow actually has. */
export const Formats = {
  percent: (v) => formatRate(v),
  ms: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} ms`,
  msUnsigned: (v) => formatMs(v, { digits: 0, sign: false }),
  integer: (v) => String(Math.round(v)),
  ratio: (v) => v.toFixed(2),
  hz: (v) => `${Math.round(v)} Hz`,
  fps: (v) => (v === 0 ? 'Uncapped' : `${Math.round(v)} fps`),
  count: (v) => String(Math.round(v)),
  scrollSpeed: (v) => `${Math.round(v)} · ${Math.round(scrollSpeedToTimeRange(v))} ms`,
  dpr: (v) => `${v.toFixed(2)}×`,
};

export { field };
