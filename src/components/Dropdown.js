/**
 * Dropdown — a button that opens a positioned menu.
 *
 * Used for sorting, filtering and the overflow actions in the library, where a row of
 * buttons would be wider than the panel. The menu is a single element appended to `body`
 * and positioned from the trigger's rect, so it is never clipped by an ancestor with
 * `overflow: hidden`.
 *
 * Keyboard: ArrowDown/ArrowUp move, Home/End jump, Enter and Space choose, Escape closes
 * and returns focus to the trigger. That is the whole contract, and it is the same in every
 * dropdown in the app.
 */

import { h } from '../utils/dom.js';
import { icon } from './Icon.js';
import { button } from './Button.js';

/**
 * @param {object} config
 * @param {string} [config.label] trigger text
 * @param {string} [config.icon] trigger icon
 * @param {Array<object>} config.items see `menuItem`
 * @param {'sm'|'md'} [config.size]
 * @param {(item: object) => void} [config.onSelect]
 * @param {string} [config.align] 'start' | 'end'
 */
export function dropdown(config = {}) {
  const align = config.align === 'end' ? 'end' : 'start';
  let open = false;
  let cursor = -1;
  let menu = null;

  const trigger = button({
    label: config.label,
    icon: config.icon,
    size: config.size || 'md',
    variant: config.variant || 'default',
    tooltip: config.tooltip,
    children: config.label ? [h('span', icon('chevronDown', { size: 12 }))] : null,
    ariaLabel: config.ariaLabel || config.label || null,
    onClick: () => (open ? close() : show()),
  });
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  function items() { return Array.isArray(config.items) ? config.items : (typeof config.items === 'function' ? config.items() : []); }

  function show() {
    if (open) return;
    const list = items();
    menu = h('div.popover', { role: 'menu' });
    for (const item of list) menu.append(menuItem(item, menu));
    document.body.append(menu);
    position();
    open = true;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('is-on');
    requestAnimationFrame(() => menu.classList.add('is-open'));
    cursor = Math.max(0, list.findIndex((item) => item.checked));

    addListeners();
    highlight(cursor);
  }

  function close(returnFocus = true) {
    if (!open) return;
    open = false;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('is-on');
    removeListeners();
    if (menu) {
      menu.classList.remove('is-open');
      // Removed synchronously. Deferring this by the length of a fade leaves the menu in the
      // document — focusable and queryable — and a dropdown opened twice in quick succession
      // ends up with two of them stacked. The fade-in is what makes it feel deliberate.
      menu.remove();
      menu = null;
    }
    cursor = -1;
    if (returnFocus && document.activeElement !== trigger) trigger.focus({ preventScroll: true });
  }

  const onDocumentPointer = (event) => {
    if (!open) return;
    if (menu && menu.contains(event.target)) return;
    if (trigger.contains(event.target)) return;
    close(false);
  };
  const onKeyDown = (event) => {
    if (!open) {
      if (event.key === 'ArrowDown' && document.activeElement === trigger) { event.preventDefault(); show(); }
      return;
    }
    const list = items();
    switch (event.key) {
      case 'Escape': event.preventDefault(); event.stopPropagation(); close(); break;
      case 'ArrowDown': event.preventDefault(); move(1, list); break;
      case 'ArrowUp': event.preventDefault(); move(-1, list); break;
      case 'Home': event.preventDefault(); cursor = 0; highlight(cursor); break;
      case 'End': event.preventDefault(); cursor = list.length - 1; highlight(cursor); break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (cursor >= 0 && list[cursor]) choose(list[cursor]);
        break;
      case 'Tab':
        close(false);
        break;
      default: break;
    }
  };

  function move(delta, list) {
    if (!list.length) return;
    let next = cursor + delta;
    // Skip separators and disabled entries rather than stopping on them.
    for (let guard = 0; guard < list.length; guard++) {
      if (next < 0) next = list.length - 1;
      if (next >= list.length) next = 0;
      const item = list[next];
      if (item && item.type !== 'separator' && item.type !== 'heading' && !item.disabled) break;
      next += delta;
    }
    cursor = next;
    highlight(cursor);
  }

  function highlight(index) {
    if (!menu) return;
    const entries = [...menu.querySelectorAll('.menu__item')];
    entries.forEach((node, i) => node.classList.toggle('is-cursor', i === index));
    entries[index]?.scrollIntoView({ block: 'nearest' });
  }

  function choose(item) {
    close();
    if (typeof item.onClick === 'function') item.onClick(item);
    config.onSelect?.(item);
  }

  function position() {
    if (!menu || !open) return;
    const rect = trigger.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const margin = 6;
    let left = align === 'end' ? rect.right - size.width : rect.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - size.width - margin));
    let top = rect.bottom + 4;
    if (top + size.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - size.height - 4);
      menu.style.transformOrigin = 'bottom left';
    } else {
      menu.style.transformOrigin = 'top left';
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.maxHeight = `${Math.round(Math.min(360, window.innerHeight - margin * 2))}px`;
    menu.style.overflowY = 'auto';
  }

  function addListeners() {
    removeListeners();
    document.addEventListener('pointerdown', onDocumentPointer, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function removeListeners() {
    document.removeEventListener('pointerdown', onDocumentPointer, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function menuItem(item, parent) {
    if (item.type === 'separator') return h('div.menu__sep', { role: 'separator' });
    if (item.type === 'heading') return h('div.menu__heading', item.label || '');
    const node = h('button.menu__item', {
      role: 'menuitem',
      type: 'button',
      disabled: !!item.disabled,
      'data-tooltip': item.tooltip || null,
    });
    if (item.icon) node.append(icon(item.icon, { size: 14 }));
    node.append(h('span.grow.truncate', item.label || ''));
    if (item.hint) node.append(h('span.kbd', item.hint));
    if (item.checked) node.append(icon('check', { size: 13 }));
    if (item.danger) node.classList.add('menu__item--danger');
    node.addEventListener('click', () => { if (!item.disabled) choose(item); });
    node.addEventListener('pointerenter', () => {
      cursor = [...parent.querySelectorAll('.menu__item')].indexOf(node);
      highlight(cursor);
    });
    return node;
  }

  return {
    node: trigger,
    open: show,
    close: () => close(false),
    get isOpen() { return open; },
    /** Replace the item list; an open menu rebuilds so it never shows stale entries. */
    setItems(next) {
      config.items = next;
      if (open) { close(false); show(); }
    },
    setLabel(text) {
      const label = trigger.querySelector('span:not(:last-child)');
      if (label) label.textContent = text;
      else if (!config.icon) trigger.prepend(h('span', text));
    },
    dispose() { close(false); removeListeners(); },
  };
}

/** A compact select rendered as a dropdown, for use where a native select looks wrong. */
export function selectDropdown({ label, value, options: choices, onChange, size = 'sm', tooltip }) {
  const current = () => choices.find((choice) => choice.id === value) || choices[0];
  const control = dropdown({
    label: current()?.label ?? label,
    size,
    tooltip,
    ariaLabel: label,
    items: () => choices.map((choice) => ({
      label: choice.label,
      checked: choice.id === value,
      onClick: () => {
        value = choice.id;
        control.setLabel(choice.label);
        onChange?.(choice.id, choice);
      },
    })),
  });
  control.setValue = (next) => {
    value = next;
    control.setLabel(current()?.label ?? label);
  };
  control.getValue = () => value;
  return control;
}

