/**
 * Status area — the strip along the bottom.
 *
 * It answers three questions without being asked: what is the app doing, what is selected,
 * and is anything wrong. Errors get the whole strip and a plain-language reason, because a
 * status bar that only shows a red dot is a status bar nobody can act on.
 */

import { h, setText, clear } from '../utils/dom.js';
import { icon } from './Icon.js';
import { formatDuration, formatRate, formatCount } from '../utils/formatters.js';
import { Level } from '../game/IntegrationStatus.js';

/**
 * @param {{ store: import('../app/state.js').Store }} config
 */
export function createStatusArea(config = {}) {
  const { store } = config;

  const appItem = h('span.statusbar__item');
  const chartItem = h('span.statusbar__item');
  const playbackItem = h('span.statusbar__item');
  const messageItem = h('span.statusbar__item.grow');
  const errorItem = h('span.statusbar__item.statusbar__item--error', { style: { display: 'none' } });

  const root = h('footer.statusbar.app__status', { role: 'status', 'aria-live': 'polite' },
    appItem,
    h('span.statusbar__sep'),
    chartItem,
    h('span.statusbar__sep'),
    playbackItem,
    h('span.statusbar__sep'),
    messageItem,
    errorItem,
  );

  const view = { app: null, chart: null, playback: null, message: null, error: null };

  function render() {
    setText(appItem, view.app ?? 'Ready');
    appItem.dataset.tooltip = 'Current application status';

    if (view.chart) {
      setText(chartItem, view.chart);
      chartItem.style.display = '';
    } else {
      setText(chartItem, '');
      chartItem.style.display = 'none';
    }

    if (view.playback) {
      setText(playbackItem, view.playback);
      playbackItem.style.display = '';
    } else {
      setText(playbackItem, '');
      playbackItem.style.display = 'none';
    }

    setText(messageItem, view.message ?? '');
    messageItem.classList.toggle('truncate', !!view.message);
    if (view.message) messageItem.dataset.tooltip = view.message;
    else delete messageItem.dataset.tooltip;

    if (view.error) {
      clear(errorItem);
      errorItem.append(icon('alert', { size: 11 }), h('span.truncate', view.error));
      errorItem.style.display = '';
      errorItem.dataset.tooltip = view.error;
    } else {
      errorItem.style.display = 'none';
      errorItem.dataset.tooltip = '';
    }
  }

  render();

  const offs = store ? [
    store.subscribe((state) => {
      if (state.busy) return state.busyLabel || 'Working…';
      if (state.integration?.level === Level.OK && state.integration?.practice) return 'Practice live';
      if (state.integration?.bridgeConnected) return 'Bridge connected';
      if (state.integration?.links?.[0]?.ok) return 'Server connected';
      return 'Offline — local charts only';
    }, (text) => { view.app = text; render(); }),

    store.subscribe(
      (state) => (state.loadedChart
        ? `${state.loadedChart.keys || '?'}K · ${formatCount(state.loadedChart.objectCount || 0)} notes`
        : null),
      (text) => { view.chart = text; render(); },
    ),

    store.subscribe(
      (state) => {
        const playback = state.playback;
        if (!playback || playback.state === 'idle') return null;
        const position = formatDuration(playback.position || 0, { tenths: true });
        const total = formatDuration(playback.durationMs || 0);
        const rate = playback.rate !== 1 ? ` · ${formatRate(playback.rate)}` : '';
        const clock = playback.clockSource === 'audio' ? ' · audio clock' : '';
        return `${playback.state} ${position} / ${total}${rate}${clock}`;
      },
      (text) => { view.playback = text; render(); },
    ),

    store.subscribe((state) => state.statusMessage, (text) => { view.message = text; render(); }),

    store.subscribe(
      (state) => state.loadError?.message || state.libraryError || state.integration?.blockingReason || null,
      (text) => { view.error = text; render(); },
    ),
  ] : [];

  return {
    root,
    setMessage(text) { view.message = text ?? null; render(); },
    dispose() { for (const off of offs) off(); },
  };
}
