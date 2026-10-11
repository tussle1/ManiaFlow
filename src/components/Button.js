/**
 * Button — the only way a clickable control is created in ManiaFlow.
 *
 * It exists to keep four things consistent that are easy to get wrong by hand:
 *   • a real `<button>` element, so Enter, Space, focus and screen readers all work
 *   • an accessible name for an icon-only button, which is required and easy to forget
 *   • a tooltip that duplicates the label rather than replacing it
 *   • a disabled state that also sets `aria-disabled`, so a control that cannot run says so
 *     to an assistive technology and not only to a sighted user
 */

import { h } from '../utils/dom.js';
import { icon } from './Icon.js';

const VARIANTS = new Set(['default', 'primary', 'ghost', 'outline', 'danger']);
const SIZES = new Set(['sm', 'md', 'lg']);

/**
 * @param {object} config
 * @param {string} [config.label] visible text
 * @param {string} [config.icon] icon name
 * @param {'default'|'primary'|'ghost'|'outline'|'danger'} [config.variant]
 * @param {'sm'|'md'|'lg'} [config.size]
 * @param {(event: MouseEvent) => void} [config.onClick]
 * @param {string} [config.tooltip]
 * @param {boolean} [config.disabled]
 * @param {boolean} [config.pressed] toggle state, sets aria-pressed
 * @param {string} [config.title]
 * @param {string} [config.type] 'button' (default) | 'submit'
 * @param {string} [config.class]
 * @param {string} [config.ariaLabel] overrides the derived accessible name
 * @param {Node[]} [config.children] extra content, e.g. a <kbd> hint
 * @returns {HTMLButtonElement}
 */
export function button(config = {}) {
  const variant = VARIANTS.has(config.variant) ? config.variant : 'default';
  const size = SIZES.has(config.size) ? config.size : 'md';
  const iconOnly = !config.label && !config.children?.length && !!config.icon;

  const classes = ['btn', `btn--${variant}`];
  if (size !== 'md') classes.push(`btn--${size}`);
  if (iconOnly) classes.push('btn--icon');
  if (config.class) classes.push(config.class);

  const explicitName = config.ariaLabel || config.label || config.title || null;
  // An icon-only control with no name at all falls back to the icon's identifier, which is
  // better than nothing but is not a label anybody wrote — so it is reported in development.
  const name = explicitName || (iconOnly ? config.icon : null);
  if (iconOnly && !explicitName) {
    console.warn(`[ManiaFlow] an icon-only button has no accessible name; falling back to "${config.icon}". Give it an ariaLabel.`, config);
  }

  const node = h(`button.${classes.join('.')}`, {
    type: config.type || 'button',
    title: config.title || null,
    'aria-label': iconOnly ? name : null,
    'aria-pressed': config.pressed == null ? null : config.pressed ? 'true' : 'false',
    'data-tooltip': config.tooltip || null,
  });

  if (config.icon) node.append(icon(config.icon, { size: size === 'sm' ? 13 : size === 'lg' ? 17 : 15 }));
  if (config.label) node.append(h('span', config.label));
  if (config.children) node.append(...config.children);

  if (typeof config.onClick === 'function') {
    node.addEventListener('click', (event) => {
      if (node.disabled || node.getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
      config.onClick(event);
    });
  }

  setDisabled(node, config.disabled, config.disabledReason);
  return node;
}

/**
 * Enable or disable a control, and say why it is disabled.
 * The reason goes in the tooltip, so a greyed-out button is never a mystery.
 */
export function setDisabled(node, disabled, reason = null) {
  if (!node) return node;
  node.disabled = !!disabled;
  if (disabled) node.setAttribute('aria-disabled', 'true');
  else node.removeAttribute('aria-disabled');
  if (reason && disabled) node.dataset.tooltip = reason;
  else if (node.dataset.tooltipDisabled) delete node.dataset.tooltip;
  if (disabled && reason) node.dataset.tooltipDisabled = reason;
  return node;
}

/** A group of buttons sharing one border, for play/pause/stop and friends. */
export function buttonGroup(buttons, { label } = {}) {
  const group = h('div.btn-group', { role: label ? 'group' : null, 'aria-label': label || null });
  group.append(...buttons.filter(Boolean));
  return group;
}

/**
 * A toggle button that keeps its own pressed state and reports changes.
 * Used for the preview's display options, where a checkbox would be heavier than the change.
 */
export function toggleButton(config = {}) {
  const node = button({ ...config, pressed: !!config.pressed });
  let pressed = !!config.pressed;
  node.addEventListener('click', () => {
    if (node.disabled) return;
    pressed = !pressed;
    node.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    node.classList.toggle('is-on', pressed);
    config.onToggle?.(pressed);
  });
  node.classList.toggle('is-on', pressed);
  node.setPressed = (next) => {
    pressed = !!next;
    node.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    node.classList.toggle('is-on', pressed);
  };
  node.getPressed = () => pressed;
  return node;
}
