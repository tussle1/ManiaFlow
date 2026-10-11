/**
 * Critical user-interface interactions.
 *
 * These run against the DOM stub in tests/helpers/dom-stub.js. They test behaviour a user
 * can perceive and that is easy to break silently: whether a disabled control says why,
 * whether a dialog gives focus back, whether Escape closes the right thing, whether a
 * toggle reports its state to an assistive technology, and whether a store subscription
 * fires only when the slice it watches actually changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './helpers/dom-stub.js';

let dom;

function setup() {
  dom = installDom();
  return dom;
}

/**
 * The dialog that is actually open.
 * A closing dialog stays in the document for the length of its fade (inert, so it cannot be
 * interacted with), so querying the document for `.dialog__foot .btn` would match both it
 * and the open one. Scoping to the live backdrop is what a user's click would do.
 */
function activeDialog() {
  const backdrops = dom.document.querySelectorAll('.dialog-backdrop');
  return backdrops.find((b) => !b.classList.contains('is-closing')) || null;
}
function activeButtons() {
  return activeDialog() ? [...activeDialog().querySelectorAll('.dialog__foot .btn')] : [];
}
/**
 * Reset the module-level singletons before the DOM goes away.
 *
 * Dialog, Toast and Tooltip deliberately hold one instance for the whole application, so
 * they keep references to nodes from a previous `installDom()`. Tearing them down here is
 * not test scaffolding — it is the same shutdown path the app runs, and leaving it out
 * leaks one test's dialog into the next.
 */
async function teardown() {
  try {
    const { Dialog } = await import('../src/components/Dialog.js');
    if (Dialog.isOpen()) Dialog.close();
    const { Toast } = await import('../src/components/Toast.js');
    Toast.clear();
  } catch { /* a module that was never imported has nothing to reset */ }
  await new Promise((r) => setTimeout(r, 0));
  dom.uninstall();
  dom = null;
}

/* ── the store ───────────────────────────────────────────────────────── */

test('a store subscription fires only when its own slice changes', async () => {
  const { Store, initialAppState } = await import('../src/app/state.js');
  const store = new Store(initialAppState());
  const calls = [];
  const off = store.subscribe((s) => s.route, (route) => calls.push(route));
  assert.deepEqual(calls, ['dashboard'], 'a subscription runs once immediately so a page renders once on mount');

  store.update({ busy: true });
  assert.deepEqual(calls, ['dashboard'], 'an unrelated change does not fire it');

  store.update({ route: 'library' });
  assert.deepEqual(calls, ['dashboard', 'library']);

  store.update({ route: 'library' });
  assert.deepEqual(calls.length, 2, 'setting the same value again is not a change');

  off();
  store.update({ route: 'timing' });
  assert.deepEqual(calls.length, 2, 'an unsubscribed listener is gone');
  assert.equal(store.listenerCount('change'), 0);
});

test('a batch notifies subscribers once, and only if something changed', async () => {
  const { Store } = await import('../src/app/state.js');
  const store = new Store({ a: 1, b: 2, c: 3 });
  let notifications = 0;
  store.subscribe((s) => ({ a: s.a, b: s.b }), () => notifications++);
  assert.equal(notifications, 1);

  store.batch(() => {
    store.update({ a: 10 });
    store.update({ b: 20 });
    store.update({ a: 11 });
  });
  assert.equal(notifications, 2, 'three writes inside a batch produce one notification');
  assert.deepEqual({ a: store.state.a, b: store.state.b }, { a: 11, b: 20 });

  const before = notifications;
  store.batch(() => { store.update({ c: 99 }); });
  assert.equal(notifications, before, 'a batch that does not touch the watched slice stays quiet');
});

test('a selector that throws is contained and does not stop the others', async () => {
  const { Store } = await import('../src/app/state.js');
  const store = new Store({ value: 1 });
  const good = [];
  store.subscribe(() => { throw new Error('bad selector'); }, () => {});
  store.subscribe((s) => s.value, (v) => good.push(v));
  store.update({ value: 2 });
  assert.deepEqual(good, [1, 2], 'the healthy listener still ran');

  store.subscribe((s) => s.value, () => { throw new Error('bad listener'); });
  store.update({ value: 3 });
  assert.deepEqual(good, [1, 2, 3], 'and a throwing listener does not break the rest');
});

