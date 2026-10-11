/**
 * Sidebar — navigation, and the integration status light.
 *
 * The nav is built once and then updated in place: `aria-current` moves, the active marker
 * animates, and nothing is re-created. The status light at the bottom is the same
 * `IntegrationStatus` every other surface reads, so it cannot disagree with the top bar.
 */

import { h, setText, toggleClass } from '../utils/dom.js';
import { icon } from './Icon.js';
import { ROUTES } from '../app/state.js';
import { Level } from '../game/IntegrationStatus.js';

const ROUTE_ICONS = {
  dashboard: 'dashboard',
  library: 'library',
  practice: 'practice',
  timing: 'timing',
  input: 'keyboard',
  statistics: 'statistics',
  settings: 'settings',
};

const LEVEL_DOT = {
  [Level.OK]: 'ok',
  [Level.PARTIAL]: 'warn',
  [Level.UNAVAILABLE]: 'danger',
  [Level.ERROR]: 'danger',
};

/**
 * @param {{ onNavigate: (routeId: string) => void, store: import('../app/state.js').Store }} config
 */
export function createSidebar(config = {}) {
  const { onNavigate, store } = config;

  const brand = h('div.brand',
    h('div.brand__mark', h('i'), h('i'), h('i'), h('i')),
    h('div.brand__text',
      h('span.brand__name', 'ManiaFlow'),
      h('span.brand__sub', 'for Ashtonk!mania'),
    ),
  );

  const nav = h('nav.nav', { 'aria-label': 'Main navigation' });
  const items = new Map();
  let currentGroup = null;
  let groupList = null;

  for (const route of ROUTES) {
    if (route.group !== currentGroup) {
      currentGroup = route.group;
      groupList = h('div.nav__group');
      if (route.group !== 'Overview') groupList.append(h('div.nav__heading', route.group));
      nav.append(groupList);
    }
    const node = h('button.nav__item', {
      type: 'button',
      'data-route': route.id,
      'data-tooltip': route.title,
    });
    node.append(icon(ROUTE_ICONS[route.id] || 'dot', { size: 16 }));
    node.append(h('span.nav__label', route.title));
    const count = h('span.nav__count', { style: { display: 'none' } });
    node.append(count);
    node.addEventListener('click', () => onNavigate(route.id));
    groupList.append(node);
    items.set(route.id, { node, count, route });
  }

  const statusRow = h('div.side-foot__row');
  const statusDot = h('span.dot');
  const statusText = h('span.truncate', 'Checking…');
  statusRow.append(statusDot, statusText);

  const sessionRow = h('div.side-foot__row', { style: { display: 'none' } });
  const sessionDot = h('span.dot.dot--accent.dot--live');
  const sessionText = h('span.truncate');
  sessionRow.append(sessionDot, sessionText);

  const foot = h('div.side-foot', statusRow, sessionRow);
  const root = h('aside.sidebar.app__sidebar', brand, nav, foot);

  // Keyboard: Alt+1..7 jumps to a route, matching the order in the sidebar.
  const onKey = (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(event.key) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= ROUTES.length) return;
    event.preventDefault();
    onNavigate(ROUTES[index].id);
  };
  window.addEventListener('keydown', onKey);

  function setActive(routeId) {
    for (const [id, entry] of items) {
      const on = id === routeId;
      if (on) entry.node.setAttribute('aria-current', 'page');
      else entry.node.removeAttribute('aria-current');
      entry.node.tabIndex = on ? 0 : -1;
    }
  }

  function setChartCount(count) {
    const entry = items.get('library');
    if (!entry) return;
    if (count > 0) {
      setText(entry.count, String(count));
      entry.count.style.display = '';
    } else {
      entry.count.style.display = 'none';
    }
  }

  function setStatus(status) {
    const level = status?.level || Level.UNAVAILABLE;
    statusDot.className = `dot dot--${LEVEL_DOT[level] || 'danger'}${level === Level.OK ? ' dot--live' : ''}`;
    const label = level === Level.OK && status?.practice
      ? 'Practice live'
      : level === Level.OK ? 'Game connected'
        : level === Level.PARTIAL ? 'Connected'
          : level === Level.ERROR ? 'Error'
            : 'Offline';
    setText(statusText, label);
    statusRow.dataset.tooltip = status
      ? `${status.label} — ${status.detail}`
      : 'Integration status is not available yet';
    toggleClass(statusRow, 'is-error', level === Level.ERROR);
  }

  function setSession(text) {
    if (!text) { sessionRow.style.display = 'none'; return; }
    sessionRow.style.display = '';
    setText(sessionText, text);
  }

  // Wire the parts of the store the sidebar shows, and tear the listener down on dispose.
  const offs = store ? [
    store.subscribe((s) => s.route, setActive),
    store.subscribe((s) => s.charts.length, setChartCount),
    store.subscribe((s) => s.integration, setStatus),
    store.subscribe((s) => (s.activeSession ? `Session · ${s.activeSession.elapsedLabel || 'running'}` : null), setSession),
  ] : [];

  return {
    root,
    setActive,
    setChartCount,
    setStatus,
    setSession,
    focusRoute(routeId) { items.get(routeId)?.node.focus(); },
    dispose() {
      window.removeEventListener('keydown', onKey);
      for (const off of offs) off();
    },
  };
}
