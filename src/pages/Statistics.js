/**
 * Statistics — what ManiaFlow itself recorded, and nothing else.
 *
 * There are no scores, ranks, pp, grades or competitive figures here, and that is deliberate:
 * ManiaFlow has no access to the game's score database beyond what the game exposes, and it
 * does not invent any. What it does have is a record of its own work — sessions opened,
 * charts analysed, notes parsed, previews played, timings measured, input runs executed —
 * and every figure on this screen is one of those.
 *
 * A metric with no data behind it renders as a dash with an explanation, never as a zero.
 * "No sessions recorded" and "sessions recorded, none of which measured this" are different
 * facts, and conflating them is how a tool starts telling its user things that are not true.
 */

import { h, setText, clear, Scope } from '../utils/dom.js';
import { panel, stat, emptyState, note, badge, sparkline, definitionList } from '../components/primitives.js';
import { button } from '../components/Button.js';
import { dropdown } from '../components/Dropdown.js';
import { Toast } from '../components/Toast.js';
import { Dialog, confirm } from '../components/Dialog.js';
import {
  totals, dailyTrend, rateHistogram, timingSummary, byChart, errorBreakdown, coverage, compare,
} from '../analytics/StatisticsEngine.js';
import { SessionKind, SessionStatus } from '../storage/SessionStore.js';
import { formatDuration, formatElapsed, formatCount, formatRelative, formatDateTime, formatMs, formatRate } from '../utils/formatters.js';
import { describeError } from '../utils/errors.js';
import { displayName } from '../chart/ChartRecord.js';
import { downloadJson } from '../app/App.js';

const KIND_LABELS = {
  [SessionKind.PRACTICE]: 'Practice',
  [SessionKind.ANALYSIS]: 'Analysis',
  [SessionKind.SIMULATION]: 'Simulation',
  [SessionKind.INPUT]: 'Input run',
};
const STATUS_LABELS = {
  [SessionStatus.COMPLETED]: 'completed',
  [SessionStatus.ABORTED]: 'aborted',
  [SessionStatus.ERROR]: 'error',
  [SessionStatus.RUNNING]: 'running',
};