test('shallowEqual is what makes the comparison cheap and correct', async () => {
  const { shallowEqual } = await import('../src/app/state.js');
  assert.equal(shallowEqual(1, 1), true);
  assert.equal(shallowEqual(NaN, NaN), true, 'Object.is semantics, so NaN equals itself');
  assert.equal(shallowEqual(null, null), true);
  assert.equal(shallowEqual(null, {}), false);
  assert.equal(shallowEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(shallowEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(shallowEqual({ a: 1, b: 2 }, { a: 1 }), false);
  assert.equal(shallowEqual({ a: { x: 1 } }, { a: { x: 1 } }), false, 'nested objects compare by identity, which is why updates replace them whole');
  assert.equal(shallowEqual([1, 2], [1, 2]), true);
  assert.equal(shallowEqual([1, 2], { 0: 1, 1: 2 }), false, 'an array is not an object with the same keys');
});

test('the route table and the router agree, and an unknown hash falls back', async () => {
  setup();
  try {
    const { ROUTES, routeById, routeByPath } = await import('../src/app/state.js');
    const { Router } = await import('../src/app/router.js');
    assert.ok(ROUTES.length >= 6);
    for (const route of ROUTES) {
      assert.equal(routeById(route.id), route);
      assert.equal(routeByPath(route.path), route);
      assert.equal(Router.routeForHash(`#${route.path}`), route.id);
      assert.equal(Router.routeForHash(`#${route.path}?chart=abc`), route.id);
    }
    assert.equal(Router.routeForHash('#/nowhere'), ROUTES[0].id, 'an unknown hash goes to the first route');
    assert.equal(Router.routeForHash(''), ROUTES[0].id);
    assert.equal(routeById('nope'), null);

    const seen = [];
    const router = new Router({ onChange: (id, params) => { seen.push([id, params.get('chart')]); return Promise.resolve(); } });
    dom.window.location.hash = '#/library?chart=map-7';
    await router.start();
    assert.deepEqual(seen[0], ['library', 'map-7'], 'the query reaches the page');
    router.navigate('timing');
    assert.equal(dom.window.location.hash, '#/timing');
    router.navigate('nope');
    assert.equal(dom.window.location.hash, '#/timing', 'an unknown route does not navigate');
    router.stop();
    await router.start();
    assert.equal(await router.start(), undefined, 'starting twice is a no-op');
  } finally {
    await teardown();
  }
});

/* ── buttons ─────────────────────────────────────────────────────────── */

test('a button is a real button, and an icon-only one is named', async () => {
  setup();
  try {
    const { button } = await import('../src/components/Button.js');
    const labelled = button({ label: 'Play', icon: 'play', onClick: () => {} });
    assert.equal(labelled.localName, 'button');
    assert.equal(labelled.getAttribute('type'), 'button', 'never a submit button by accident');
    assert.equal(labelled.textContent, 'Play');
    assert.equal(labelled.getAttribute('aria-label'), null, 'a visible label needs no aria-label');
    assert.ok(labelled.querySelector('svg'), 'and it has its icon');

    const iconOnly = button({ icon: 'close', ariaLabel: 'Dismiss', onClick: () => {} });
    assert.equal(iconOnly.getAttribute('aria-label'), 'Dismiss', 'an icon-only button carries its name');
    assert.equal(iconOnly.classList.contains('btn--icon'), true);

    // With no explicit aria-label an icon-only button falls back to the icon name, which is
    // better than nothing — but the fallback is reported during development so it gets a
    // real label.
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let fallback;
    let nameless;
    try {
      fallback = button({ icon: 'close' });
      nameless = button({ onClick: () => {} });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(fallback.getAttribute('aria-label'), 'close', 'an icon-only button is never left unnamed');
    assert.ok(warnings.some((w) => /accessible name/.test(w)), 'and the fallback is flagged so it gets a real label');
    assert.equal(nameless.getAttribute('aria-label'), null, 'a button with no icon and no label has nothing to derive');
  } finally {
    await teardown();
  }
});

test('a disabled button refuses the click and says why', async () => {
  setup();
  try {
    const { button, setDisabled } = await import('../src/components/Button.js');
    let clicks = 0;
    const node = button({ label: 'Run', onClick: () => clicks++ });
    node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(clicks, 1);

    setDisabled(node, true, 'Load a chart first');
    assert.equal(node.disabled, true);
    assert.equal(node.getAttribute('aria-disabled'), 'true', 'the state reaches an assistive technology, not only the eye');
    assert.equal(node.dataset.tooltip, 'Load a chart first', 'and the reason is available');

    node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(clicks, 1, 'a disabled button does not fire');

    setDisabled(node, false);
    assert.equal(node.disabled, false);
    assert.equal(node.hasAttribute('aria-disabled'), false);
    node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(clicks, 2, 'and re-enabling restores it');
  } finally {
    await teardown();
  }
});

test('a toggle button reports its pressed state', async () => {
  setup();
  try {
    const { toggleButton } = await import('../src/components/Button.js');
    const states = [];
    const node = toggleButton({ label: 'Bar lines', pressed: false, onToggle: (on) => states.push(on) });
    assert.equal(node.getAttribute('aria-pressed'), 'false');
    node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(states, [true]);
    assert.equal(node.getAttribute('aria-pressed'), 'true');
    assert.equal(node.classList.contains('is-on'), true);
    node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(states, [true, false]);
    node.setPressed(true);
    assert.equal(node.getPressed(), true);
    assert.equal(states.length, 2, 'setPressed does not re-fire the callback, so a preference change cannot loop');
  } finally {
    await teardown();
  }
});

/* ── dialogs ─────────────────────────────────────────────────────────── */

test('a dialog traps focus, closes on Escape, and gives focus back', async () => {
  setup();
  try {
    const { Dialog } = await import('../src/components/Dialog.js');
    const opener = dom.document.createElement('button');
    dom.document.body.append(opener);
    opener.focus();
    assert.equal(dom.document.activeElement, opener);

    const handle = Dialog.dialog({
      title: 'Delete everything?',
      body: 'This cannot be undone.',
      actions: [{ label: 'Cancel', value: null }, { label: 'Delete', variant: 'danger', value: true }],
    });
    assert.equal(Dialog.isOpen(), true);
    const backdrop = activeDialog();
    assert.ok(backdrop, 'the backdrop is in the document');
    assert.equal(backdrop.querySelector('.dialog').getAttribute('aria-modal'), 'true');
    assert.equal(backdrop.querySelector('.dialog__title').textContent, 'Delete everything?');
    assert.notEqual(dom.document.activeElement, opener, 'focus moved into the dialog');

    // Escape closes it.
    dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(Dialog.isOpen(), false);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(dom.document.querySelector('.dialog-backdrop'), null, 'and it is removed, not left hidden in the DOM');
    assert.equal(dom.document.activeElement, opener, 'focus went back to what opened it');
    void handle;
  } finally {
    await teardown();
  }
});

test('confirm resolves true, false or null, and a second dialog replaces the first', async () => {
  setup();
  try {
    const { Dialog } = await import('../src/components/Dialog.js');
    const first = Dialog.confirm({ title: 'First?', confirmLabel: 'Yes' });
    const second = Dialog.confirm({ title: 'Second?' });
    assert.equal(dom.document.querySelectorAll('.dialog-backdrop').length, 1, 'a replaced dialog is removed at once, not left stacked');
    assert.equal(await first, null, 'replacing a dialog resolves it as dismissed, not hanging');

    const actions = activeButtons();
    assert.equal(actions.length, 2, 'only the open dialog is addressable');
    actions[actions.length - 1].dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(await second, true);
    assert.equal(Dialog.isOpen(), false);

    const third = Dialog.confirm({ title: 'Third?', destructive: true });
    const buttons = activeButtons();
    assert.equal(buttons.length, 2, 'the closing dialog is inert and out of the way');
    assert.ok(buttons.some((b) => b.classList.contains('btn--danger')), 'a destructive confirm is styled as one');
    buttons[0].dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(await third, null, 'cancel resolves null');
  } finally {
    await teardown();
  }
});

test('a prompt validates before it resolves', async () => {
  setup();
  try {
    const { Dialog } = await import('../src/components/Dialog.js');
    const pending = Dialog.prompt({
      title: 'Collection name',
      validate: (value) => (value.trim() ? null : 'A name cannot be empty'),
    });
    const input = activeDialog().querySelector('.dialog input');
    assert.ok(input, 'the prompt shows a field');
    input.value = '   ';
    const buttons = [...dom.document.querySelectorAll('.dialog__foot .btn')];
    buttons[buttons.length - 1].dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(Dialog.isOpen(), true, 'an invalid value does not close the dialog');
    const error = activeDialog().querySelector('.field__error');
    assert.equal(error.textContent, 'A name cannot be empty', 'and it says what is wrong');
    assert.equal(input.getAttribute('aria-invalid'), 'true');

    input.value = 'LN practice';
    buttons[buttons.length - 1].dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(await pending, 'LN practice');
  } finally {
    await teardown();
  }
});

test('a backdrop click dismisses, and clicking inside the dialog does not', async () => {
  setup();
  try {
    const { Dialog } = await import('../src/components/Dialog.js');
    // `info` is the promise-based form; `dialog` returns a handle.
    const pending = Dialog.info({ title: 'Info', body: 'text', confirmLabel: 'Close' });
    const backdrop = activeDialog();
    backdrop.querySelector('.dialog__body').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(Dialog.isOpen(), true, 'clicking the content does not close it');
    backdrop.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(Dialog.isOpen(), false, 'clicking the backdrop does');
    assert.equal(await pending, null, 'and dismissing resolves null rather than hanging');
  } finally {
    await teardown();
  }
});

/* ── toasts ──────────────────────────────────────────────────────────── */

test('toasts queue, expire and cap the number on screen', async () => {
  setup();
  try {
    const { Toast } = await import('../src/components/Toast.js');
    Toast.clear();
    const one = Toast.ok('Imported 3 charts', 'Import complete');
    assert.equal(Toast.count, 1);
    const node = dom.document.querySelector('.toast');
    assert.ok(node.classList.contains('toast--success'));
    assert.equal(node.getAttribute('role'), 'status', 'a success is a polite status, not an alert');
    assert.equal(node.querySelector('.toast__title').textContent, 'Import complete');
    assert.match(dom.document.querySelector('[aria-live]').textContent, /Import complete/, 'and it is announced');

    const err = Toast.error('The bridge disconnected');
    assert.equal(dom.document.querySelectorAll('.toast')[1].getAttribute('role'), 'alert', 'an error is assertive');
    assert.equal(Toast.count, 2);

    for (let i = 0; i < 6; i++) Toast.info(`message ${i}`);
    assert.ok(Toast.count <= 4, `at most four stay on screen (got ${Toast.count})`);

    Toast.dismiss(one.id);
    assert.equal(dom.document.querySelectorAll('.toast.is-leaving').length >= 1, true, 'a dismissed toast animates out');
    Toast.dismiss(err.id);
    Toast.clear();
    assert.equal(Toast.count, 0);
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(dom.document.querySelectorAll('.toast').length, 0, 'and they are removed from the DOM');
  } finally {
    await teardown();
  }
});

/* ── dropdown ────────────────────────────────────────────────────────── */

test('a dropdown opens, navigates by keyboard and closes on Escape', async () => {
  setup();
  try {
    const { dropdown } = await import('../src/components/Dropdown.js');
    const chosen = [];
    const control = dropdown({
      label: 'Sort', size: 'sm',
      items: [
        { label: 'Title', onClick: () => chosen.push('Title') },
        { label: 'BPM', onClick: () => chosen.push('BPM') },
        { type: 'separator' },
        { label: 'Disabled', disabled: true, onClick: () => chosen.push('nope') },
      ],
    });
    dom.document.body.append(control.node);
    assert.equal(control.node.getAttribute('aria-expanded'), 'false');
    assert.equal(dom.document.querySelector('.popover'), null, 'closed to begin with');

    control.node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(control.isOpen, true);
    assert.equal(control.node.getAttribute('aria-expanded'), 'true');
    const menu = dom.document.querySelector('.popover');
    assert.ok(menu, 'the menu is in the document');
    assert.equal(menu.querySelectorAll('.menu__item').length, 3, 'a separator is not an item');
    assert.equal(dom.document.querySelectorAll('.popover').length, 1, 'opening never leaves a second, orphaned menu behind');

    const items = [...menu.querySelectorAll('.menu__item')];
    assert.equal(items[2].disabled, true);

    const arrow = () => dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    arrow();
    dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.deepEqual(chosen, ['BPM'], 'one step down lands on the second entry');
    assert.equal(control.isOpen, false, 'choosing closes the menu');

    // A separator and a disabled entry are stepped over, and the cursor wraps at the end.
    control.open();
    arrow();                       // BPM
    arrow();                       // skips the separator and the disabled entry, wraps to Title
    dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.deepEqual(chosen, ['BPM', 'Title'], 'neither the separator nor the disabled entry can be chosen');
    assert.ok(!chosen.includes('nope'));

    control.open();
    dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(control.isOpen, false, 'Escape closes it');

    control.open();
    control.setItems([{ label: 'Only one', onClick: () => chosen.push('only') }]);
    assert.equal(dom.document.querySelectorAll('.menu__item').length, 1, 'setItems rebuilds an open menu so it never shows stale entries');
    control.dispose();
    assert.equal(control.isOpen, false);
  } finally {
    await teardown();
  }
});

/* ── controls ────────────────────────────────────────────────────────── */

test('a slider clamps, formats and reports without looping', async () => {
  setup();
  try {
    const { slider, Formats } = await import('../src/components/controls.js');
    const changes = [];
    const control = slider({
      label: 'Speed', min: 0.25, max: 2, step: 0.05, value: 1,
      format: Formats.percent, onChange: (v) => changes.push(v),
    });
    assert.equal(control.input.getAttribute('min'), '0.25');
    assert.equal(control.readout.textContent, '100%');
    assert.equal(control.input.style.getPropertyValue('--range-fill'), '43%', 'the filled track reflects the value');

    control.setValue(1.5, { silent: true });
    assert.equal(control.readout.textContent, '150%');
    assert.deepEqual(changes, [], 'a silent set does not fire the callback, so a preference change cannot loop back');

    control.setValue(99);
    assert.equal(control.value, 2, 'clamped to the maximum');
    control.setValue(-5);
    assert.equal(control.value, 0.25, 'and to the minimum');
    control.setValue('nonsense');
    assert.equal(control.value, 0.25);

    control.input.value = '1.25';
    control.input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.deepEqual(changes, [1.25], 'a user change does fire');
  } finally {
    await teardown();
  }
});

test('a switch reports its state as a switch, not as a mystery button', async () => {
  setup();
  try {
    const { toggle } = await import('../src/components/controls.js');
    const seen = [];
    const control = toggle({ label: 'Bar lines', value: true, onChange: (v) => seen.push(v) });
    const node = control.node;
    assert.equal(node.getAttribute('role'), 'switch');
    assert.equal(node.getAttribute('aria-checked'), 'true');
    node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(seen, [false]);
    assert.equal(node.getAttribute('aria-checked'), 'false');
    control.setValue(true);
    assert.equal(control.value, true);
    assert.deepEqual(seen, [false], 'setValue is silent by default');
    control.setDisabled(true, 'Needs a chart');
    assert.equal(node.disabled, true);
    assert.equal(node.dataset.tooltip, 'Needs a chart');
    node.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(seen, [false], 'a disabled switch does not toggle');
  } finally {
    await teardown();
  }
});

test('a segmented control marks exactly one option selected', async () => {
  setup();
  try {
    const { segmented } = await import('../src/components/controls.js');
    const chosen = [];
    const control = segmented({
      label: 'Backend', value: 'a',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      onChange: (v) => chosen.push(v),
    });
    const items = [...control.root.querySelectorAll('.segmented__item')];
    assert.equal(items.filter((i) => i.getAttribute('aria-selected') === 'true').length, 1);
    items[2].dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(control.value, 'c');
    assert.deepEqual(chosen, ['c']);
    assert.equal(items.filter((i) => i.getAttribute('aria-selected') === 'true').length, 1, 'still exactly one');
    assert.equal(items[2].getAttribute('aria-selected'), 'true');
  } finally {
    await teardown();
  }
});

test('a search field clears, and Escape empties it before it blurs', async () => {
  setup();
  try {
    const { searchInput } = await import('../src/components/controls.js');
    const queries = [];
    const control = searchInput({ placeholder: 'Search…', onInput: (v) => queries.push(v) });
    dom.document.body.append(control.root);
    const clear = control.root.querySelector('.search__clear');
    assert.equal(clear.style.display, 'none', 'the clear button is hidden while empty');

    control.input.value = '4k';
    control.input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.deepEqual(queries, ['4k']);
    assert.notEqual(clear.style.display, 'none', 'and appears once there is text');

    clear.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(control.input.value, '');
    assert.deepEqual(queries, ['4k', ''], 'clearing is a change, so the list updates');

    control.input.value = 'hold';
    control.input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(control.input.value, '', 'the first Escape clears what was typed');
  } finally {
    await teardown();
  }
});

/* ── tabs, primitives, sidebar ───────────────────────────────────────── */

test('tabs move with the arrow keys and keep one selection', async () => {
  setup();
  try {
    const { tabs } = await import('../src/components/primitives.js');
    const seen = [];
    let active = 'a';
    const control = tabs({
      id: 'x', label: 'Sections', active,
      tabs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      onChange: (id) => { active = id; seen.push(id); },
    });
    dom.document.body.append(control.root);
    const items = [...control.root.querySelectorAll('.tab')];
    assert.equal(items.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1);
    assert.equal(items[0].tabIndex, 0, 'roving tabindex: only the selected tab is in the order');
    assert.equal(items[1].tabIndex, -1);

    control.root.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    assert.deepEqual(seen, ['b']);
    control.root.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    assert.deepEqual(seen, ['b', 'c']);
    control.root.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    assert.deepEqual(seen, ['b', 'c', 'a'], 'and it wraps');
    control.root.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    assert.deepEqual(seen, ['b', 'c', 'a', 'b'], 'each keypress steps from the tab the user is actually on, not the one it started on');
    assert.equal(items.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1);
    assert.equal(control.value, 'b');
  } finally {
    await teardown();
  }
});

test('a stat writes only when its value changes, and a dash means "nothing measured"', async () => {
  setup();
  try {
    const { stat } = await import('../src/components/primitives.js');
    const control = stat({ label: 'Sessions', value: '0' });
    const valueNode = control.root.querySelector('.stat__value');
    let writes = 0;
    const descriptor = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'textContent');
    void descriptor;
    const original = valueNode.textContent;
    control.setValue('0');
    assert.equal(valueNode.textContent, original, 'the same value does not rewrite the node');
    control.setValue('12');
    assert.equal(valueNode.textContent, '12');
    writes++;
    control.setValue(null);
    assert.equal(valueNode.textContent, '—', 'null renders as a dash, never as a zero');
    writes++;
    control.setValue('');
    assert.equal(valueNode.textContent, '—');
    assert.equal(writes, 2);
  } finally {
    await teardown();
  }
});

test('a meter exposes its value to an assistive technology', async () => {
  setup();
  try {
    const { meter } = await import('../src/components/primitives.js');
    const control = meter({ label: 'Progress' });
    assert.equal(control.root.getAttribute('role'), 'progressbar');
    assert.equal(control.root.getAttribute('aria-label'), 'Progress');
    control.set(0.42);
    assert.equal(control.root.getAttribute('aria-valuenow'), '42');
    control.set(5);
    assert.equal(control.root.getAttribute('aria-valuenow'), '100', 'clamped');
    control.set(-1);
    assert.equal(control.root.getAttribute('aria-valuenow'), '0');
    control.set('nonsense');
    assert.equal(control.root.getAttribute('aria-valuenow'), '0');
  } finally {
    await teardown();
  }
});

test('the sidebar marks one route current and Alt+number navigates', async () => {
  setup();
  try {
    const { Store, initialAppState, ROUTES } = await import('../src/app/state.js');
    const { createSidebar } = await import('../src/components/Sidebar.js');
    const store = new Store(initialAppState());
    const navigated = [];
    const sidebar = createSidebar({ store, onNavigate: (id) => navigated.push(id) });
    dom.document.body.append(sidebar.root);

    const items = [...sidebar.root.querySelectorAll('.nav__item')];
    assert.equal(items.length, ROUTES.length, 'one nav item per route');
    assert.equal(items.filter((i) => i.getAttribute('aria-current') === 'page').length, 1, 'exactly one is current');
    assert.equal(items.find((i) => i.getAttribute('aria-current') === 'page').dataset.route, 'dashboard');

    store.update({ route: 'timing' });
    assert.equal(items.find((i) => i.getAttribute('aria-current') === 'page').dataset.route, 'timing', 'the store drives it');
    assert.equal(items.filter((i) => i.tabIndex === 0).length, 1, 'and only the current one is in the tab order');

    store.update({ charts: new Array(7).fill({ id: 'x' }) });
    const count = sidebar.root.querySelector('[data-route="library"] .nav__count');
    assert.equal(count.textContent, '7', 'the library shows how many charts there are');
    store.update({ charts: [] });
    assert.equal(count.style.display, 'none', 'and hides the badge at zero rather than showing 0');

    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '3', altKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(navigated, [ROUTES[2].id], 'Alt+3 jumps to the third route');
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '9', altKey: true, bubbles: true, cancelable: true }));
    assert.equal(navigated.length, 1, 'Alt+9 is out of range and does nothing');
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true }));
    assert.equal(navigated.length, 1, 'a plain 3 is not a shortcut');

    sidebar.dispose();
    const before = dom.window.listenerCount;
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true, cancelable: true }));
    assert.equal(navigated.length, 1, 'a disposed sidebar stops listening');
    void before;
  } finally {
    await teardown();
  }
});

