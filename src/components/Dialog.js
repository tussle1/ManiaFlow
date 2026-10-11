/**
 * Dialog — the one modal in ManiaFlow.
 *
 * Every destructive action goes through here, so "are you sure?" looks and behaves the same
 * whether it is clearing session history or resetting a key mapping. It traps focus, closes
 * on Escape and on a backdrop click, restores focus to whatever opened it, and removes
 * itself from the DOM rather than being hidden and left behind.
 *
 * Only one dialog is open at a time. A second request replaces the first rather than
 * stacking, because two overlapping modals are never what the user meant.
 */

import { h, clear, trapFocus, Scope } from '../utils/dom.js';
import { icon } from './Icon.js';
import { button } from './Button.js';

let current = null;

/**
 * Open a dialog.
 * @param {object} config
 * @param {string} config.title
 * @param {Node|string|Node[]} [config.body]
 * @param {Array<{label:string, variant?:string, value?:unknown, onClick?:Function, closeOnClick?:boolean, disabled?:boolean, icon?:string}>} [config.actions]
 * @param {'default'|'wide'} [config.size]
 * @param {boolean} [config.dismissable] default true
 * @param {(value: unknown) => void} [config.onClose]
 * @returns {{ close: (value?: unknown) => void, root: HTMLElement }}
 */
export function dialog(config = {}) {
  // Replacing an open dialog removes it immediately rather than animating it out: two
  // backdrops fading at once reads as a rendering bug, not as a transition.
  if (current) current.close(null, { immediate: true });

  const scope = new Scope();
  const dismissable = config.dismissable !== false;
  let closed = false;

  const root = h('div.dialog-backdrop');
  const panel = h(`div.dialog${config.size === 'wide' ? '.dialog--wide' : ''}`, {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': config.title || 'Dialog',
  });

  const head = h('div.dialog__head',
    h('h2.dialog__title', config.title || ''),
    dismissable ? button({ icon: 'close', size: 'sm', variant: 'ghost', ariaLabel: 'Close dialog', onClick: () => close(null) }) : null,
  );

  const body = h('div.dialog__body');
  if (config.body != null) {
    const nodes = Array.isArray(config.body) ? config.body : [config.body];
    for (const node of nodes) {
      body.append(node instanceof Node ? node : h('p', String(node)));
    }
  }

  const foot = h('div.dialog__foot');
  const actions = Array.isArray(config.actions) ? config.actions : [];
  for (const action of actions) {
    foot.append(button({
      label: action.label,
      icon: action.icon,
      variant: action.variant || 'default',
      disabled: !!action.disabled,
      onClick: () => {
        const result = action.onClick ? action.onClick() : action.value;
        if (action.closeOnClick !== false) close(result === undefined ? (action.value ?? true) : result);
      },
    }));
  }
  if (actions.length > 1) foot.classList.add('dialog__foot--split');

  panel.append(head, body);
  if (actions.length) panel.append(foot);
  root.append(panel);
  document.body.append(root);

  // The backdrop transition needs a frame to start from `opacity: 0`.
  requestAnimationFrame(() => root.classList.add('is-open'));

  const releaseFocus = trapFocus(panel, {
    // A destructive dialog starts on its cancel action, not its confirm one.
    initialFocus: foot.lastElementChild && !actions.some((a) => a.variant === 'danger')
      ? foot.firstElementChild
      : foot.firstElementChild,
  });

  const onKeyDown = (event) => {
    if (event.key === 'Escape' && dismissable) { event.stopPropagation(); close(null); }
  };
  scope.on(document, 'keydown', onKeyDown, true);
  scope.on(root, 'pointerdown', (event) => {
    if (event.target === root && dismissable) close(null);
  });

  function close(value, { immediate = false } = {}) {
    if (closed) return;
    closed = true;
    scope.dispose();
    releaseFocus?.();
    root.classList.remove('is-open');
    // Inert from the first frame of the fade: a dialog on its way out must not still take
    // clicks, and must not be indistinguishable from the open one in the DOM.
    root.classList.add('is-closing');
    root.inert = true;
    const remove = () => root.remove();
    if (immediate) {
      remove();
    } else {
      panel.addEventListener('transitionend', remove, { once: true });
      setTimeout(remove, 320);   // covers the case where no transition runs at all
    }
    current = null;
    config.onClose?.(value);
  }

  current = { close, root, panel, body, scope };
  return current;
}

