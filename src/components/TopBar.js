/**
 * Top bar — where the user is, what is selected, and whether the game is reachable.
 *
 * It carries no controls that are not also available on the page below it, except the two
 * that are genuinely global: integration status and the jump to Settings. Everything here
 * updates by writing into nodes built once, so a route change or a chart load never
 * rebuilds the bar.
 */

import { h, setText, toggleClass } from '../utils/dom.js';
import { icon } from './Icon.js';
import { button } from './Button.js';
import { badge } from './primitives.js';
import { Level } from '../game/IntegrationStatus.js';
import { routeById } from '../app/state.js';
import { displayFullName } from '../chart/ChartRecord.js';
import { formatRate } from '../utils/formatters.js';

const SCREEN_LABELS = { home: 'menu', songselect: 'song select', gameplay: 'gameplay', results: 'results' };

const LEVEL_STYLE = {
  [Level.OK]: { dot: 'ok', label: 'Connected' },
  [Level.PARTIAL]: { dot: 'warn', label: 'Connected' },
  [Level.UNAVAILABLE]: { dot: 'danger', label: 'Offline' },
  [Level.ERROR]: { dot: 'danger', label: 'Error' },
};

/**
 * @param {{ store: import('../app/state.js').Store, onNavigate: (id: string) => void,
 *           onShortcuts: () => void }} config
 */
export function createTopBar(config = {}) {
  const { store, onNavigate, onShortcuts } = config;

  const title = h('h1.topbar__title', 'Dashboard');

  const chartLabel = h('span.truncate.faint', { style: { maxWidth: '38ch' } }, 'No chart selected');
  const rateBadge = badge({ label: '100%' });
  rateBadge.style.display = 'none';
  const context = h('div.topbar__context', chartLabel, rateBadge);

  const statusDot = h('span.dot.dot--danger');
  const statusLabel = h('span', 'Offline');
  const statusNode = h('button.btn.btn--sm.btn--ghost', {
    type: 'button',
    'data-tooltip': 'Integration status — open Settings → Integration',
    'aria-label': 'Integration status: offline',
  }, statusDot, statusLabel);
  statusNode.addEventListener('click', () => onNavigate?.('settings'));

  const shortcuts = button({
    icon: 'question', size: 'sm', variant: 'ghost',
    ariaLabel: 'Keyboard shortcuts', tooltip: 'Keyboard shortcuts (?)',
    onClick: () => onShortcuts?.(),
  });
  const settings = button({
    icon: 'settings', size: 'sm', variant: 'ghost',
    ariaLabel: 'Open settings', tooltip: 'Settings',
    onClick: () => onNavigate?.('settings'),
  });

  const root = h('header.topbar.app__topbar',
    title,
    h('div.topbar__divider'),
    context,
    h('div.grow'),
    statusNode,
    h('div.topbar__divider'),
    shortcuts,
    settings,
  );

  function setRoute(routeId) {
    const route = routeById(routeId);
    setText(title, route ? route.title : 'ManiaFlow');
  }

  /** @param {{ name: string|null, keys: number|null, version: string|null, stars: number|null, rate: number|null }} view */
  function setChart(view) {
    if (!view || !view.name) {
      chartLabel.classList.add('faint');
      setText(chartLabel, 'No chart selected');
      delete chartLabel.dataset.tooltip;
      rateBadge.style.display = 'none';
      return;
    }
    chartLabel.classList.remove('faint');
    setText(chartLabel, view.name);
    chartLabel.dataset.tooltip = [
      view.keys ? `${view.keys}K` : null,
      view.version || null,
      Number.isFinite(+view.stars) && +view.stars > 0 ? `${(+view.stars).toFixed(2)}★` : null,
    ].filter(Boolean).join(' · ') || view.name;
    if (view.rate != null) {
      rateBadge.style.display = '';
      rateBadge.setLabel(formatRate(view.rate));
    } else {
      rateBadge.style.display = 'none';
    }
  }

  function setStatus(status) {
    const level = status?.level || Level.UNAVAILABLE;
    const style = LEVEL_STYLE[level] || LEVEL_STYLE[Level.UNAVAILABLE];
    statusDot.className = `dot dot--${style.dot}`;
    toggleClass(statusDot, 'dot--live', level === Level.OK || level === Level.PARTIAL);
    const label = level === Level.OK && status?.practice
      ? 'Practice live'
      : level === Level.PARTIAL
        ? `Connected · ${SCREEN_LABELS[status.screen] || status.screen || 'game'}`
        : style.label;
    setText(statusLabel, label);
    statusNode.dataset.tooltip = status ? `${status.label} — ${status.detail}` : 'Integration status is not available yet';
    statusNode.setAttribute('aria-label', `Integration status: ${status?.label || 'offline'}. ${status?.detail || ''}`);
  }

  /** Replace the chart context with a transient message, then restore it. */
  let flashTimer = 0;
  let lastChartView = null;
  function flash(message, ms = 2400) {
    clearTimeout(flashTimer);
    setText(chartLabel, message);
    chartLabel.classList.remove('faint');
    chartLabel.classList.add('dim');
    flashTimer = setTimeout(() => {
      chartLabel.classList.remove('dim');
      setChart(lastChartView);
    }, ms);
  }

  const offs = store ? [
    store.subscribe((state) => state.route, setRoute),
    store.subscribe((state) => state.integration, setStatus),
    store.subscribe(
      (state) => ({
        name: state.loadedChart ? displayFullName(state.loadedChart, state.unicodeMetadata) : null,
        keys: state.loadedChart?.keys ?? null,
        version: state.loadedChart?.version ?? null,
        stars: state.loadedChart?.stars ?? null,
        rate: state.playback?.state === 'playing' || state.playback?.rate != null ? state.playback?.rate ?? null : null,
      }),
      (view) => { lastChartView = view; if (!flashTimer) setChart(view); },
    ),
  ] : [];

  return {
    root,
    setRoute,
    setChart: (view) => { lastChartView = view; setChart(view); },
    setStatus,
    flash,
    dispose() {
      clearTimeout(flashTimer);
      for (const off of offs) off();
    },
  };
}

export { icon };