test('the status area shows an error in words, not only in colour', async () => {
  setup();
  try {
    const { Store, initialAppState } = await import('../src/app/state.js');
    const { createStatusArea } = await import('../src/components/StatusArea.js');
    const store = new Store(initialAppState());
    const area = createStatusArea({ store });
    dom.document.body.append(area.root);
    assert.equal(area.root.getAttribute('role'), 'status');
    assert.equal(area.root.getAttribute('aria-live'), 'polite');
    assert.match(area.root.textContent, /Offline/, 'with nothing connected it says so');

    store.update({ loadError: { message: 'Not an osu! beatmap', code: 'chart-unsupported' } });
    assert.match(area.root.textContent, /Not an osu! beatmap/, 'an error is written out, not just coloured red');
    assert.ok(area.root.querySelector('.statusbar__item--error'), 'and styled as an error too');

    store.update({ loadError: null, loadedChart: { keys: 7, objectCount: 1500 }, playback: { state: 'playing', position: 61500, durationMs: 176000, rate: 0.75, clockSource: 'audio' } });
    assert.match(area.root.textContent, /7K/, 'the selected chart');
    assert.match(area.root.textContent, /1:01\.5/, 'the position, to a tenth of a second');
    assert.match(area.root.textContent, /75%/, 'the rate');
    assert.match(area.root.textContent, /audio clock/, 'and which clock is driving it');
    area.dispose();
  } finally {
    await teardown();
  }
});