/**
 * A yes/no confirmation. Resolves with the chosen value, or null when dismissed.
 * The confirm button is only styled as destructive when the action actually is.
 */
export function confirm(options = {}) {
  return new Promise((resolveConfirm) => {
    const { close } = dialog({
      title: options.title || 'Are you sure?',
      body: options.body ?? options.message ?? '',
      onClose: (value) => resolveConfirm(value === undefined ? null : value),
      actions: [
        { label: options.cancelLabel || 'Cancel', value: null },
        {
          label: options.confirmLabel || 'Confirm',
          variant: options.destructive ? 'danger' : 'primary',
          icon: options.icon,
          value: true,
        },
      ],
    });
    // Dismissing by Escape or backdrop is a "no", not an unresolved promise.
    void close;
  });
}

/** A single-line prompt. Resolves with the text, or null when dismissed. */
export function prompt(options = {}) {
  return new Promise((resolvePrompt) => {
    const input = h('input.input', {
      type: 'text', value: options.value || '', placeholder: options.placeholder || '',
      'aria-label': options.label || options.title || 'Value',
    });
    if (options.multiline) {
      input.remove();
    }
    const field = options.multiline
      ? h('textarea.textarea', { 'aria-label': options.label || options.title || 'Value', placeholder: options.placeholder || '' })
      : input;
    if (options.value && options.multiline) field.value = options.value;

    const errorNote = h('div.field__error', { style: { display: 'none' } });
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolvePrompt(value); } };

    const submit = () => {
      const value = String(field.value ?? '');
      if (options.validate) {
        const problem = options.validate(value);
        if (problem) {
          errorNote.textContent = problem;
          errorNote.style.display = '';
          field.setAttribute('aria-invalid', 'true');
          field.focus();
          return;
        }
      }
      finish(value);
    };

    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !options.multiline) { event.preventDefault(); submit(); }
      event.stopPropagation();
    });

    dialog({
      title: options.title || 'Enter a value',
      body: [options.message ? h('p', options.message) : null, h('div.field', field, errorNote)],
      onClose: (value) => finish(value === undefined ? null : value),
      actions: [
        { label: options.cancelLabel || 'Cancel', value: null },
        { label: options.confirmLabel || 'OK', variant: 'primary', onClick: () => { submit(); return undefined; }, closeOnClick: false },
      ],
    });
    requestAnimationFrame(() => field.focus());
  });
}

/** A dialog that shows content built by the caller, with a single close action. */
export function info(options = {}) {
  return new Promise((resolveInfo) => {
    dialog({
      title: options.title || 'Information',
      size: options.size || 'default',
      body: options.body ?? '',
      // Passed through like confirm()'s: the Close action resolves true, and Escape or a
      // backdrop click resolves null, so a caller can tell the two apart.
      onClose: (value) => resolveInfo(value === undefined ? null : value),
      actions: [{ label: options.confirmLabel || 'Close', variant: 'primary', value: true }],
    });
  });
}

/** An error dialog: the reason is shown in full, plus what the user can do about it. */
export function showError(err, options = {}) {
  const message = err?.message || String(err || 'Unknown error');
  const code = err?.code ? h('p.small.muted', h('code.inline', err.code)) : null;
  const detail = err?.detail ? h('pre.code', safeStringify(err.detail)) : null;
  return info({
    title: options.title || 'Something went wrong',
    size: detail ? 'wide' : 'default',
    body: [
      h('div.error-note', icon('alert', { size: 15 }), h('div', message)),
      options.hint ? h('p.small.dim', options.hint) : null,
      code,
      detail,
    ],
    confirmLabel: 'Close',
  });
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Close whatever is open — used on route changes so a dialog never outlives its page. */
export function closeDialog() {
  if (current) current.close(null);
}

export function isDialogOpen() { return !!current; }

/** Clear the dialog body without closing it, for a dialog that changes its own content. */
export function setDialogBody(nodes) {
  if (!current) return;
  clear(current.body);
  const list = Array.isArray(nodes) ? nodes : [nodes];
  for (const node of list) current.body.append(node instanceof Node ? node : h('p', String(node)));
}

export const Dialog = { dialog, confirm, prompt, info, showError, close: closeDialog, isOpen: isDialogOpen, setBody: setDialogBody };
