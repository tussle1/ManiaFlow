/**
 * Timing Lab — what a chart actually asks of a player, and what a timing profile does.
 *
 * Two halves, kept visually separate because they are different kinds of claim:
 *
 *   Analysis    measurements of the chart: intervals, BPM changes, chords, holds, scroll
 *               velocity. Every number here is derived from the parsed notes and is
 *               reproducible from the file.
 *   Simulation  a seeded experiment over a configurable distribution. It answers "what
 *               would this timing profile produce", never "this is what a human does".
 *               The results are labelled as a simulation everywhere they appear, including
 *               the one figure that matters most for honesty: whether a profile would fall
 *               under Ashtonk!mania's own bot threshold.
 *
 * Nothing here sends input anywhere. Running an experiment is arithmetic and a canvas.
 */

import { h, setText, clear, Scope } from '../utils/dom.js';
import { panel, stat, emptyState, note, badge, tabs, sparkline, simulationBanner, cssVar } from '../components/primitives.js';
import { button } from '../components/Button.js';
import { slider, selectInput, textInput } from '../components/controls.js';
import { Toast } from '../components/Toast.js';
import { noteIntervals, simultaneousGroups, countJacks, peakNotesPerSecond } from '../chart/ChartMetadata.js';
import { redTimingPoints, scrollSegments } from '../chart/ChartParser.js';
import { TimingEngine } from '../playback/TimingEngine.js';
import { simulateTimingErrors, histogram, buildInputSchedule, BOT_UNSTABLE_RATE, BOT_MIN_NOTES, MIN_HOLD_MS } from '../playback/Simulation.js';
import { validateDistribution } from '../utils/validation.js';
import { defaultKeyMap, displayName } from '../chart/ChartRecord.js';
import { formatDuration, formatMs, formatCount, formatPercent, keyLabel, formatRelative } from '../utils/formatters.js';
import { compare as compareSessions } from '../analytics/StatisticsEngine.js';

const TABS = [
  { id: 'analysis', label: 'Chart timing' },
  { id: 'simulation', label: 'Timing simulation' },
  { id: 'compare', label: 'Session comparison' },
];