export function createStatisticsPage(context) {
  const { store, prefs, actions, sessions, navigate } = context;
  const scope = new Scope();
  const unicode = () => !!prefs.get('appearance.unicodeMetadata');

  let selectedId = null;
  let kindFilter = null;
  let compareWith = null;

  /* ── headline ─────────────────────────────────────────────────────── */

  const headline = {
    sessions: stat({ label: 'Sessions', value: '0', tooltip: 'Every session ManiaFlow opened: practice previews, analyses, simulations and input runs' }),
    time: stat({ label: 'Time recorded', value: '0s' }),
    charts: stat({ label: 'Distinct charts', value: '0' }),
    notes: stat({ label: 'Notes processed', value: '0', tooltip: 'Notes parsed across recorded analyses' }),
    input: stat({ label: 'Input runs', value: '0', tooltip: 'Runs where a key schedule was executed' }),
    refused: stat({ label: 'Refused runs', value: '0', tooltip: 'Times the safety gate refused to arm input' }),
    errors: stat({ label: 'Errors recorded', value: '0' }),
    last: stat({ label: 'Last session', value: '—' }),
  };

  const trend = sparkline({ height: 68, label: 'Sessions per day over the last 30 days' });
  const durationTrend = sparkline({ height: 68, label: 'Recorded minutes per day over the last 30 days' });

  const storageNote = h('div');

  const overviewPanel = panel({
    title: 'Overview', icon: 'statistics',
    body: h('div.stack',
      h('div.grid.grid--4', ...Object.values(headline).map((s) => s.root)),
      h('div.grid.grid--2',
        panel({ title: 'Sessions per day', subtitle: 'last 30 days', body: h('div.stack', trend.root) }).root,
        panel({ title: 'Time recorded per day', subtitle: 'last 30 days', body: h('div.stack', durationTrend.root) }).root,
      ),
      storageNote,
    ),
  });

  /* ── rates and timing ─────────────────────────────────────────────── */

  const rateBody = h('div.stack', { style: { gap: '6px' } });
  const timingStats = {
    runs: stat({ label: 'Timed runs', value: '0' }),
    mean: stat({ label: 'Mean error', value: '—' }),
    spread: stat({ label: 'Mean σ', value: '—' }),
    ur: stat({ label: 'Mean unstable rate', value: '—', accent: true }),
  };
  const urTrend = sparkline({ height: 60, label: 'Unstable rate across recorded runs' });
  const timingNote = h('div');

  const breakdownPanel = panel({
    title: 'Speeds and timing', icon: 'gauge',
    body: h('div.stack',
      h('div.label-upper', 'Playback speeds actually used'),
      rateBody,
      h('div.divider'),
      h('div.grid.grid--4', ...Object.values(timingStats).map((s) => s.root)),
      urTrend.root,
      timingNote,
    ),
  });

  /* ── history ──────────────────────────────────────────────────────── */

  const historyList = h('div.list', { role: 'listbox', 'aria-label': 'Session history', style: { maxHeight: '420px', overflowY: 'auto' } });
  const kindFilterControl = dropdown({
    label: 'All kinds', size: 'sm', ariaLabel: 'Filter sessions by kind',
    items: () => [
      { label: 'All kinds', checked: !kindFilter, onClick: () => { kindFilter = null; kindFilterControl.setLabel('All kinds'); renderHistory(); } },
      { type: 'separator' },
      ...Object.entries(KIND_LABELS).map(([id, label]) => ({
        label, checked: kindFilter === id,
        onClick: () => { kindFilter = id; kindFilterControl.setLabel(label); renderHistory(); },
      })),
    ],
  });

  const historyPanel = panel({
    title: 'Session history', icon: 'history',
    body: historyList,
    actions: h('div.row', { style: { gap: '6px' } },
      kindFilterControl.node,
      button({ icon: 'refresh', size: 'sm', variant: 'ghost', ariaLabel: 'Reload history', tooltip: 'Reload from storage', onClick: () => actions.refreshSessions() }),
    ),
  });

  /* ── detail ───────────────────────────────────────────────────────── */

  const detailBody = h('div.stack');
  const detailPanel = panel({
    title: 'Session detail', icon: 'info',
    body: detailBody,
    actions: h('div.row', { style: { gap: '6px' } },
      button({ label: 'Export all', icon: 'download', size: 'sm', onClick: () => exportAll() }),
      button({ label: 'Import', icon: 'upload', size: 'sm', variant: 'ghost', onClick: () => importFile.click() }),
      button({ icon: 'trash', size: 'sm', variant: 'ghost', ariaLabel: 'Clear all history', tooltip: 'Clear all recorded history', onClick: () => clearAll() }),
    ),
  });

  const importFile = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const result = await sessions.importAll(data);
      await actions.refreshSessions();
      Toast.ok(`Imported ${result.imported} session${result.imported === 1 ? '' : 's'}${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}`, 'Import complete');
    } catch (err) {
      Toast.error(describeError(err), 'Import failed');
    }
  });

  /* ── data management ──────────────────────────────────────────────── */

  const dataPanel = panel({
    title: 'Data', icon: 'save',
    body: h('div.stack'),
  });

  function renderDataPanel() {
    clear(dataPanel.body);
    const health = store.state.sessionHealth;
    dataPanel.body.append(
      note({
        variant: health?.backend === 'indexeddb' ? 'accent' : 'warn',
        icon: health?.backend === 'indexeddb' ? 'check' : 'alert',
        title: `Stored in ${health?.backend === 'indexeddb' ? 'IndexedDB' : health?.backend === 'localstorage' ? 'localStorage' : 'memory'}`,
        text: health?.reason || 'Session history is stored in this browser only. Nothing is uploaded anywhere.',
      }),
      h('div.row.row--wrap', { style: { gap: '6px' } },
        button({ label: 'Export all as JSON', icon: 'download', size: 'sm', onClick: () => exportAll() }),
        button({ label: 'Import a JSON export', icon: 'upload', size: 'sm', variant: 'ghost', onClick: () => importFile.click() }),
        button({ label: 'Clear all history', icon: 'trash', size: 'sm', variant: 'danger', onClick: () => clearAll() }),
      ),
      h('div.xs.muted', 'An export is the whole store, exactly as recorded: sessions, marks, errors and the configuration each one ran with. Importing merges by session id, so re-importing the same file does not duplicate anything.'),
    );
  }

  /* ── layout ───────────────────────────────────────────────────────── */

  const root = h('div',
    h('div.page__head-row',
      h('div.page__head',
        h('h1.page__title', 'Statistics'),
        h('p.page__subtitle', 'Everything ManiaFlow itself recorded: sessions opened, charts analysed, notes parsed, previews played, '
          + 'timing experiments run and input sessions executed. No scores, ranks or competitive data — ManiaFlow has none and invents none.'),
      ),
      h('div.page__actions', importFile),
    ),
    overviewPanel.root,
    h('div.grid.grid--split',
      h('div.stack', breakdownPanel.root, historyPanel.root),
      h('div.stack', detailPanel.root, dataPanel.root),
    ),
  );

  /* ── rendering ────────────────────────────────────────────────────── */

  function renderAll() {
    const list = store.state.sessions;
    const t = totals(list);
    const has = coverage(list);

    headline.sessions.setValue(t.sessions ? formatCount(t.sessions) : '0');
    headline.time.setValue(t.totalDurationMs ? formatElapsed(t.totalDurationMs) : '0s');
    headline.charts.setValue(t.distinctCharts ? formatCount(t.distinctCharts) : '0');
    headline.notes.setValue(t.notesProcessed ? formatCount(t.notesProcessed) : '0');
    headline.input.setValue(t.inputRuns ? formatCount(t.inputRuns) : '0');
    headline.refused.setValue(t.refusedRuns ? formatCount(t.refusedRuns) : '0');
    headline.errors.setValue(t.errors ? formatCount(t.errors) : '0');
    headline.last.setValue(t.lastAt ? formatRelative(t.lastAt) : '—');

    if (!has.any) {
      renderNoData();
      return;
    }

    const days = dailyTrend(list, { days: 30 });
    trend.draw(days.map((d) => d.sessions), { min: 0, fill: true });
    durationTrend.draw(days.map((d) => Math.round(d.durationMs / 60000)), { min: 0, fill: true });

    clear(storageNote);
    const health = store.state.sessionHealth;
    storageNote.append(note({
      variant: health?.backend === 'indexeddb' ? 'accent' : 'warn',
      icon: 'save',
      text: health?.reason || `${formatCount(t.sessions)} sessions stored in ${health?.backend === 'localstorage' ? 'localStorage' : 'IndexedDB'} on this device. Nothing leaves your browser.`,
    }));

    renderRates(list);
    renderTiming(list);
    renderHistory();
    renderDetail(list);
    renderDataPanel();
  }

  function renderNoData() {
    clear(storageNote);
    clear(rateBody);
    rateBody.append(h('div.small.muted', 'No playback speeds recorded yet.'));
    for (const s of Object.values(timingStats)) s.setValue('0');
    urTrend.draw([], {});
    clear(timingNote);
    timingNote.append(h('div.small.muted', 'Run a timing experiment in the Timing Lab to record one.'));

    clear(historyList);
    historyList.append(emptyState({
      icon: 'history',
      title: 'Nothing recorded yet',
      body: 'ManiaFlow records what it does: analysing a chart, previewing one in the Practice Studio, running a timing experiment, '
        + 'or executing an input session. Open a chart and those start appearing here.',
      actions: [
        button({ label: 'Chart library', icon: 'library', size: 'sm', variant: 'primary', onClick: () => navigate('library') }),
        button({ label: 'Timing Lab', icon: 'timing', size: 'sm', onClick: () => navigate('timing') }),
      ],
      secondary: 'There is no demo data and nothing is seeded — an empty history means ManiaFlow has not been used yet.',
    }));

    clear(detailBody);
    detailBody.append(emptyState({
      icon: 'info', title: 'No session selected',
      body: 'Choose a session from the history to see exactly what it measured.',
    }));
    renderDataPanel();
  }

  function renderRates(list) {
    clear(rateBody);
    const rates = rateHistogram(list);
    if (!rates.length) {
      rateBody.append(h('div.small.muted', 'No playback speed was recorded. A preview run in the Practice Studio stores one.'));
      return;
    }
    const max = Math.max(...rates.map((r) => r.count));
    for (const entry of rates) {
      const row = h('div.row', { style: { gap: '8px' } },
        h('span.num.small', { style: { minWidth: '46px' } }, formatRate(entry.rate)),
        h('div.meter.grow', { style: { height: '6px' } }),
        h('span.num.xs.muted', { style: { minWidth: '52px', textAlign: 'right' } }, `${entry.count} ×`),
      );
      const fill = h('div.meter__fill');
      fill.style.width = `${(entry.count / max) * 100}%`;
      row.querySelector('.meter').append(fill);
      rateBody.append(row);
    }
  }

  function renderTiming(list) {
    const summary = timingSummary(list);
    timingStats.runs.setValue(summary.runs ? formatCount(summary.runs) : '0');
    timingStats.mean.setValue(summary.mean ? formatMs(summary.mean.mean) : '—');
    timingStats.spread.setValue(summary.stdDev ? formatMs(summary.stdDev.mean, { digits: 2, sign: false }) : '—');
    timingStats.ur.setValue(summary.unstableRate ? summary.unstableRate.mean.toFixed(2) : '—');

    if (summary.history.length >= 2) {
      urTrend.draw(summary.history.map((run) => run.unstableRate), { min: 0, points: true });
    } else {
      urTrend.draw([], {});
    }

    clear(timingNote);
    if (!summary.runs) {
      timingNote.append(h('div.small.muted', 'No timing data recorded. The Timing Lab stores one when you run an experiment.'));
      return;
    }
    timingNote.append(note({
      icon: 'shield',
      text: `Ashtonk!mania’s verifier rejects an unstable rate below 15 over 100 or more judged notes as inhuman timing. `
        + `${summary.runs} recorded run${summary.runs === 1 ? '' : 's'} here are simulations and practice measurements, not plays — none of them was submitted anywhere.`,
    }));
  }

  function renderHistory() {
    clear(historyList);
    const list = store.state.sessions.filter((s) => !kindFilter || s.kind === kindFilter);
    historyPanel.setTitle(`Session history (${list.length})`);

    if (!list.length) {
      historyList.append(emptyState({
        icon: kindFilter ? 'filter' : 'history',
        title: kindFilter ? `No ${KIND_LABELS[kindFilter].toLowerCase()} sessions` : 'No sessions recorded',
        body: kindFilter ? 'Another kind of session may be recorded — clear the filter to see everything.' : 'Analyse or preview a chart and it will appear here.',
        actions: kindFilter ? [button({ label: 'Clear filter', icon: 'refresh', size: 'sm', onClick: () => { kindFilter = null; kindFilterControl.setLabel('All kinds'); renderHistory(); } })] : [],
      }));
      return;
    }

    for (const session of list) {
      const selected = session.id === selectedId;
      const row = h('button.list__row', { type: 'button', role: 'option', 'aria-selected': selected ? 'true' : 'false' });
      const title = session.chart
        ? `${session.chart.artist || ''} — ${session.chart.title || ''}`.trim()
        : 'No chart';
      const detail = [
        KIND_LABELS[session.kind] || session.kind,
        session.durationMs ? formatElapsed(session.durationMs) : null,
        session.analysis?.objectCount ? `${formatCount(session.analysis.objectCount)} notes` : null,
        session.playback?.rate ? formatRate(session.playback.rate) : null,
        session.simulation?.unstableRate != null ? `UR ${(+session.simulation.unstableRate).toFixed(1)}` : null,
        session.input?.executedEvents != null ? `${formatCount(session.input.executedEvents)} keys` : null,
        session.errors?.length ? `${session.errors.length} error${session.errors.length === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ');

      const statusVariant = session.status === SessionStatus.ERROR ? 'danger'
        : session.status === SessionStatus.ABORTED ? 'warn' : null;

      row.append(
        h('div.grow', { style: { minWidth: 0 } },
          h('div.truncate', { style: { fontWeight: '500' } }, title || 'No chart'),
          h('div.xs.muted.truncate', detail),
        ),
        statusVariant ? badge({ label: STATUS_LABELS[session.status] || session.status, variant: statusVariant }) : null,
        h('span.xs.faint.shrink-0', formatRelative(session.startedAt)),
      );
      row.addEventListener('click', () => { selectedId = session.id; renderHistory(); renderDetail(store.state.sessions); });
      historyList.append(row);
    }
  }

  function renderDetail(list) {
    clear(detailBody);
    const session = list.find((s) => s.id === selectedId) || null;
    if (!session) {
      detailBody.append(emptyState({
        icon: 'info', title: 'No session selected',
        body: 'Choose a session from the history to see exactly what it measured, and what it did not.',
      }));
      return;
    }

    detailBody.append(h('div.stack', { style: { gap: '2px' } },
      h('div.strong', session.chart ? `${session.chart.artist} — ${session.chart.title}` : 'No chart'),
      h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } },
        badge({ label: KIND_LABELS[session.kind] || session.kind, variant: 'accent' }),
        badge({ label: STATUS_LABELS[session.status] || session.status, variant: session.status === SessionStatus.ERROR ? 'danger' : session.status === SessionStatus.ABORTED ? 'warn' : 'ok' }),
        session.chart?.keys ? badge({ label: `${session.chart.keys}K` }) : null,
        session.seed != null ? badge({ label: `seed ${session.seed}`, tooltip: 'Reproducible: the same seed and profile give the same run' }) : null,
      ),
    ));

    const rows = [
      { key: 'started', label: 'Started', value: formatDateTime(session.startedAt) },
      { key: 'ended', label: 'Ended', value: session.endedAt ? formatDateTime(session.endedAt) : 'still open' },
      { key: 'duration', label: 'Duration', value: formatElapsed(session.durationMs), mono: true },
    ];
    if (session.chart) {
      rows.push(
        { key: 'diff', label: 'Difficulty', value: session.chart.version || '—' },
        { key: 'source', label: 'Chart source', value: session.chart.source === 'bridge' ? 'read from the game' : 'imported here' },
      );
    }
    if (session.analysis) {
      rows.push(
        { key: 'objects', label: 'Notes parsed', value: formatCount(session.analysis.objectCount), mono: true },
        { key: 'ln', label: 'Holds', value: session.analysis.lnCount != null ? formatCount(session.analysis.lnCount) : '—', mono: true },
        { key: 'bpm', label: 'BPM', value: session.analysis.bpm ? `${Math.round(session.analysis.bpm * 100) / 100}` : '—', mono: true },
        { key: 'peak', label: 'Peak density', value: session.analysis.peakNps != null ? `${(+session.analysis.peakNps).toFixed(2)} n/s` : '—', mono: true },
        { key: 'imported', label: 'Charts imported', value: session.analysis.imported != null ? formatCount(session.analysis.imported) : '—', mono: true },
      );
    }
    if (session.playback) {
      rows.push(
        { key: 'rate', label: 'Playback speed', value: session.playback.rate != null ? formatRate(session.playback.rate) : '—', mono: true },
        { key: 'offset', label: 'Timing offset', value: session.playback.offsetMs != null ? formatMs(session.playback.offsetMs, { digits: 0 }) : '—', mono: true },
        { key: 'scroll', label: 'Scroll speed', value: session.playback.scrollSpeed != null ? `${session.playback.scrollSpeed} (${Math.round(11485 / session.playback.scrollSpeed)} ms)` : '—', mono: true },
        { key: 'seeks', label: 'Seeks', value: session.playback.seekCount != null ? formatCount(session.playback.seekCount) : '—', mono: true },
        { key: 'loops', label: 'Loops', value: session.playback.loopCount != null ? formatCount(session.playback.loopCount) : '—', mono: true },
        { key: 'clock', label: 'Clock source', value: session.playback.clockSource || '—' },
        { key: 'reached', label: 'Reached', value: session.playback.reachedMs != null ? `${formatDuration(session.playback.reachedMs)} of ${formatDuration(session.playback.durationMs || 0)}` : '—', mono: true },
      );
    }
    if (session.simulation) {
      const sim = session.simulation;
      rows.push(
        { key: 'dist', label: 'Distribution', value: sim.distribution?.kind || '—' },
        { key: 'samples', label: 'Samples', value: sim.samples != null ? formatCount(sim.samples) : '—', mono: true },
        { key: 'simmean', label: 'Mean error', value: sim.mean != null ? formatMs(sim.mean) : '—', mono: true },
        { key: 'simdev', label: 'Std deviation', value: sim.stdDev != null ? formatMs(sim.stdDev, { digits: 2, sign: false }) : '—', mono: true },
        { key: 'ur', label: 'Unstable rate', value: sim.unstableRate != null ? (+sim.unstableRate).toFixed(2) : '—', mono: true },
        { key: 'flagged', label: 'Would be flagged', value: sim.wouldBeFlagged == null ? '—' : sim.wouldBeFlagged ? 'yes — below the game’s threshold' : 'no' },
      );
    }
    if (session.input) {
      const input = session.input;
      rows.push(
        { key: 'backend', label: 'Input backend', value: input.backendId === 'os' ? 'operating system' : input.backendId === 'synthetic' ? 'synthetic DOM events' : input.backendId || '—' },
        { key: 'trusted', label: 'Hardware-equivalent', value: input.trusted == null ? '—' : input.trusted ? 'yes (OS-level)' : 'no (isTrusted false)' },
        { key: 'planned', label: 'Events planned', value: input.plannedEvents != null ? formatCount(input.plannedEvents) : '—', mono: true },
        { key: 'executed', label: 'Events executed', value: input.executedEvents != null ? formatCount(input.executedEvents) : '—', mono: true },
        { key: 'skipped', label: 'Notes skipped', value: input.skippedNotes != null ? formatCount(input.skippedNotes) : '—', mono: true },
        { key: 'refused', label: 'Refused', value: input.refused ? 'yes' : 'no' },
      );
      if (input.timing) {
        rows.push({ key: 'drift', label: 'Dispatch drift (mean / p95)', value: `${formatMs(input.timing.meanMs ?? input.timing.mean ?? null, { digits: 2 })} / ${formatMs(input.timing.p95Ms ?? input.timing.p95 ?? null, { digits: 2 })}`, mono: true });
      }
    }

    const dl = definitionList(rows.filter((r) => r.value !== '—' || r.key === 'ended'));
    detailBody.append(dl.root);

    // Marks: how long the session's own steps took, measured rather than assumed.
    if (session.marks?.length >= 2) {
      const markRows = [];
      for (let i = 1; i < session.marks.length; i++) {
        const from = session.marks[i - 1];
        const to = session.marks[i];
        markRows.push(h('div.row.row--between', { style: { padding: '2px 0', borderBottom: '1px solid var(--line-faint)' } },
          h('span.xs.muted', `${from.name} → ${to.name}`),
          h('span.num.xs', `${Math.max(0, to.at - from.at)} ms`),
        ));
      }
      detailBody.append(h('div.stack', { style: { gap: '2px' } }, h('div.label-upper', 'Measured steps'), ...markRows));
    }

    if (session.errors?.length) {
      detailBody.append(h('div.stack', { style: { gap: '4px' } },
        h('div.label-upper', 'Errors recorded'),
        ...session.errors.map((e) => note({ variant: 'warn', icon: 'alert', title: e.code || 'error', text: e.message })),
      ));
    }

    // Comparison against another session of the same chart, when one exists.
    const siblings = list.filter((s) => s.id !== session.id && s.chart?.id === session.chart?.id);
    if (siblings.length) {
      const other = compareWith ? (list.find((s) => s.id === compareWith) || siblings[0]) : siblings[0];
      const rows2 = compare(other, session);
      const meaningful = rows2.filter((r) => r.delta != null && Math.abs(r.delta) > 1e-9);
      const compareBox = h('div.stack', { style: { gap: '4px' } },
        h('div.row.row--between',
          h('div.label-upper', `Compared with ${formatRelative(other.startedAt)}`),
          dropdown({
            label: 'Change', size: 'sm', ariaLabel: 'Choose the session to compare with',
            items: () => siblings.slice(0, 12).map((s) => ({
              label: `${KIND_LABELS[s.kind] || s.kind} · ${formatRelative(s.startedAt)}`,
              checked: s.id === other.id,
              onClick: () => { compareWith = s.id; renderDetail(list); },
            })),
          }).node,
        ),
        meaningful.length
          ? h('div.stack', { style: { gap: '2px' } }, ...meaningful.map((r) => h('div.row.row--between', { style: { padding: '2px 0', borderBottom: '1px solid var(--line-faint)' } },
            h('span.xs.muted', r.label),
            h('span.num.xs', { style: { color: r.delta > 0 ? 'var(--ok)' : 'var(--warn)' } }, `${r.delta > 0 ? '+' : ''}${Math.round(r.delta * 100) / 100}${r.unit ? ` ${r.unit}` : ''}`),
          )))
          : h('div.xs.muted', 'Nothing measurable differs between these two sessions.'),
      );
      detailBody.append(compareBox);
    }

    detailBody.append(h('div.row.row--wrap', { style: { gap: '6px', marginTop: '4px' } },
      button({
        label: 'Export this session', icon: 'download', size: 'sm', variant: 'ghost',
        onClick: () => {
          downloadJson(`maniaflow-session-${session.id}.json`, session);
          Toast.ok('Session exported', 'Export');
        },
      }),
      session.chart?.id ? button({
        label: 'Open this chart', icon: 'practice', size: 'sm', variant: 'ghost',
        onClick: async () => {
          const record = store.state.charts.find((c) => c.id === session.chart.id);
          if (!record) { Toast.warn('That chart is no longer in the library.', 'Not available'); return; }
          await actions.openChart(record);
          navigate('practice');
        },
      }) : null,
      button({
        label: 'Delete session', icon: 'trash', size: 'sm', variant: 'ghost',
        onClick: async () => {
          const yes = await confirm({
            title: 'Delete this session record?',
            body: `${KIND_LABELS[session.kind] || session.kind} from ${formatDateTime(session.startedAt)}. This cannot be undone, and it does not affect the chart itself.`,
            confirmLabel: 'Delete', destructive: true, icon: 'trash',
          });
          if (!yes) return;
          await sessions.remove(session.id);
          selectedId = null;
          compareWith = null;
          await actions.refreshSessions();
          Toast.ok('Session deleted', 'Data');
        },
      }),
    ));
  }

  /* ── charts and errors ────────────────────────────────────────────── */

  function renderPerChart(list) {
    const charts = byChart(list);
    if (!charts.length) return null;
    const body = h('div.stack', { style: { gap: '4px' } });
    for (const entry of charts.slice(0, 8)) {
      body.append(h('div.row.row--between', { style: { padding: '4px 0', borderBottom: '1px solid var(--line-faint)', gap: '8px' } },
        h('div.truncate.grow', h('div.small.truncate', displayName(entry.chart, unicode())),
          h('div.xs.muted', `${entry.sessions} session${entry.sessions === 1 ? '' : 's'} · ${formatElapsed(entry.totalDurationMs)} · last ${formatRelative(entry.lastAt)}`)),
        h('span.badge.shrink-0', entry.kinds.map((k) => KIND_LABELS[k] || k).join(', ')),
      ));
    }
    return panel({ title: 'By chart', icon: 'library', body }).root;
  }

  function renderErrorBreakdown(list) {
    const errors = errorBreakdown(list);
    if (!errors.length) return null;
    const body = h('div.stack', { style: { gap: '4px' } });
    for (const entry of errors) {
      body.append(h('div.row', { style: { gap: '8px' } },
        h('span.badge.badge--danger.shrink-0', formatCount(entry.count)),
        h('div.grow', { style: { minWidth: 0 } },
          h('div.small.truncate', h('code.inline', entry.code)),
          h('div.xs.muted.truncate', entry.sample || ''),
        ),
      ));
    }
    return panel({ title: 'Failures', icon: 'bug', body }).root;
  }

  /* ── data actions ─────────────────────────────────────────────────── */

  async function exportAll() {
    const data = await actions.exportSessions();
    if (!data) return;
    if (!data.count) Toast.info('There is nothing recorded to export yet.', 'Export');
  }

  async function clearAll() {
    const count = store.state.sessions.length;
    if (!count) { Toast.info('There is no recorded history to clear.', 'Data'); return; }
    const yes = await confirm({
      title: 'Delete all recorded history?',
      body: `This removes ${formatCount(count)} session record${count === 1 ? '' : 's'} from this browser, including their measurements and error logs. `
        + 'Charts, preferences and anything stored inside Ashtonk!mania are not touched. This cannot be undone.',
      confirmLabel: 'Delete everything', destructive: true, icon: 'trash',
    });
    if (!yes) return;
    try {
      await sessions.clear();
      selectedId = null;
      compareWith = null;
      await actions.refreshSessions();
      Toast.ok(`Deleted ${formatCount(count)} sessions`, 'History cleared');
    } catch (err) {
      Toast.error(describeError(err), 'Could not clear history');
    }
  }

  /* ── wiring ───────────────────────────────────────────────────────── */

  scope.defer(store.subscribe((s) => s.sessions, renderAll));
  scope.defer(store.subscribe((s) => s.sessionHealth, () => renderAll(), { immediate: false }));

  // The per-chart and failure panels are appended once, after the main layout, so they do
  // not reflow the page on every session change.
  const extraColumn = h('div.stack');
  root.querySelector('.grid--split').lastElementChild.append(extraColumn);
  function renderExtras() {
    const list = store.state.sessions;
    clear(extraColumn);
    const chartPanel = renderPerChart(list);
    const errorPanel = renderErrorBreakdown(list);
    if (chartPanel) extraColumn.append(chartPanel);
    if (errorPanel) extraColumn.append(errorPanel);
  }
  scope.defer(store.subscribe((s) => s.sessions, renderExtras, { immediate: true }));

  renderAll();

  return {
    root,
    onParams(params) {
      const id = params?.get?.('session');
      if (id) { selectedId = id; renderHistory(); renderDetail(store.state.sessions); }
    },
    dispose: () => scope.dispose(),
  };
}

export { KIND_LABELS, STATUS_LABELS };