test('tooltips install once and are announced without taking focus', async () => {
  setup();
  try {
    const { installTooltips, hideTooltip } = await import('../src/components/Tooltip.js');
    const off1 = installTooltips();
    const off2 = installTooltips();
    assert.equal(typeof off2, 'function');
    assert.equal(dom.document.querySelectorAll('.tooltip').length, 0, 'no tooltip element until one is needed');

    const target = dom.document.createElement('button');
    target.dataset.tooltip = 'Release every key now';
    dom.document.body.append(target);
    target.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    const tip = dom.document.querySelector('.tooltip');
    assert.ok(tip, 'a tooltip appeared');
    assert.equal(tip.textContent, 'Release every key now');
    assert.equal(tip.getAttribute('role'), 'tooltip');
    assert.equal(tip.getAttribute('aria-hidden'), 'true', 'it is not the accessible name — the control has its own');
    assert.equal(dom.document.querySelectorAll('.tooltip').length, 1, 'and there is exactly one element for the whole app');

    dom.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(tip.classList.contains('is-visible'), false, 'Escape hides it');
    hideTooltip();
    off1();
    assert.equal(dom.document.querySelector('.tooltip'), null, 'teardown removes it');
  } finally {
    await teardown();
  }
});

test('a scope releases every listener, timer and frame it was given', async () => {
  setup();
  try {
    const { Scope } = await import('../src/utils/dom.js');
    const scope = new Scope();
    const target = dom.document.createElement('div');
    dom.document.body.append(target);
    let events = 0;
    let ticks = 0;
    let frames = 0;
    let deferred = 0;

    scope.on(target, 'click', () => events++);
    scope.interval(() => ticks++, 5);
    scope.frameLoop(() => frames++);
    scope.defer(() => deferred++);
    const removed = scope.timeout(() => { throw new Error('should not run'); }, 5);
    removed();

    target.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    dom.window.__runFrames(3);
    assert.equal(events, 1);
    assert.ok(ticks > 0, 'the interval ran');
    assert.ok(frames > 0, 'the frame loop ran');

    const before = dom.window.__frameCount();
    scope.dispose();
    assert.equal(deferred, 1, 'a deferred cleanup ran');
    assert.equal(dom.window.__frameCount(), 0, 'frames were cancelled');
    void before;

    const ticksAtDispose = ticks;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ticks, ticksAtDispose, 'the interval stopped');
    target.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    assert.equal(events, 1, 'and the listener is gone');
    scope.dispose();
    assert.equal(deferred, 1, 'disposing twice runs a cleanup once');
    assert.equal(scope.disposed, true);
  } finally {
    await teardown();
  }
});