export function createTimingLabPage(context) {
  const { store, prefs, actions, recorder, navigate } = context;
  const scope = new Scope();
  const unicode = () => !!prefs.get('appearance.unicodeMetadata');

  let record = null;
  let timing = null;

  /* ── header ───────────────────────────────────────────────────────── */

  const chartLine = h('div.small.muted');
  const header = h('div.page__head-row',
    h('div.page__head',
      h('h1.page__title', 'Timing Lab'),
      h('p.page__subtitle', 'Measure a chart’s timing, and study what a configurable timing profile would produce. '
        + 'Simulations are seeded, bounded and labelled — nothing here is sent to the game.'),
    ),
    h('div.page__actions',
      button({ label: 'Practice Studio', icon: 'practice', size: 'sm', variant: 'ghost', onClick: () => navigate('practice') }),
    ),
  );

  const tabBar = tabs({ id: 'timing', tabs: TABS, active: 'analysis', label: 'Timing Lab sections', onChange: (id) => showTab(id) });
  const panels = { analysis: null, simulation: null, compare: null };
  const bodies = {};

  /* ── analysis tab ─────────────────────────────────────────────────── */

  const intervalStats = {
    shortest: stat({ label: 'Shortest interval', value: '—', tooltip: 'The smallest gap between two distinct note instants' }),
    median: stat({ label: 'Median interval', value: '—' }),
    mean: stat({ label: 'Mean interval', value: '—' }),
    longest: stat({ label: 'Longest interval', value: '—', tooltip: 'Usually a break or the gap before the first note' }),
  };
  const chordStats = {
    groups: stat({ label: 'Note instants', value: '—' }),
    chords: stat({ label: 'Simultaneous', value: '—', tooltip: 'Instants with more than one note' }),
    widest: stat({ label: 'Widest chord', value: '—' }),
    ratio: stat({ label: 'Chord ratio', value: '—' }),
  };
  const holdStats = {
    holds: stat({ label: 'Holds', value: '—' }),
    total: stat({ label: 'Total hold time', value: '—' }),
    longest: stat({ label: 'Longest hold', value: '—' }),
    ratio: stat({ label: 'Hold ratio', value: '—' }),
  };
  const timingStats = {
    bpm: stat({ label: 'Dominant BPM', value: '—' }),
    changes: stat({ label: 'Timing changes', value: '—' }),
    sv: stat({ label: 'SV changes', value: '—' }),
    peak: stat({ label: 'Peak density', value: '—', tooltip: 'Notes per second in the busiest window' }),
  };

  const intervalCanvas = h('canvas', { style: { width: '100%', height: '120px', display: 'block' } });
  const svCanvas = h('canvas', { style: { width: '100%', height: '110px', display: 'block' } });
  const snapCanvas = h('canvas', { style: { width: '100%', height: '96px', display: 'block' } });

  const bpmTable = h('div.scroll-y', { style: { maxHeight: '240px' } });
  const chordTable = h('div.scroll-y', { style: { maxHeight: '240px' } });
  const holdTable = h('div.scroll-y', { style: { maxHeight: '240px' } });

  const jackWindow = slider({
    label: 'Jack window', min: 40, max: 600, step: 10,
    value: prefs.get('timing.jackWindowMs'), format: (v) => `${Math.round(v)} ms`,
    hint: 'How close two notes in the same lane must be to count as a jack.',
    onInput: (v) => { prefs.set('timing.jackWindowMs', v); renderJacks(); },
  });
  const densityWindow = slider({
    label: 'Peak density window', min: 250, max: 4000, step: 250,
    value: prefs.get('timing.densityWindowMs'), format: (v) => `${Math.round(v)} ms`,
    onInput: (v) => { prefs.set('timing.densityWindowMs', v); renderPeak(); },
  });
  const chordTolerance = slider({
    label: 'Simultaneous-note tolerance', min: 0, max: 10, step: 1,
    value: prefs.get('timing.chordToleranceMs'), format: (v) => `${Math.round(v)} ms`,
    hint: '0 ms matches Ashtonk!mania exactly: only notes at the same instant are a chord.',
    onInput: (v) => { prefs.set('timing.chordToleranceMs', v); renderChords(); },
  });

  const jackStats = {
    count: stat({ label: 'Jacks', value: '—' }),
    streak: stat({ label: 'Longest streak', value: '—' }),
    perLane: stat({ label: 'Busiest lane', value: '—' }),
  };

  panels.analysis = h('div.stack',
    note({
      variant: 'accent', icon: 'timing',
      text: 'Every figure below is computed from the parsed notes. A chart that has not been loaded yet shows no numbers — ManiaFlow does not estimate them.',
    }),
    h('div.grid.grid--4', ...Object.values(timingStats).map((s) => s.root)),
    panel({
      title: 'Note intervals', icon: 'wave',
      subtitle: 'gaps between distinct note instants',
      body: h('div.stack',
        h('div.grid.grid--4', ...Object.values(intervalStats).map((s) => s.root)),
        intervalCanvas,
        h('div.xs.muted', 'Each bar is one gap between consecutive note instants, in the order they occur. Tall bars are breaks or sparse sections.'),
      ),
    }).root,
    h('div.grid.grid--2',
      panel({ title: 'Jacks', icon: 'bolt', body: h('div.stack', h('div.grid.grid--3', ...Object.values(jackStats).map((s) => s.root)), jackWindow.root) }).root,
      panel({ title: 'Density', icon: 'gauge', body: h('div.stack', densityWindow.root) }).root,
    ),
    panel({
      title: 'Simultaneous notes', icon: 'layers',
      body: h('div.stack',
        chordTolerance.root,
        h('div.grid.grid--4', ...Object.values(chordStats).map((s) => s.root)),
        chordTable,
      ),
    }).root,
    panel({
      title: 'Hold notes', icon: 'note',
      body: h('div.stack',
        h('div.grid.grid--4', ...Object.values(holdStats).map((s) => s.root)),
        holdTable,
      ),
    }).root,
    panel({
      title: 'Timing and scroll velocity', icon: 'sliders',
      subtitle: 'as Ashtonk!mania scrolls them',
      body: h('div.stack',
        svCanvas,
        h('div.xs.muted', 'Velocity against chart time. A step is a red (BPM) or green (SV) timing point.'),
        bpmTable,
      ),
    }).root,
    panel({
      title: 'Beat snap', icon: 'target',
      subtitle: 'osu! timing colours',
      body: h('div.stack',
        snapCanvas,
        h('div.xs.muted', 'Each note coloured by the finest divisor it sits on, within 2 ms: 1/1 white, 1/2 red, 1/4 blue, 1/3 purple, 1/8 yellow, 1/6 and 1/12 orange, 1/16 dark purple. Grey means it sits on none of them.'),
      ),
    }).root,
  );

  /* ── simulation tab ───────────────────────────────────────────────── */

  const distributionSelect = selectInput({
    label: 'Distribution', value: prefs.get('simulation.distribution'),
    options: [
      { id: 'none', label: 'None (perfect timing)' },
      { id: 'gaussian', label: 'Gaussian (σ-bounded)' },
      { id: 'uniform', label: 'Uniform (±range)' },
      { id: 'bimodal', label: 'Bimodal (early/late split)' },
    ],
    onChange: (v) => { prefs.set('simulation.distribution', v); runExperiment(); },
  });

  const sigmaSlider = slider({
    label: 'Sigma σ', min: 0, max: 200, step: 1, value: prefs.get('simulation.sigmaMs'),
    format: (v) => `${Math.round(v)} ms`,
    hint: 'Gaussian and bimodal spread. Truncated at three sigma so a sample can never move a note past its neighbour.',
    onChange: (v) => { prefs.set('simulation.sigmaMs', v); runExperiment(); },
  });
  const rangeSlider = slider({
    label: 'Uniform range', min: 0, max: 200, step: 1, value: prefs.get('simulation.rangeMs'),
    format: (v) => `± ${Math.round(v)} ms`,
    onChange: (v) => { prefs.set('simulation.rangeMs', v); runExperiment(); },
  });
  const biasSlider = slider({
    label: 'Bias', min: -200, max: 200, step: 1, value: prefs.get('simulation.biasMs'),
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} ms`,
    hint: 'Shifts the whole distribution early (negative) or late (positive).',
    onChange: (v) => { prefs.set('simulation.biasMs', v); runExperiment(); },
  });
  const splitSlider = slider({
    label: 'Early / late split', min: 0, max: 1, step: 0.05, value: prefs.get('simulation.splitRatio'),
    format: (v) => `${Math.round(v * 100)}% early`,
    onChange: (v) => { prefs.set('simulation.splitRatio', v); runExperiment(); },
  });
  const seedInput = textInput({
    label: 'Seed', value: String(prefs.get('simulation.seed')), mono: true,
    hint: 'The same seed and profile always produce the same run, so two experiments can be compared.',
    onChange: (v) => {
      const parsed = Number.parseInt(v, 10);
      if (Number.isFinite(parsed) && parsed > 0) { prefs.set('simulation.seed', parsed); runExperiment(); }
    },
  });
  const sampleCount = slider({
    label: 'Notes to simulate', min: 50, max: 5000, step: 50, value: 1000,
    format: (v) => formatCount(v),
    onChange: () => runExperiment(),
  });

  const simStats = {
    mean: stat({ label: 'Mean error', value: '—' }),
    sigma: stat({ label: 'Std deviation', value: '—' }),
    ur: stat({ label: 'Unstable rate', value: '—', accent: true, tooltip: 'Ten times the standard deviation of hit errors, as osu! computes it' }),
    p95: stat({ label: '95th percentile', value: '—' }),
  };
  const verdictNote = h('div');
  const distCanvas = h('canvas', { style: { width: '100%', height: '130px', display: 'block' } });
  const errorSpark = sparkline({ height: 60, label: 'Simulated hit error across the run' });

  const scheduleStats = {
    events: stat({ label: 'Key events', value: '—' }),
    scheduled: stat({ label: 'Notes scheduled', value: '—' }),
    skipped: stat({ label: 'Notes skipped', value: '—', tooltip: 'No key bound, or a press that would overlap the previous release in the same lane' }),
    duration: stat({ label: 'Schedule length', value: '—' }),
  };
  const scheduleWarnings = h('div.stack', { style: { gap: '4px' } });
  const schedulePreview = h('div.code', { style: { maxHeight: '160px' } });

  const runButton = button({ label: 'Run experiment', icon: 'play', variant: 'primary', onClick: () => runExperiment({ record: true }) });
  const randomSeedButton = button({ label: 'New seed', icon: 'refresh', size: 'sm', variant: 'ghost', tooltip: 'Pick a different seed and re-run', onClick: () => {
    const next = 1 + Math.floor(Math.random() * 2147483646);
    prefs.set('simulation.seed', next);
    seedInput.setValue(String(next));
    runExperiment();
  } });

  panels.simulation = h('div.stack',
    simulationBanner('Everything on this tab is arithmetic over a seeded random number generator. No input is sent to Ashtonk!mania and no timing profile is claimed to be human.'),
    panel({
      title: 'Timing profile', icon: 'sliders',
      body: h('div.stack',
        h('div.grid.grid--2', distributionSelect.root, seedInput.root),
        h('div.grid.grid--2', sigmaSlider.root, rangeSlider.root),
        h('div.grid.grid--2', biasSlider.root, splitSlider.root),
        sampleCount.root,
        h('div.row', runButton, randomSeedButton, h('div.grow'), h('span.xs.muted', 'Seed and profile are stored with every run')),
      ),
    }).root,
    panel({
      title: 'Result', icon: 'statistics',
      body: h('div.stack',
        h('div.grid.grid--4', ...Object.values(simStats).map((s) => s.root)),
        verdictNote,
        distCanvas,
        h('div.xs.muted', 'Distribution of simulated hit errors in milliseconds. The centre line is a perfect hit.'),
        errorSpark.root,
      ),
    }).root,
    panel({
      title: 'Resulting key schedule', icon: 'keyboard',
      subtitle: 'what an input run would send',
      body: h('div.stack',
        h('div.grid.grid--4', ...Object.values(scheduleStats).map((s) => s.root)),
        scheduleWarnings,
        schedulePreview,
        note({
          icon: 'shield',
          text: `A press and release closer than ${MIN_HOLD_MS} ms is what Ashtonk!mania’s own verifier rejects as impossible input, so no schedule ManiaFlow builds can contain one. `
        + `An unstable rate below ${BOT_UNSTABLE_RATE} over ${BOT_MIN_NOTES}+ notes is what it rejects as inhuman timing — that check is the reason this tool refuses to arm outside practice mode.`,
        }),
      ),
    }).root,
  );

  /* ── compare tab ──────────────────────────────────────────────────── */

  const compareBody = h('div.stack');
  panels.compare = h('div.stack',
    panel({ title: 'Session comparison', icon: 'history', body: compareBody }).root,
  );

  /* ── layout ───────────────────────────────────────────────────────── */

  const tabPanels = h('div.stack');
  for (const tab of TABS) {
    const wrapper = h('div.stack', { id: `timing-panel-${tab.id}`, role: 'tabpanel', 'aria-labelledby': `timing-${tab.id}` });
    wrapper.append(panels[tab.id]);
    bodies[tab.id] = wrapper;
    tabPanels.append(wrapper);
  }

  const root = h('div', header, h('div.small.dim', chartLine), tabBar.root, tabPanels);

  function showTab(id) {
    for (const tab of TABS) {
      bodies[tab.id].style.display = tab.id === id ? '' : 'none';
      bodies[tab.id].hidden = tab.id !== id;
    }
    if (id === 'simulation') runExperiment();
    if (id === 'compare') renderCompare();
  }
  showTab('analysis');

  /* ── rendering ────────────────────────────────────────────────────── */

  function loadChart(next) {
    record = next;
    if (!record?.chart || !record.notes?.length) {
      timing = null;
      setText(chartLine, 'No chart is loaded. Choose one from the library, or drop an .osu or .osz file into this window.');
      showNoChart();
      return;
    }
    setText(chartLine, `${displayName(record, unicode())} [${record.version}] · ${record.keys}K · ${formatCount(record.notes.length)} objects · ${record.source === 'bridge' ? 'read from the game' : 'imported here'}`);
    timing = new TimingEngine({
      segments: scrollSegments(record.chart, {}),
      red: redTimingPoints(record.chart),
      rate: 1,
      scrollSpeed: prefs.get('practice.scrollSpeed'),
    });
    renderAnalysis();
    runExperiment();
  }

  function showNoChart() {
    for (const tab of TABS) {
      clear(bodies[tab.id]);
      bodies[tab.id].append(emptyState({
        icon: 'timing',
        title: 'No chart to analyse',
        body: tab === 'compare'
          ? 'Session comparison needs recorded sessions, which need charts to have been analysed first.'
          : 'Load a chart and the timing analysis will run on it. Nothing is estimated in the meantime.',
        actions: [
          button({ label: 'Chart library', icon: 'library', size: 'sm', variant: 'primary', onClick: () => navigate('library') }),
          button({ label: 'Read from the game', icon: 'plug', size: 'sm', onClick: () => actions.refreshLibrary() }),
        ],
      }));
    }
  }

  function restorePanels() {
    for (const tab of TABS) {
      clear(bodies[tab.id]);
      bodies[tab.id].append(panels[tab.id]);
    }
    showTab(TABS.find((t) => !bodies[t.id].hidden)?.id || 'analysis');
  }

  function renderAnalysis() {
    restorePanels();
    const notes = record.notes;
    const analysis = record.analysis;

    timingStats.bpm.setValue(analysis.bpm ? `${Math.round(analysis.bpm * 100) / 100}` : '—');
    timingStats.changes.setValue(formatCount(analysis.timingChangeCount));
    timingStats.sv.setValue(formatCount(analysis.svChangeCount));
    renderPeak();

    const intervals = noteIntervals(notes);
    intervalStats.shortest.setValue(intervals.min != null ? formatMs(intervals.min, { digits: 1, sign: false }) : '—');
    intervalStats.median.setValue(intervals.median != null ? formatMs(intervals.median, { digits: 1, sign: false }) : '—');
    intervalStats.mean.setValue(intervals.mean != null ? formatMs(intervals.mean, { digits: 1, sign: false }) : '—');
    intervalStats.longest.setValue(intervals.max != null ? formatMs(intervals.max, { digits: 1, sign: false }) : '—');
    drawIntervals(intervals.values);

    renderChords();
    renderHolds();
    renderJacks();
    renderTimingTables();
    drawSvStrip();
    drawSnapStrip();
  }

  function renderPeak() {
    if (!record) return;
    const windowMs = prefs.get('timing.densityWindowMs');
    const peak = peakNotesPerSecond(record.notes, windowMs);
    timingStats.peak.setValue(`${peak.toFixed(2)} n/s`);
    timingStats.peak.setHint(`busiest ${formatDuration(windowMs)} window`);
  }

  function renderChords() {
    if (!record) return;
    const tolerance = prefs.get('timing.chordToleranceMs');
    const groups = simultaneousGroups(record.notes, tolerance);
    const chords = groups.filter((g) => g.length > 1);
    const widest = chords.length ? Math.max(...chords.map((g) => g.length)) : 0;

    chordStats.groups.setValue(formatCount(groups.length));
    chordStats.chords.setValue(formatCount(chords.length));
    chordStats.widest.setValue(widest ? `${widest} notes` : '—');
    chordStats.ratio.setValue(groups.length ? formatPercent(chords.length / groups.length, 1) : '—');

    clear(chordTable);
    if (!chords.length) {
      chordTable.append(h('div.small.muted', `No two notes start within ${tolerance} ms of each other in this chart.`));
      return;
    }
    const byWidth = new Map();
    for (const chord of chords) byWidth.set(chord.length, (byWidth.get(chord.length) || 0) + 1);
    const table = h('table.table.table--compact');
    table.append(h('thead', h('tr',
      h('th', 'Width'), h('th', 'Count'), h('th', 'Share of instants'), h('th', 'First at'),
    )));
    const body = h('tbody');
    const total = groups.length || 1;
    for (const width of [...byWidth.keys()].sort((a, b) => b - a)) {
      const count = byWidth.get(width);
      const first = chords.find((c) => c.length === width);
      body.append(h('tr',
        h('td.num', `${width} notes`),
        h('td.num', formatCount(count)),
        h('td.num', formatPercent(count / total, 1)),
        h('td.num', formatDuration(first[0].time, { tenths: true })),
      ));
    }
    table.append(body);
    chordTable.append(table);
  }

  function renderHolds() {
    if (!record) return;
    const holds = record.notes.filter((n) => n.isLN).map((n) => ({ ...n, duration: n.end - n.time }));
    holdStats.holds.setValue(formatCount(holds.length));
    holdStats.total.setValue(holds.length ? formatDuration(holds.reduce((a, b) => a + b.duration, 0)) : '—');
    holdStats.longest.setValue(holds.length ? formatDuration(Math.max(...holds.map((x) => x.duration))) : '—');
    holdStats.ratio.setValue(record.notes.length ? formatPercent(holds.length / record.notes.length, 1) : '—');

    clear(holdTable);
    if (!holds.length) {
      holdTable.append(h('div.small.muted', 'This chart has no hold notes.'));
      return;
    }
    const perLane = new Array(record.keys).fill(0);
    const laneTime = new Array(record.keys).fill(0);
    for (const hold of holds) { perLane[hold.col]++; laneTime[hold.col] += hold.duration; }

    const table = h('table.table.table--compact');
    table.append(h('thead', h('tr', h('th', 'Lane'), h('th', 'Key'), h('th', 'Holds'), h('th', 'Share'), h('th', 'Total held'), h('th', 'Longest'))));
    const body = h('tbody');
    const keyMap = defaultKeyMap(record.keys);
    for (let lane = 0; lane < record.keys; lane++) {
      const longest = holds.filter((x) => x.col === lane).reduce((max, x) => Math.max(max, x.duration), 0);
      body.append(h('tr',
        h('td.num', `${lane + 1}`),
        h('td', h('span.kbd', keyLabel(keyMap[lane]?.[0] || ''))),
        h('td.num', formatCount(perLane[lane])),
        h('td.num', holds.length ? formatPercent(perLane[lane] / holds.length, 1) : '—'),
        h('td.num', formatDuration(laneTime[lane])),
        h('td.num', longest ? formatDuration(longest) : '—'),
      ));
    }
    table.append(body);
    holdTable.append(table);
  }

  function renderJacks() {
    if (!record) return;
    const windowMs = prefs.get('timing.jackWindowMs');
    const jacks = countJacks(record.notes, windowMs);
    jackStats.count.setValue(formatCount(jacks.count));
    jackStats.streak.setValue(jacks.maxStreak ? `${jacks.maxStreak} in a row` : '—');

    const perLane = new Array(record.keys).fill(0);
    const byLane = new Map();
    for (const note of record.notes) {
      if (!byLane.has(note.col)) byLane.set(note.col, []);
      byLane.get(note.col).push(note.time);
    }
    for (const [lane, times] of byLane) {
      const sorted = [...times].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1];
        if (gap > 0 && gap <= windowMs) perLane[lane]++;
      }
    }
    const busiest = perLane.indexOf(Math.max(...perLane));
    jackStats.perLane.setValue(Math.max(...perLane) > 0 ? `Lane ${busiest + 1} (${perLane[busiest]})` : '—');
  }

  function renderTimingTables() {
    if (!record || !timing) return;
    const endTime = Math.max(...record.notes.map((n) => n.end));
    const changes = timing.bpmChanges(endTime);

    clear(bpmTable);
    const table = h('table.table.table--compact');
    table.append(h('thead', h('tr', h('th', 'At'), h('th', 'BPM'), h('th', 'Beat length'), h('th', 'Meter'), h('th', 'Covers'))));
    const body = h('tbody');
    for (const change of changes) {
      body.append(h('tr',
        h('td.num', formatDuration(change.time, { tenths: true })),
        h('td.num', change.bpm ? `${Math.round(change.bpm * 100) / 100}` : '—'),
        h('td.num', `${Math.round(change.beatLength * 100) / 100} ms`),
        h('td.num', `${change.meter}/4`),
        h('td.num', formatDuration(Math.max(0, change.until - change.time))),
      ));
    }
    table.append(body);
    bpmTable.append(table);
    bpmTable.append(h('div.xs.muted', { style: { marginTop: '6px' } },
      `${changes.length} uninherited (red) timing point${changes.length === 1 ? '' : 's'}. `
      + `The dominant BPM is the beat length covering the longest span between the first and last note, which is what Ashtonk!mania reports.`));
  }

  /* ── canvases ─────────────────────────────────────────────────────── */

  function setupCanvas(canvas) {
    const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, canvas.clientWidth || 600);
    const height = Math.max(1, canvas.clientHeight || 100);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function drawIntervals(values) {
    const surface = setupCanvas(intervalCanvas);
    if (!surface) return;
    const { ctx, width, height } = surface;
    if (!values?.length) {
      ctx.fillStyle = cssVar('--fg-faint');
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('Not enough notes to measure intervals', 8, height / 2);
      return;
    }
    // Log scale: a chart mixes 30ms streams with 8-second breaks, and a linear scale turns
    // the streams into an unreadable solid block.
    const max = Math.max(...values, 1);
    const min = Math.max(1, Math.min(...values));
    const barWidth = Math.max(1, width / values.length);
    const logRange = Math.log10(max / min) || 1;
    ctx.fillStyle = cssVar('--accent');
    for (let i = 0; i < values.length; i++) {
      const value = Math.max(min, values[i]);
      const ratio = (Math.log10(value / min) / logRange);
      const barHeight = Math.max(1, ratio * (height - 14));
      ctx.globalAlpha = 0.35 + 0.65 * ratio;
      ctx.fillRect(i * barWidth, height - barHeight - 10, Math.max(1, barWidth - (barWidth > 2 ? 1 : 0)), barHeight);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar('--fg-faint');
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${Math.round(min)} ms`, 4, height - 1);
    const maxLabel = `${Math.round(max)} ms`;
    ctx.fillText(maxLabel, width - ctx.measureText(maxLabel).width - 4, height - 1);
  }

  function drawSvStrip() {
    const surface = setupCanvas(svCanvas);
    if (!surface || !record) return;
    const { ctx, width, height } = surface;
    const segments = scrollSegments(record.chart, {});
    const endTime = Math.max(...record.notes.map((n) => n.end), 1);
    const relevant = segments.filter((s) => s.time >= -1 && s.time <= endTime);
    const pad = 14;
    const plotH = height - pad;

    ctx.strokeStyle = cssVar('--line-soft');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(plotH) + 0.5);
    ctx.lineTo(width, Math.round(plotH) + 0.5);
    ctx.stroke();

    if (!relevant.length) return;
    const maxVel = Math.max(1.5, ...relevant.map((s) => s.vel));
    const x = (t) => (Math.max(0, t) / endTime) * width;
    const y = (v) => plotH - (Math.min(v, maxVel) / maxVel) * (plotH - 6);

    ctx.beginPath();
    ctx.moveTo(x(relevant[0].time), y(relevant[0].vel));
    for (let i = 0; i < relevant.length; i++) {
      const current = relevant[i];
      const next = relevant[i + 1];
      ctx.lineTo(x(current.time), y(current.vel));
      if (next) ctx.lineTo(x(next.time), y(current.vel));   // a step, not a slope: SV jumps
    }
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // A 1× reference line, so "faster than the BPM" is visible without reading numbers.
    ctx.strokeStyle = cssVar('--line-solid');
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(1));
    ctx.lineTo(width, y(1));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cssVar('--fg-faint');
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('1×', 4, y(1) - 3);
    ctx.fillText(`${maxVel.toFixed(1)}×`, 4, 10);
  }

  function drawSnapStrip() {
    const surface = setupCanvas(snapCanvas);
    if (!surface || !record || !timing) return;
    const { ctx, width, height } = surface;
    const endTime = Math.max(...record.notes.map((n) => n.end), 1);
    const counts = new Map();
    const barWidth = Math.max(1, width / endTime * 40);
    for (const note of record.notes) {
      const snap = timing.beatSnap(note.time);
      const key = snap.divisor || 0;
      const bucket = Math.min(width - 1, Math.floor((note.time / endTime) * width));
      const cell = `${key}:${bucket}`;
      counts.set(cell, (counts.get(cell) || 0) + 1);
    }
    const maxCount = Math.max(1, ...counts.values());
    for (const [cell, count] of counts) {
      const [key, bucket] = cell.split(':').map(Number);
      // divisor 0 means the note sits on none of 1/1…1/16, which osu! draws grey.
      ctx.fillStyle = (key === 0 ? null : snapColourFor(key)) || cssVar('--fg-faint');
      ctx.globalAlpha = 0.3 + 0.7 * (count / maxCount);
      const barHeight = Math.max(2, (count / maxCount) * (height - 16));
      ctx.fillRect(bucket, height - 12 - barHeight, Math.max(1, barWidth - 0.5), barHeight);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar('--fg-faint');
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('0:00', 2, height - 2);
    const endLabel = formatDuration(endTime);
    ctx.fillText(endLabel, width - ctx.measureText(endLabel).width - 2, height - 2);
  }

  const SNAP_COLOURS = { 1: '#ffffff', 2: '#ed1121', 4: '#66ccff', 3: '#aa88ff', 8: '#ffcc22', 6: '#ff9a3c', 12: '#cc6600', 16: '#6644cc' };
  function snapColourFor(divisor) { return SNAP_COLOURS[divisor] || null; }

  /* ── simulation ───────────────────────────────────────────────────── */

  let lastExperiment = null;

  function currentDistribution() {
    return validateDistribution({
      kind: prefs.get('simulation.distribution'),
      sigmaMs: prefs.get('simulation.sigmaMs'),
      rangeMs: prefs.get('simulation.rangeMs'),
      biasMs: prefs.get('simulation.biasMs'),
      splitRatio: prefs.get('simulation.splitRatio'),
      seed: prefs.get('simulation.seed'),
    });
  }

  function runExperiment(options = {}) {
    if (!record?.notes?.length) return null;
    const distribution = currentDistribution();
    const seed = prefs.get('simulation.seed');
    const count = Math.max(1, Math.min(record.notes.length, sampleCount.value));

    const result = simulateTimingErrors({ count, distribution, seed });
    lastExperiment = { ...result, count, seed, distribution };

    simStats.mean.setValue(formatMs(result.mean));
    simStats.sigma.setValue(formatMs(result.stdDev, { digits: 2, sign: false }));
    simStats.ur.setValue(result.unstableRate.toFixed(2));
    simStats.p95.setValue(formatMs(result.p95));

    clear(verdictNote);
    verdictNote.append(note({
      variant: result.wouldBeFlagged ? 'warn' : 'accent',
      icon: result.wouldBeFlagged ? 'shield' : 'info',
      title: result.wouldBeFlagged
        ? 'This profile would be rejected as inhuman timing'
        : 'This profile sits above the game’s bot threshold',
      text: result.distribution.kind === 'none'
        ? `A perfect-timing run has an unstable rate of 0. Ashtonk!mania’s verifier rejects an unstable rate below ${BOT_UNSTABLE_RATE} over ${BOT_MIN_NOTES} or more judged notes, and a scored play is re-judged server-side from the beatmap and the recorded key events. `
          + 'That is the anti-cheat working as designed, and it is why ManiaFlow refuses to arm input outside the game’s own practice mode.'
        : `Simulated unstable rate ${result.unstableRate.toFixed(2)} against a threshold of ${BOT_UNSTABLE_RATE}. `
          + 'This is a property of the distribution you configured, not a claim that it resembles a person or that it would evade anything.',
    }));

    drawHistogram(result.errors, distribution);
    // A symmetric window centred on zero, so "early" and "late" are equally readable.
    const bound = Math.max(20, Math.abs(result.min), Math.abs(result.max));
    errorSpark.draw(result.errors.slice(0, 600), { zeroLine: true, min: -bound, max: bound });
    renderSchedulePreview(distribution, seed);

    if (options.record) {
      void recordExperiment(result, distribution, seed, count);
    }
    return result;
  }

  function drawHistogram(errors, distribution) {
    const surface = setupCanvas(distCanvas);
    if (!surface) return;
    const { ctx, width, height } = surface;
    const bound = Math.max(10, Math.min(200, distribution.sigmaMs * 3 || distribution.rangeMs || 50));
    const data = histogram(errors, { bins: 61, range: [-bound, bound] });
    const max = Math.max(1, ...data.bins);
    const pad = 14;
    const plotH = height - pad;
    const barWidth = width / data.bins.length;

    // The centre line is a perfect hit; everything is drawn relative to it.
    const centreX = width / 2;
    ctx.strokeStyle = cssVar('--line-solid');
    ctx.beginPath();
    ctx.moveTo(Math.round(centreX) + 0.5, 0);
    ctx.lineTo(Math.round(centreX) + 0.5, plotH);
    ctx.stroke();

    for (let i = 0; i < data.bins.length; i++) {
      const count = data.bins[i];
      if (!count) continue;
      const barHeight = (count / max) * (plotH - 4);
      const offset = data.edges[i] + data.binWidth / 2;
      const isLate = offset > 0;
      ctx.fillStyle = Math.abs(offset) < data.binWidth / 2 ? cssVar('--accent') : isLate ? cssVar('--warn') : cssVar('--info');
      ctx.globalAlpha = 0.85;
      ctx.fillRect(i * barWidth, plotH - barHeight, Math.max(1, barWidth - 0.6), barHeight);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar('--fg-faint');
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`−${Math.round(bound)} ms`, 2, height - 2);
    ctx.fillText('0', centreX - 3, height - 2);
    const lateLabel = `+${Math.round(bound)} ms`;
    ctx.fillText(lateLabel, width - ctx.measureText(lateLabel).width - 2, height - 2);
    ctx.fillStyle = cssVar('--info');
    ctx.fillText('early', 2, 10);
    ctx.fillStyle = cssVar('--warn');
    const lateWord = 'late';
    ctx.fillText(lateWord, width - ctx.measureText(lateWord).width - 2, 10);
  }

  function renderSchedulePreview(distribution, seed) {
    if (!record?.notes?.length) return;
    const keyMap = defaultKeyMap(record.keys);
    const rate = prefs.get('practice.defaultRate');
    let schedule;
    try {
      schedule = buildInputSchedule({
        notes: record.notes.slice(0, 2000),
        keyMap, rate, seed, distribution,
        startChartTime: 0,
        tapHoldMs: prefs.get('simulation.tapHoldMs'),
        minHoldMs: prefs.get('simulation.minHoldMs'),
      });
    } catch (err) {
      clear(scheduleWarnings);
      scheduleWarnings.append(note({ variant: 'warn', icon: 'alert', text: `A schedule could not be built: ${err.message}` }));
      return;
    }

    scheduleStats.events.setValue(formatCount(schedule.events.length));
    scheduleStats.scheduled.setValue(formatCount(schedule.stats.scheduledNotes));
    scheduleStats.skipped.setValue(formatCount(schedule.stats.skippedNotes));
    scheduleStats.duration.setValue(formatDuration(schedule.stats.realDurationMs));

    clear(scheduleWarnings);
    if (schedule.warnings.length) {
      for (const warning of schedule.warnings) {
        scheduleWarnings.append(note({ variant: 'warn', icon: 'alert', text: warning }));
      }
    } else {
      scheduleWarnings.append(h('div.xs.muted', 'No warnings: every note in the first 2 000 has a lane with a key bound, and no press overlaps a previous release.'));
    }

    const preview = schedule.events.slice(0, 24)
      .map(([delay, code, down]) => `${delay.toFixed(3).padStart(9)} ms  ${code.padEnd(12)} ${down ? 'down' : 'up'}`)
      .join('\n');
    setText(schedulePreview, `${preview}\n${schedule.events.length > 24 ? `\n… ${formatCount(schedule.events.length - 24)} more events` : ''}`);
    return schedule;
  }

  async function recordExperiment(result, distribution, seed, count) {
    try {
      await recorder.begin({
        kind: 'simulation',
        seed,
        chart: {
          id: record.id, title: record.title, artist: record.artist, version: record.version,
          creator: record.creator, keys: record.keys, hash: record.hash, source: record.source, stars: record.stars,
        },
      });
      recorder.mark('simulation:run');
      recorder.record({
        simulation: {
          seed,
          samples: count,
          distribution: { kind: distribution.kind, sigmaMs: distribution.sigmaMs, rangeMs: distribution.rangeMs, biasMs: distribution.biasMs, splitRatio: distribution.splitRatio },
          mean: result.mean,
          stdDev: result.stdDev,
          median: result.median,
          p5: result.p5,
          p95: result.p95,
          min: result.min,
          max: result.max,
          unstableRate: result.unstableRate,
          wouldBeFlagged: result.wouldBeFlagged,
          labelled: 'simulation',
        },
        analysis: { objectCount: record.notes.length },
        playback: { rate: prefs.get('practice.defaultRate') },
      });
      await recorder.end('completed');
      await actions.refreshSessions();
      Toast.ok(`Recorded a ${count}-note ${distribution.kind} run (seed ${seed})`, 'Simulation saved');
    } catch (err) {
      Toast.error(`The run could not be recorded: ${err.message}`, 'Session storage');
    }
  }

  /* ── comparison ───────────────────────────────────────────────────── */

  function renderCompare() {
    restorePanels();
    const sessions = store.state.sessions.filter((s) => s.kind === 'simulation' || s.kind === 'practice' || (s.analysis && s.chart));
    clear(compareBody);

    if (sessions.length < 2) {
      compareBody.append(emptyState({
        icon: 'history',
        title: sessions.length ? 'Only one comparable session so far' : 'No recorded sessions yet',
        body: 'Comparison needs at least two recorded sessions. Run an experiment on this tab, or analyse and preview charts in the Practice Studio — both are recorded.',
        actions: [button({ label: 'Open Statistics', icon: 'statistics', size: 'sm', onClick: () => navigate('statistics') })],
      }));
      return;
    }

    const [newest, previous] = sessions;
    compareBody.append(h('div.row.row--wrap', { style: { gap: '8px' } },
      badge({ label: `Newest · ${formatRelative(newest.startedAt)}`, variant: 'accent' }),
      badge({ label: `Previous · ${formatRelative(previous.startedAt)}` }),
      h('div.grow'),
      button({ label: 'Open Statistics', icon: 'arrowRight', size: 'sm', variant: 'ghost', onClick: () => navigate('statistics') }),
    ));

    const rows = compareSessions(previous, newest);
    const table = h('table.table.table--compact');
    table.append(h('thead', h('tr', h('th', 'Measure'), h('th', 'Previous'), h('th', 'Newest'), h('th', 'Change'))));
    const body = h('tbody');
    for (const row of rows) {
      const has = (v) => v != null && Number.isFinite(+v);
      const formatValue = (v) => {
        if (v == null) return '—';
        if (row.field === 'startedAt') return formatRelative(v);
        if (row.unit === 'ms') return formatMs(+v, { digits: row.field === 'durationMs' ? 0 : 1, sign: false });
        if (row.unit === '×') return `${(+v).toFixed(2)}×`;
        if (row.unit === 'n/s') return `${(+v).toFixed(2)} n/s`;
        if (has(v)) return formatCount(+v);
        return String(v);
      };
      const deltaCell = row.delta == null
        ? h('td.muted', '—')
        : h('td.num', { style: { color: row.delta > 0 ? 'var(--ok)' : row.delta < 0 ? 'var(--warn)' : 'var(--fg-muted)' } },
          `${row.delta > 0 ? '+' : ''}${Math.round(row.delta * 100) / 100}${row.unit && row.unit !== 'ms' ? ` ${row.unit}` : ''}`);
      body.append(h('tr',
        h('td', row.label),
        h('td.num', formatValue(row.a)),
        h('td.num', formatValue(row.b)),
        deltaCell,
      ));
    }
    table.append(body);
    compareBody.append(table);
    compareBody.append(h('div.xs.muted',
      'A dash means that session did not measure this. ManiaFlow never fills a gap with a zero, because "not measured" and "measured as nothing" are different facts.'));

    // Trend across every session that has a timing figure.
    const trend = sessions.slice().reverse().map((s) => s.simulation?.unstableRate ?? s.simulation?.stdDev ?? null).filter((v) => v != null);
    if (trend.length >= 2) {
      const spark = sparkline({ height: 54, label: 'Unstable rate across recorded simulation runs' });
      spark.draw(trend, { min: 0, points: true });
      compareBody.append(panel({ title: 'Unstable rate over recorded runs', icon: 'wave', body: h('div.stack', spark.root, h('div.xs.muted', `The dotted reference is Ashtonk!mania’s bot threshold of ${BOT_UNSTABLE_RATE}.`)) }).root);
      drawThreshold(spark.canvas, trend);
    }
  }

  function drawThreshold(canvas, values) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const max = Math.max(...values, BOT_UNSTABLE_RATE * 1.2);
    const y = canvas.height - (BOT_UNSTABLE_RATE / max) * canvas.height * 0.92;
    ctx.save();
    ctx.strokeStyle = cssVar('--danger');
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
    ctx.restore();
  }

  /* ── wiring ───────────────────────────────────────────────────────── */

  scope.defer(store.subscribe((s) => s.loadedChart, (next) => {
    if (next?.id === record?.id && timing) return;
    loadChart(next);
  }));

  scope.defer(store.subscribe((s) => s.sessions, () => {
    if (!bodies.compare.hidden) renderCompare();
  }, { immediate: false }));

  scope.on(window, 'resize', () => {
    if (!record) return;
    if (!bodies.analysis.hidden) renderAnalysis();
    if (!bodies.simulation.hidden) runExperiment();
  });

  loadChart(store.state.loadedChart);

  return {
    root,
    onChart(next) { if (next?.id !== record?.id) loadChart(next); },
    dispose: () => {
      timing = null;
      record = null;
      scope.dispose();
    },
  };
}
