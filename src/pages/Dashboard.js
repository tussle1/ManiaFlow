/**
 * Dashboard — the state of the application at a glance, and nothing else.
 *
 * The brief for this screen is restraint: it explains where things stand and offers one
 * obvious next action. Advanced controls live on their own screens. Every figure here comes
 * from the store or the session history, so a fresh install shows honest empty states
 * rather than plausible-looking numbers.
 */

import { h, setText, clear, Scope } from '../utils/dom.js';
import { panel, stat, emptyState, note, badge, statusDot, sparkline, sectionHead, shortcutRow } from '../components/primitives.js';
import { button } from '../components/Button.js';
import { icon } from '../components/Icon.js';
import { Level } from '../game/IntegrationStatus.js';
import { totals, dailyTrend, coverage } from '../analytics/StatisticsEngine.js';
import { formatDuration, formatElapsed, formatRelative, formatCount } from '../utils/formatters.js';
import { displayName, displayFullName } from '../chart/ChartRecord.js';

export function createDashboardPage(context) {
  const { store, prefs, actions, navigate } = context;
  const scope = new Scope();
  const unicode = () => !!prefs.get('appearance.unicodeMetadata');

  const root = h('div');

  /* ── heading and the one quick action ─────────────────────────────── */

  const heading = h('div.page__head-row',
    h('div.page__head',
      h('h1.page__title', 'ManiaFlow'),
      h('p.page__subtitle', 'A local practice, chart-analysis and timing tool for Ashtonk!mania. '
        + 'It reads the game through a bridge you install yourself, and it works on charts you import when there is no game to read.'),
    ),
    h('div.page__actions'),
  );
  const actionsRow = heading.querySelector('.page__actions');

  const importButton = button({ label: 'Import charts', icon: 'upload', variant: 'primary', onClick: () => pickFiles() });
  const libraryButton = button({ label: 'Chart library', icon: 'library', onClick: () => navigate('library') });
  const reconnectButton = button({ label: 'Reconnect', icon: 'refresh', onClick: () => actions.reconnect() });
  actionsRow.append(importButton, libraryButton, reconnectButton);

  const fileInput = h('input', { type: 'file', multiple: true, accept: '.osu,.osz,.zip', style: { display: 'none' } });
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) actions.importFiles(fileInput.files);
    fileInput.value = '';
  });
  root.append(fileInput);
  function pickFiles() { fileInput.click(); }

  /* ── integration health ───────────────────────────────────────────── */

  const statusPanel = panel({
    title: 'Integration',
    icon: 'plug',
    body: h('div.stack'),
  });
  const statusBody = statusPanel.body;
  const linkList = h('div.stack', { style: { gap: '6px' } });
  const statusSummary = h('div.small.dim');
  const statusActions = h('div.row', { style: { marginTop: '4px', flexWrap: 'wrap' } });
  statusBody.append(statusSummary, linkList, statusActions);

  function renderStatus(status) {
    const level = status?.level || Level.UNAVAILABLE;
    setText(statusSummary, status?.detail || 'Integration status is not available yet.');
    statusSummary.className = `small ${level === Level.OK ? '' : level === Level.PARTIAL ? 'dim' : 'muted'}`;

    clear(linkList);
    for (const link of status?.links || []) {
      const dotLevel = link.ok ? (link.optional ? 'accent' : 'ok') : link.optional ? 'idle' : 'danger';
      const row = h('div.row', { style: { gap: '8px' } },
        h(`span.dot.dot--${dotLevel}`),
        h('span.small', { style: { minWidth: '132px' } }, link.label),
        h('span.small.muted.truncate.grow', link.detail || ''),
      );
      row.dataset.tooltip = link.detail || link.label;
      linkList.append(row);
    }

    clear(statusActions);
    const practice = status?.practice && level === Level.OK;
    statusActions.append(
      button({
        label: practice ? 'Open Input Lab' : 'Open Practice Studio',
        icon: practice ? 'keyboard' : 'practice', size: 'sm',
        onClick: () => navigate(practice ? 'input' : 'practice'),
      }),
      button({ label: 'Integration settings', icon: 'settings', size: 'sm', variant: 'ghost', onClick: () => navigate('settings') }),
    );
    if (!status?.capabilities?.syntheticInput && status?.bridgeConnected && status?.blockingReason) {
      statusActions.append(h('span.small.muted.truncate', status.blockingReason));
    }
  }

  /* ── session summary ──────────────────────────────────────────────── */

  const summaryStats = {
    sessions: stat({ label: 'Sessions', value: '0', tooltip: 'Practice, analysis and input runs recorded by ManiaFlow' }),
    time: stat({ label: 'Time recorded', value: '0s', tooltip: 'Total duration of recorded sessions' }),
    charts: stat({ label: 'Charts', value: '0', tooltip: 'Distinct charts with at least one recorded session' }),
    notes: stat({ label: 'Notes processed', value: '0', tooltip: 'Notes parsed across recorded analyses' }),
  };
  const summaryGrid = h('div.grid.grid--4', ...Object.values(summaryStats).map((s) => s.root));

  const trend = sparkline({ height: 46, label: 'Sessions per day over the last two weeks' });
  const trendPanel = panel({
    title: 'Last 14 days',
    subtitle: 'sessions per day',
    body: h('div.stack', trend.root, h('div.xs.muted', 'Nothing recorded yet')),
  });
  const trendNote = trendPanel.body.lastElementChild;

  const summaryPanel = panel({
    title: 'Your sessions',
    icon: 'history',
    body: h('div.stack', summaryGrid, trendPanel.root),
    actions: button({ label: 'Statistics', icon: 'statistics', size: 'sm', variant: 'ghost', onClick: () => navigate('statistics') }),
  });

  function renderSummary(sessions) {
    const t = totals(sessions);
    summaryStats.sessions.setValue(t.sessions ? formatCount(t.sessions) : '0');
    summaryStats.time.setValue(t.totalDurationMs ? formatElapsed(t.totalDurationMs) : '0s');
    summaryStats.charts.setValue(t.distinctCharts ? formatCount(t.distinctCharts) : '0');
    summaryStats.notes.setValue(t.notesProcessed ? formatCount(t.notesProcessed) : '0');

    const days = dailyTrend(sessions, { days: 14 });
    trend.draw(days.map((d) => d.sessions), { min: 0, points: true, fill: true });
    const active = days.filter((d) => d.sessions > 0).length;
    setText(trendNote, active
      ? `${active} of the last 14 days have recorded activity · ${formatCount(t.sessions)} session${t.sessions === 1 ? '' : 's'} in total`
      : 'No sessions recorded in the last 14 days. Anything you analyse or practise in ManiaFlow is recorded here.');
  }

  /* ── recent charts ────────────────────────────────────────────────── */

  const recentList = h('div.list', { role: 'list', 'aria-label': 'Recently opened charts' });
  const recentPanel = panel({
    title: 'Recently opened',
    icon: 'history',
    body: recentList,
    actions: button({ label: 'Browse all', icon: 'arrowRight', size: 'sm', variant: 'ghost', onClick: () => navigate('library') }),
  });

  function renderRecents(charts, recents) {
    clear(recentList);
    // A chart opened this session counts even before it has a stored session behind it.
    const opened = charts.filter((c) => c.openedAt).sort((a, b) => b.openedAt - a.openedAt).slice(0, 6);
    const fromSessions = recents.filter((r) => !opened.some((c) => c.id === r.chart.id)).slice(0, 6 - opened.length);
    const entries = [
      ...opened.map((record) => ({ record, at: record.openedAt, from: 'opened' })),
      ...fromSessions.map((entry) => ({ record: entry.chart, at: entry.at, from: 'session' })),
    ].sort((a, b) => b.at - a.at).slice(0, 6);

    if (!entries.length) {
      recentList.append(emptyState({
        icon: 'library',
        title: 'No charts yet',
        body: 'Drop an .osu difficulty or an .osz beatmap set anywhere in this window, or read the library from Ashtonk!mania once a bridge is connected.',
        actions: [
          button({ label: 'Import charts', icon: 'upload', variant: 'primary', size: 'sm', onClick: pickFiles }),
          button({ label: 'Read the game library', icon: 'plug', size: 'sm', onClick: () => actions.refreshLibrary() }),
          button({ label: 'Load example charts', icon: 'note', size: 'sm', variant: 'ghost', tooltip: 'Three generated sample charts, so there is something to look at before you import your own', onClick: () => actions.loadExamples() }),
        ],
      }));
      return;
    }

    for (const entry of entries) {
      const record = entry.record;
      const row = h('button.list__row', { type: 'button', role: 'listitem' });
      const meta = [
        record.keys ? `${record.keys}K` : null,
        record.version || null,
        Number.isFinite(+record.stars) && +record.stars > 0 ? `${(+record.stars).toFixed(2)}★` : null,
        record.bpm ? `${Math.round(record.bpm)} BPM` : null,
        record.length ? formatDuration(record.length) : null,
      ].filter(Boolean).join(' · ');

      row.append(
        h('div.grow', { style: { minWidth: 0 } },
          h('div.truncate', { style: { fontWeight: '500' } }, displayName(record, unicode())),
          h('div.xs.muted.truncate', meta || 'No metadata'),
        ),
        h('span.xs.faint.shrink-0', formatRelative(entry.at)),
        icon('chevronRight', { size: 14 }),
      );
      row.dataset.tooltip = displayFullName(record, unicode());
      row.addEventListener('click', async () => {
        const full = charts.find((c) => c.id === record.id) || record;
        await actions.openChart(full);
        navigate('practice');
      });
      recentList.append(row);
    }
  }

  /* ── tools ────────────────────────────────────────────────────────── */

  const toolCards = [
    { id: 'practice', icon: 'practice', title: 'Practice Studio', body: 'Preview a chart, scrub its timeline, change speed and loop a section.' },
    { id: 'timing', icon: 'timing', title: 'Timing Lab', body: 'Inspect intervals, BPM changes, chords, holds and scroll velocity.' },
    { id: 'input', icon: 'keyboard', title: 'Input Lab', body: 'Map lanes to keys, verify a backend, and run an authorised practice input.' },
    { id: 'statistics', icon: 'statistics', title: 'Statistics', body: 'Session history, trends and export of what ManiaFlow itself recorded.' },
  ].map((tool) => {
    const card = h('button.panel.panel--interactive', {
      type: 'button', style: { textAlign: 'left', gap: '0', padding: '0', cursor: 'pointer' },
      'aria-label': `${tool.title} — ${tool.body}`,
    });
    card.append(h('div.panel__body',
      h('div.row', { style: { gap: '10px', color: 'var(--accent-bright)' } }, icon(tool.icon, { size: 17 })),
      h('div.strong', { style: { marginTop: '6px' } }, tool.title),
      h('div.small.muted', { style: { marginTop: '2px', lineHeight: '1.5' } }, tool.body),
    ));
    card.addEventListener('click', () => navigate(tool.id));
    return card;
  });

  const toolsPanel = panel({ title: 'Tools', icon: 'grid', body: h('div.grid.grid--4', ...toolCards) });

  /* ── honest limitations, shown once, where they are relevant ──────── */

  const limitationPanel = panel({
    title: 'What this is not',
    icon: 'shield',
    body: h('div.stack'),
  });
  limitationPanel.body.append(
    note({
      variant: 'accent', icon: 'shield',
      text: 'ManiaFlow never uses Ashtonk!mania’s own Auto mod, and it records no scores, ranks, pp or grades. '
        + 'Its input path refuses to arm outside the game’s practice mode, because a scored play is re-judged server-side '
        + 'and perfect-timing input is rejected there as inhuman.',
    }),
    h('div.stack', { style: { gap: '2px' } },
      shortcutRow('Synthetic input is not hardware input', ['isTrusted', 'false'],
        'The in-page bridge dispatches real KeyboardEvents, and the game resolves them by key code — but the browser marks them as untrusted. ManiaFlow says so rather than implying otherwise.'),
      shortcutRow('Star ratings come from the game', ['bridge'],
        'A locally imported chart shows no star rating. Ashtonk!mania computes it with lazer’s mania strain model; ManiaFlow does not approximate it.'),
      shortcutRow('osu!standard charts are not converted here', ['mode', '0'],
        'The lazer conversion belongs to the game. Connect a bridge to read the converted notes instead of getting an approximation.'),
    ),
  );

  /* ── layout ───────────────────────────────────────────────────────── */

  root.append(
    heading,
    h('div.grid.grid--split',
      h('div.stack', recentPanel.root, toolsPanel.root),
      h('div.stack', statusPanel.root, summaryPanel.root),
    ),
    limitationPanel.root,
  );

  /* ── live updates ─────────────────────────────────────────────────── */

  scope.defer(store.subscribe((s) => s.integration, renderStatus));
  scope.defer(store.subscribe((s) => s.sessions, (sessions) => renderSummary(sessions), { immediate: false }));
  scope.defer(store.subscribe(
    (s) => ({ charts: s.charts, recents: s.recents }),
    ({ charts, recents }) => renderRecents(charts, recents),
  ));
  scope.defer(store.subscribe((s) => s.importing, (busy) => {
    importButton.disabled = !!busy;
    setText(importButton.querySelector('span'), busy ? 'Importing…' : 'Import charts');
  }));
  scope.defer(store.subscribe((s) => s.integration?.capabilities?.readLibrary, (can) => {
    reconnectButton.disabled = false;
    libraryButton.dataset.tooltip = can ? 'Browse charts from the game and from your imports' : 'Browse charts you have imported';
  }));

  // The session summary needs its first paint from the current store, not only on change.
  renderSummary(store.state.sessions);
  renderStatus(store.state.integration);

  return {
    root,
    focus: () => importButton.focus({ preventScroll: true }),
    dispose: () => scope.dispose(),
  };
}
