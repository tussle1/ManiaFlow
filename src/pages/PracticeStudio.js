/**
 * Practice Studio — a chart preview and playback workspace.
 *
 * Two things are true about this screen and both are stated on it:
 *
 *   • It is ManiaFlow's own playback of the chart. It is not a play inside Ashtonk!mania and
 *     it is not scored. The banner says so whenever the preview is running, so a simulated
 *     session can never be mistaken for gameplay.
 *   • It works with no integration at all. An imported `.osu` or `.osz` is enough; when the
 *     archive carried audio, the preview is driven by that audio element, and when it did
 *     not, the preview runs silently on ManiaFlow's own clock and says that too.
 *
 * Rendering reuses one canvas, one 2D context and one note index for the life of the chart.
 * A frame draws only the notes inside the visible time range, so a long chart costs the same
 * as a short one. When nothing is moving, nothing is drawn: a paused preview paints once
 * after a seek and then stops.
 */

import { h, setText, clear, Scope } from '../utils/dom.js';
import { panel, stat, badge, chip, emptyState, simulationBanner, shortcutRow } from '../components/primitives.js';
import { button, buttonGroup, toggleButton, setDisabled } from '../components/Button.js';
import { slider } from '../components/controls.js';
import { icon } from '../components/Icon.js';
import { StageRenderer, TimelineStrip } from '../components/ChartCanvas.js';
import { Toast } from '../components/Toast.js';
import { TimingEngine, Direction, scrollSpeedToTimeRange } from '../playback/TimingEngine.js';
import { PlaybackEngine, PlaybackState } from '../playback/PlaybackEngine.js';
import { barLines, redTimingPoints, scrollSegments } from '../chart/ChartParser.js';
import { densityBins } from '../chart/ChartMetadata.js';
import { defaultKeyMap, displayName } from '../chart/ChartRecord.js';
import { formatDuration, formatRate, formatMs, formatCount, keyLabel } from '../utils/formatters.js';
import { describeError } from '../utils/errors.js';
import { num } from '../utils/validation.js';

/** The speeds Ashtonk!mania's own practice bar offers, so the two feel like the same tool. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

export function createPracticeStudioPage(context) {
  const { store, prefs, actions, recorder, navigate, adapter } = context;
  const scope = new Scope();
  const unicode = () => !!prefs.get('appearance.unicodeMetadata');

  /** Per-chart objects, rebuilt only when the chart changes. */
  let engine = null;
  let timing = null;
  let renderer = null;
  let timeline = null;
  let audio = null;
  let audioUrl = null;
  let chartRecord = null;
  let sessionOpen = false;
  let seekCount = 0;
  let loopCount = 0;
  let needsDraw = true;

  /* ── stage ────────────────────────────────────────────────────────── */

  const canvas = h('canvas.stage__canvas');
  const simBadge = badge({ label: 'Simulation', variant: 'warn', tooltip: 'ManiaFlow’s own playback — not a play inside Ashtonk!mania, and not scored' });
  const clockBadge = badge({ label: 'silent', tooltip: 'No audio came with this chart, so the preview runs on ManiaFlow’s own clock' });
  const stage = h('div.stage', { style: { height: '440px', minHeight: '300px' } },
    canvas,
    h('div.stage__overlay',
      h('div.row', { style: { gap: '6px' } }, simBadge, clockBadge),
      h('div.row', { style: { justifyContent: 'flex-end' } }),
    ),
  );

  const timelineRoot = h('div.timeline',
    h('canvas.timeline__canvas'),
    h('div.timeline__loop', { style: { display: 'none' } }),
    h('div.timeline__playhead', { style: { transform: 'translateX(0px)' } }),
  );

  const stagePanel = panel({
    title: 'Chart preview',
    icon: 'practice',
    body: h('div.stack', stage, timelineRoot),
  });
  const stageTitle = stagePanel.head.querySelector('.panel__title span');

  /* ── transport ────────────────────────────────────────────────────── */

  const playButton = button({ icon: 'play', label: 'Play', variant: 'primary', onClick: () => togglePlay() });
  const stopButton = button({ icon: 'stop', ariaLabel: 'Stop and return to the start', tooltip: 'Stop (returns to the start)', onClick: () => doStop() });
  const restartButton = button({ icon: 'restart', ariaLabel: 'Restart from the beginning', tooltip: 'Restart', onClick: () => doRestart() });
  const back5 = button({ icon: 'arrowLeft', size: 'sm', variant: 'ghost', ariaLabel: 'Back 5 seconds', tooltip: 'Back 5s (←)', onClick: () => doSeek(-5000) });
  const back1 = button({ label: '−1s', size: 'sm', variant: 'ghost', tooltip: 'Back one second', onClick: () => doSeek(-1000) });
  const fwd1 = button({ label: '+1s', size: 'sm', variant: 'ghost', tooltip: 'Forward one second', onClick: () => doSeek(1000) });
  const fwd5 = button({ icon: 'arrowRight', size: 'sm', variant: 'ghost', ariaLabel: 'Forward 5 seconds', tooltip: 'Forward 5s (→)', onClick: () => doSeek(5000) });

  const positionStat = stat({ label: 'Position', value: '0:00.0', accent: true });
  const remainingStat = stat({ label: 'Remaining', value: '0:00' });
  const rateStat = stat({ label: 'Speed', value: '100%' });
  const stateStat = stat({ label: 'State', value: 'idle' });

  const transport = panel({
    title: 'Transport',
    body: h('div.stack',
      h('div.row.row--wrap', { style: { gap: '8px' } },
        buttonGroup([playButton, stopButton, restartButton]),
        back5, back1, fwd1, fwd5,
        h('div.grow'),
        h('div.row', { style: { gap: '4px' } }),
      ),
      h('div.grid.grid--4', positionStat.root, remainingStat.root, rateStat.root, stateStat.root),
    ),
  });
  const transportExtra = transport.body.firstElementChild.lastElementChild;

  /* ── speed chips ──────────────────────────────────────────────────── */

  const speedChips = SPEEDS.map((speed) => chip({
    label: formatRate(speed),
    tooltip: `Play at ${formatRate(speed)}${speed === 1 ? ' (the chart’s own speed)' : ''}`,
    onClick: () => setRate(speed),
  }));
  const speedRow = h('div.row.row--wrap', { style: { gap: '4px' } }, ...speedChips);

  /* ── loop ─────────────────────────────────────────────────────────── */

  const loopLabel = h('span.small.muted', 'No loop set');
  const loopA = button({ label: 'Set A', size: 'sm', tooltip: 'Set the loop start at the current position ([)', onClick: () => setLoop('a') });
  const loopB = button({ label: 'Set B', size: 'sm', tooltip: 'Set the loop end at the current position (])', onClick: () => setLoop('b') });
  const loopClear = button({ label: 'Clear', size: 'sm', variant: 'ghost', tooltip: 'Clear the loop (\\)', onClick: () => setLoop('clear') });

  /* ── preview options ──────────────────────────────────────────────── */

  const optionToggles = [
    { key: 'practice.showBarlines', label: 'Bar lines', icon: 'list' },
    { key: 'practice.showLaneGuides', label: 'Lane guides', icon: 'grid' },
    { key: 'practice.showSnapColours', label: 'Beat-snap colours', icon: 'note', tooltip: 'osu!’s timing colours: 1/1 white, 1/2 red, 1/4 blue, 1/8 yellow, 1/16 purple' },
    { key: 'practice.showKeyLabels', label: 'Key labels', icon: 'keyboard' },
    { key: 'practice.markSimultaneous', label: 'Mark chords', icon: 'layers', tooltip: 'Notes that start at the same instant are drawn in a different colour' },
    { key: 'practice.visibleNotes', label: 'Cull off-screen notes', icon: 'eye', tooltip: 'Draw only the notes inside the visible time range. Turn off to draw every note every frame.' },
  ].map((option) => {
    const control = toggleButton({
      label: option.label, icon: option.icon, size: 'sm', variant: 'ghost',
      pressed: !!prefs.get(option.key), tooltip: option.tooltip || option.label,
      onToggle: (on) => {
        prefs.set(option.key, on);
        applyRendererOptions();
      },
    });
    return { key: option.key, control };
  });

  const scrollSlider = slider({
    label: 'Scroll speed', min: 1, max: 40, step: 1,
    value: prefs.get('practice.scrollSpeed'),
    format: (v) => `${Math.round(v)} · ${Math.round(scrollSpeedToTimeRange(v))} ms`,
    hint: 'The same 1–40 scale Ashtonk!mania uses.',
    onInput: (v) => { applyScroll(v); },
    onChange: (v) => prefs.set('practice.scrollSpeed', v),
  });

  const offsetSlider = slider({
    label: 'Timing offset', min: -300, max: 300, step: 1,
    value: prefs.get('practice.offsetMs'),
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} ms`,
    hint: 'Shifts when a note is judged, exactly as the game’s own offset does: chartTime = clock − offset × rate.',
    onInput: (v) => applyOffset(v),
    onChange: (v) => prefs.set('practice.offsetMs', v),
  });

  const directionToggle = toggleButton({
    label: 'Up-scroll', icon: 'arrowUp', size: 'sm', variant: 'ghost',
    pressed: prefs.get('practice.scrollDirection') === 'up',
    tooltip: 'Mirror the stage so notes arrive from below',
    onToggle: (on) => {
      prefs.set('practice.scrollDirection', on ? 'up' : 'down');
      timing?.setDirection(on ? Direction.UP : Direction.DOWN);
      renderer?.invalidate();
      requestDraw();
    },
  });

  /* ── chart facts ──────────────────────────────────────────────────── */

  const factStats = {
    keys: stat({ label: 'Lanes', value: '—' }),
    objects: stat({ label: 'Objects', value: '—' }),
    holds: stat({ label: 'Holds', value: '—' }),
    bpm: stat({ label: 'BPM', value: '—' }),
    length: stat({ label: 'Length', value: '—' }),
    density: stat({ label: 'Peak density', value: '—', tooltip: 'The busiest one-second window, measured by ManiaFlow' }),
  };
  const factsPanel = panel({
    title: 'This chart',
    icon: 'note',
    body: h('div.stack',
      h('div.grid.grid--3', factStats.keys.root, factStats.objects.root, factStats.holds.root),
      h('div.grid.grid--3', factStats.bpm.root, factStats.length.root, factStats.density.root),
    ),
  });

  const keyMapBody = h('div.lane-map');
  const keyMapPanel = panel({
    title: 'Lane mapping',
    icon: 'keyboard',
    subtitle: 'used by the Input Lab',
    body: keyMapBody,
    actions: button({ label: 'Input Lab', icon: 'arrowRight', size: 'sm', variant: 'ghost', onClick: () => navigate('input') }),
  });

  /* ── shortcuts ────────────────────────────────────────────────────── */

  const shortcutsPanel = panel({
    title: 'Keyboard shortcuts',
    icon: 'question',
    body: h('div.stack', { style: { gap: '0' } },
      shortcutRow('Play / pause', ['Space']),
      shortcutRow('Stop', ['Shift', 'Space'], 'Returns to the start'),
      shortcutRow('Seek ±5 seconds', ['←', '→']),
      shortcutRow('Seek ±1 second', ['Shift', '←', '→']),
      shortcutRow('Set loop A / B', ['[', ']']),
      shortcutRow('Clear loop', ['\\']),
      shortcutRow('Restart loop section', ['Backspace']),
      shortcutRow('Speed down / up', ['-', '='], 'Steps through the speed chips'),
      shortcutRow('Open the Input Lab', ['I']),
    ),
  });

  /* ── layout ───────────────────────────────────────────────────────── */

  const emptyRoot = emptyState({
    icon: 'practice',
    title: 'No chart is loaded',
    body: 'Choose a chart from the library, or drop an .osu difficulty or .osz beatmap set anywhere in this window. '
      + 'The preview runs entirely inside ManiaFlow — no game and no bridge needed.',
    actions: [
      button({ label: 'Chart library', icon: 'library', variant: 'primary', size: 'sm', onClick: () => navigate('library') }),
      button({ label: 'Read from the game', icon: 'plug', size: 'sm', onClick: () => actions.refreshLibrary() }),
    ],
    secondary: 'An .osz that contains its audio gives a preview with sound; a loose .osu previews silently.',
  });

  const workspace = h('div.stack',
    stagePanel.root,
    transport.root,
    h('div.grid.grid--split',
      h('div.stack',
        panel({ title: 'Speed', icon: 'gauge', body: h('div.stack', speedRow, scrollSlider.root, directionToggle.root) }).root,
        panel({ title: 'Loop', icon: 'loop', body: h('div.stack', h('div.row', loopA, loopB, loopClear, h('div.grow'), loopLabel)) }).root,
        panel({ title: 'Display', icon: 'eye', body: h('div.row.row--wrap', { style: { gap: '4px' } }, ...optionToggles.map((t) => t.control)) }).root,
      ),
      h('div.stack',
        factsPanel.root,
        keyMapPanel.root,
        panel({ title: 'Timing', icon: 'timing', body: h('div.stack', offsetSlider.root) }).root,
      ),
    ),
    shortcutsPanel.root,
  );

  const root = h('div',
    h('div.page__head-row',
      h('div.page__head',
        h('h1.page__title', 'Practice Studio'),
        h('p.page__subtitle', 'Preview a chart, scrub its timeline, change speed and loop a section. '
          + 'This is ManiaFlow’s own playback — it is not a play inside Ashtonk!mania and it is not scored.'),
      ),
      h('div.page__actions'),
    ),
    simulationBanner('The stage below is ManiaFlow drawing the chart on its own clock. Nothing here is sent to the game unless you arm an input session in the Input Lab.'),
    workspace,
  );

  /* ── chart loading ────────────────────────────────────────────────── */

  function teardownChart() {
    if (sessionOpen) { closeSession('aborted'); }
    engine?.dispose();
    engine = null;
    timing = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio = null;
    }
    renderer?.dispose();
    renderer = null;
    timeline?.dispose();
    timeline = null;
    chartRecord = null;
    seekCount = 0;
    loopCount = 0;
  }

  function loadChart(record) {
    teardownChart();
    if (!record) { showEmpty(true); return; }
    if (!record.previewable || !record.chart || !record.notes?.length) {
      showEmpty(true, record);
      return;
    }
    showEmpty(false);
    chartRecord = record;

    timing = new TimingEngine({
      segments: scrollSegments(record.chart, { useSV: true, useBPM: true }),
      red: redTimingPoints(record.chart),
      rate: prefs.get('practice.defaultRate'),
      offsetMs: prefs.get('practice.offsetMs'),
      scrollSpeed: prefs.get('practice.scrollSpeed'),
      direction: prefs.get('practice.scrollDirection') === 'up' ? Direction.UP : Direction.DOWN,
    });

    const endTime = Math.max(1, ...record.notes.map((n) => n.end));
    const bars = barLines(redTimingPoints(record.chart), endTime);

    renderer = new StageRenderer(canvas, { timing });
    renderer.setChart({ notes: record.notes, keys: record.keys, barlines: bars });
    renderer.setOptions({
      showBarlines: !!prefs.get('practice.showBarlines'),
      showLaneGuides: !!prefs.get('practice.showLaneGuides'),
      showSnapColours: !!prefs.get('practice.showSnapColours'),
      showKeyLabels: !!prefs.get('practice.showKeyLabels'),
      markSimultaneous: !!prefs.get('practice.markSimultaneous'),
      cull: !!prefs.get('practice.visibleNotes'),
      noteHeight: Math.max(8, Math.min(20, 240 / Math.max(1, record.keys))),
      keyLabels: keyLabelsFor(record.keys),
    });

    const density = densityBins(record.notes, endTime, 320);
    timeline = new TimelineStrip(timelineRoot, { bins: density.bins, endTime, breaks: record.breaks });
    timeline.draw();
    timeline.setPlayhead(0);
    timeline.setLoop(null, null);

    // Audio, when the import supplied it. Its object URL belongs to the record, so it is
    // revoked when the chart is removed rather than here.
    audioUrl = record.audioUrl || null;
    if (audioUrl) {
      audio = new Audio(audioUrl);
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';
      clockBadge.setLabel('audio');
      clockBadge.dataset.tooltip = 'Driven by the audio that came with this beatmap set';
    } else {
      clockBadge.setLabel('silent');
      clockBadge.dataset.tooltip = 'No audio came with this chart, so the preview runs on ManiaFlow’s own clock';
    }

    engine = new PlaybackEngine({
      timing,
      durationMs: endTime,
      audio,
      preservesPitch: !!prefs.get('practice.preservePitch'),
      frameRate: prefs.get('performance.frameRate') || 0,
    });
    // Registered on the engine, not the page scope: teardownChart() disposes the engine,
    // which removes them. Putting them in the scope instead would accumulate one dead
    // closure per chart loaded during a session.
    engine.onFrame(onFrame);
    engine.on('state', ({ state }) => onStateChange(state));
    engine.on('end', () => { requestDraw(); void closeSession('completed'); });
    engine.on('looped', () => { loopCount++; updateLoopLabel(); });
    engine.on('warning', (w) => Toast.warn(w.message, 'Preview'));
    engine.load({ durationMs: endTime });

    // Sync the controls to the chart that just loaded.
    syncControls();
    renderFacts(record, endTime);
    renderKeyMap(record.keys);
    setText(stageTitle, displayName(record, unicode()));
    setDisabled(playButton, false);
    requestDraw();

    if (prefs.get('practice.autoplayPreview')) void togglePlay(true);
  }

  function keyLabelsFor(keys) {
    // The game's own bindings when a bridge is connected; its documented defaults otherwise.
    const bindings = defaultKeyMap(keys);
    return bindings.map((codes) => keyLabel(codes[0]));
  }

  async function refreshKeyLabels() {
    const record = chartRecord;
    if (!record || !renderer) return;
    const current = adapter();
    if (!current?.client?.bridgeConnected) return;
    try {
      const result = await current.keybindsFor(record.keys, prefs.get(`keymap.${record.id}`));
      // Read during chart load, which also happens while the page is mounting. If the user
      // has left by now, there is no renderer to write the labels into.
      if (scope.disposed) return;
      if (Array.isArray(result?.bindings)) {
        renderer.setOptions({ keyLabels: result.bindings.map((codes) => keyLabel(codes[0])) });
        renderKeyMap(record.keys, result.bindings, result.origin);
        requestDraw();
      }
    } catch {
      // A failed keybind read is not worth interrupting practice for; the defaults are shown.
    }
  }

  function renderFacts(record, endTime) {
    const analysis = record.analysis;
    factStats.keys.setValue(record.keys ? `${record.keys}K` : '—');
    factStats.objects.setValue(record.objectCount != null ? formatCount(record.objectCount) : formatCount(record.notes.length));
    factStats.holds.setValue(analysis?.lnCount != null ? formatCount(analysis.lnCount) : '—');
    factStats.bpm.setValue(record.bpm ? `${Math.round(record.bpm * 100) / 100}` : '—');
    factStats.length.setValue(formatDuration(endTime));
    factStats.density.setValue(analysis?.peakNps != null ? `${analysis.peakNps.toFixed(1)} n/s` : '—');
  }

  function renderKeyMap(keys, bindings = null, origin = null) {
    clear(keyMapBody);
    const map = bindings || defaultKeyMap(keys);
    keyMapPanel.head.querySelector('.panel__title span').textContent = 'Lane mapping';
    for (let lane = 0; lane < keys; lane++) {
      const codes = Array.isArray(map[lane]) ? map[lane] : [];
      keyMapBody.append(h('div.lane-map__cell',
        h('div.lane-map__lane', `Lane ${lane + 1}`),
        h('div.row', { style: { gap: '3px', flexWrap: 'wrap' } },
          ...(codes.length ? codes.map((code) => h('span.kbd', keyLabel(code))) : [h('span.xs.faint', 'unbound')]),
        ),
      ));
    }
    keyMapBody.append(h('div.xs.muted', { style: { gridColumn: '1 / -1' } },
      origin === 'game' ? 'Read from Ashtonk!mania’s configured keybinds.'
        : origin === 'override' ? 'Your saved override for this chart.'
          : 'Ashtonk!mania’s documented defaults for this key count. Connect a bridge to read your own.'));
  }

  function showEmpty(show, record = null) {
    workspace.style.display = show ? 'none' : '';
    if (!show) { emptyRoot.remove(); return; }
    if (!emptyRoot.isConnected) root.append(emptyRoot);
    const body = emptyRoot.querySelector('.empty__body');
    const title = emptyRoot.querySelector('.empty__title');
    if (record) {
      setText(title, 'This chart cannot be previewed');
      clear(body);
      body.append(h('div.stack', { style: { gap: '4px', textAlign: 'left' } },
        ...(record.problems || []).map((p) => h('div', p)),
        ...(record.warnings || []).map((w) => h('div.muted', w)),
      ));
    } else {
      setText(title, 'No chart is loaded');
      setText(body, 'Choose a chart from the library, or drop an .osu difficulty or .osz beatmap set anywhere in this window. '
        + 'The preview runs entirely inside ManiaFlow — no game and no bridge needed.');
    }
  }

  /* ── playback ─────────────────────────────────────────────────────── */

  function requestDraw() { needsDraw = true; ensureIdleLoop(); }

  /**
   * A frame loop that only exists when something needs drawing. While playing, the engine
   * drives `onFrame`; while paused, one idle loop paints a single frame after a seek and
   * then stops itself.
   */
  let idleFrame = 0;
  function ensureIdleLoop() {
    if (idleFrame || engine?.isRunning) return;
    const step = () => {
      idleFrame = 0;
      if (!needsDraw || !renderer || !engine) return;
      needsDraw = false;
      renderer.draw(engine.position);
      timeline?.setPlayhead(engine.position);
      updateTransport(engine.describe());
    };
    idleFrame = requestAnimationFrame(step);
  }

  function onFrame(frame) {
    needsDraw = false;
    renderer?.draw(frame.chartTime);
    timeline?.setPlayhead(frame.chartTime);
    updateTransport(frame);
  }

  function onStateChange(state) {
    stateStat.setValue(state);
    const playing = state === PlaybackState.PLAYING;
    // One write: the icon and the label change together, so replacing the children once is
    // both cheaper and free of the half-updated frame a two-step write would show.
    playButton.replaceChildren(icon(playing ? 'pause' : 'play', { size: 15 }), h('span', playing ? 'Pause' : 'Play'));
    playButton.dataset.tooltip = playing ? 'Pause (Space)' : 'Play (Space)';
    if (playing) openSession();
    updateButtons();
    requestDraw();
  }

  function updateButtons() {
    const loaded = !!engine && engine.state !== PlaybackState.IDLE;
    setDisabled(stopButton, !loaded);
    setDisabled(restartButton, !loaded);
    setDisabled(back5, !loaded); setDisabled(back1, !loaded);
    setDisabled(fwd1, !loaded); setDisabled(fwd5, !loaded);
    setDisabled(loopA, !loaded); setDisabled(loopB, !loaded); setDisabled(loopClear, !loaded);
    for (const c of speedChips) c.disabled = !loaded;
    setDisabled(playButton, !loaded, 'Load a previewable chart first');
  }

  function updateTransport(frame) {
    if (!engine) return;
    const position = frame?.chartTime ?? engine.position;
    const duration = engine.durationMs;
    positionStat.setValue(formatDuration(position, { tenths: true }));
    remainingStat.setValue(formatDuration(Math.max(0, duration - position)));
    rateStat.setValue(formatRate(engine.rate));
    stateStat.setValue(engine.state);
    store.update({ playback: engine.describe() });
  }

  async function togglePlay(forcePlay = null) {
    if (!engine || engine.state === PlaybackState.IDLE) {
      Toast.info('Load a chart first.', 'Nothing to play');
      return;
    }
    const wantPlay = forcePlay != null ? forcePlay : engine.state !== PlaybackState.PLAYING;
    try {
      if (wantPlay) await engine.play();
      else engine.pause();
    } catch (err) {
      Toast.error(describeError(err), 'Playback failed');
    }
  }

  function doStop() {
    if (!engine) return;
    engine.stop();
    closeSession('completed');
    seekCount = 0;
    requestDraw();
  }

  async function doRestart() {
    if (!engine) return;
    try { await engine.restart(); } catch (err) { Toast.error(describeError(err), 'Restart failed'); }
  }

  async function doSeek(deltaMs) {
    if (!engine) return;
    seekCount++;
    try { await engine.seekBy(deltaMs); } catch (err) { Toast.error(describeError(err), 'Seek failed'); }
    requestDraw();
  }

  async function seekTo(chartMs) {
    if (!engine) return;
    seekCount++;
    try { await engine.seek(chartMs); } catch (err) { Toast.error(describeError(err), 'Seek failed'); }
    requestDraw();
  }

  function setRate(rate) {
    if (!engine) return;
    try {
      engine.setRate(rate);
      syncControls();
      requestDraw();
    } catch (err) {
      Toast.error(describeError(err), 'Speed change failed');
    }
  }

  function stepRate(direction) {
    if (!engine) return;
    const current = engine.rate;
    const index = SPEEDS.findIndex((s) => Math.abs(s - current) < 0.001);
    const next = index < 0
      ? Math.min(2, Math.max(0.25, Math.round((current + direction * 0.25) * 4) / 4))
      : SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, index + direction))];
    setRate(next);
  }

  function applyScroll(speed) {
    timing?.setScrollSpeed(speed);
    renderer?.invalidate();
    requestDraw();
  }

  function applyOffset(ms) {
    timing?.setOffset(ms);
    requestDraw();
  }

  function applyRendererOptions() {
    if (!renderer) return;
    renderer.setOptions({
      showBarlines: !!prefs.get('practice.showBarlines'),
      showLaneGuides: !!prefs.get('practice.showLaneGuides'),
      showSnapColours: !!prefs.get('practice.showSnapColours'),
      showKeyLabels: !!prefs.get('practice.showKeyLabels'),
      markSimultaneous: !!prefs.get('practice.markSimultaneous'),
      cull: !!prefs.get('practice.visibleNotes'),
    });
    // Marking chords is decided when the chart is indexed, so it needs a reload of the notes.
    if (chartRecord) renderer.setChart({ notes: chartRecord.notes, keys: chartRecord.keys, barlines: renderer.barlines });
    renderer.invalidate();
    requestDraw();
  }

  function setLoop(which) {
    if (!engine) return;
    if (which === 'clear') engine.setLoop('clear');
    else {
      engine.setLoop(which, engine.position);
      if (which === 'a') loopCount = 0;
    }
    updateLoopLabel();
    timeline?.setLoop(engine.loop.a, engine.loop.b);
    requestDraw();
  }

  function updateLoopLabel() {
    if (!engine) return;
    const { a, b } = engine.loop;
    setText(loopLabel, a == null && b == null
      ? 'No loop set'
      : `Loop ${formatDuration(a ?? 0, { tenths: true })} → ${formatDuration(b ?? engine.durationMs, { tenths: true })}`);
    timeline?.setLoop(a, b);
  }

  function syncControls() {
    if (!engine) return;
    const rate = engine.rate;
    speedChips.forEach((c, i) => c.setOn(Math.abs(SPEEDS[i] - rate) < 0.001));
    scrollSlider.setValue(prefs.get('practice.scrollSpeed'), { silent: true });
    offsetSlider.setValue(engine.offsetMs, { silent: true });
    for (const toggle of optionToggles) toggle.control.setPressed(!!prefs.get(toggle.key));
    directionToggle.setPressed(engine.timing.direction === Direction.UP);
    rateStat.setValue(formatRate(rate));
    updateLoopLabel();
    updateButtons();
  }

  /* ── session recording ────────────────────────────────────────────── */

  async function openSession() {
    if (sessionOpen || !chartRecord) return;
    sessionOpen = true;
    await recorder.begin({
      kind: 'practice',
      chart: {
        id: chartRecord.id, title: chartRecord.title, artist: chartRecord.artist,
        version: chartRecord.version, creator: chartRecord.creator, keys: chartRecord.keys,
        hash: chartRecord.hash, source: chartRecord.source, stars: chartRecord.stars,
      },
    });
    recorder.mark('preview:start');
    recorder.record({
      analysis: chartRecord.analysis ? {
        objectCount: chartRecord.analysis.objectCount,
        lnCount: chartRecord.analysis.lnCount,
        bpm: chartRecord.analysis.bpm,
        peakNps: chartRecord.analysis.peakNps,
      } : null,
      playback: { clockSource: audioUrl ? 'audio' : 'internal' },
    });
    store.update({ activeSession: { kind: 'practice', startedAt: Date.now(), elapsedLabel: 'preview running' } });
  }

  async function closeSession(status = 'completed') {
    if (!sessionOpen) return;
    sessionOpen = false;
    recorder.record({
      playback: {
        rate: engine?.rate ?? null,
        offsetMs: engine?.offsetMs ?? null,
        scrollSpeed: timing?.scrollSpeed ?? null,
        seekCount,
        loopCount,
        clockSource: engine?.describe().clockSource ?? (audioUrl ? 'audio' : 'internal'),
        reachedMs: engine?.position ?? null,
        durationMs: engine?.durationMs ?? null,
      },
    });
    recorder.mark('preview:end');
    await recorder.end(status);
    store.update({ activeSession: null });
    actions.refreshSessions();
  }

  /* ── timeline interaction ─────────────────────────────────────────── */

  let dragging = false;
  const onPointerDown = (event) => {
    if (!engine || !timeline) return;
    dragging = true;
    timelineRoot.setPointerCapture?.(event.pointerId);
    void seekTo(timeline.timeAtClientX(event.clientX));
  };
  const onPointerMove = (event) => {
    if (!dragging || !timeline) return;
    void seekTo(timeline.timeAtClientX(event.clientX));
  };
  const onPointerUp = (event) => {
    if (!dragging) return;
    dragging = false;
    timelineRoot.releasePointerCapture?.(event.pointerId);
  };
  scope.on(timelineRoot, 'pointerdown', onPointerDown);
  scope.on(timelineRoot, 'pointermove', onPointerMove);
  scope.on(window, 'pointerup', onPointerUp);
  scope.on(window, 'pointercancel', onPointerUp);

  /* ── resize ───────────────────────────────────────────────────────── */

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      renderer?.invalidate();
      timeline?.draw();
      timeline?.setPlayhead(engine?.position ?? 0);
      requestDraw();
    });
    observer.observe(stage);
    observer.observe(timelineRoot);
    scope.defer(() => observer.disconnect());
  } else {
    scope.on(window, 'resize', () => { renderer?.invalidate(); timeline?.draw(); requestDraw(); });
  }

  /* ── keyboard ─────────────────────────────────────────────────────── */

  const onKeyDown = (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]')) return;

    switch (event.code) {
      case 'Space':
        if (event.shiftKey) { event.preventDefault(); doStop(); return; }
        event.preventDefault();
        void togglePlay();
        return;
      case 'ArrowLeft':
        event.preventDefault();
        void doSeek(event.shiftKey ? -1000 : -5000);
        return;
      case 'ArrowRight':
        event.preventDefault();
        void doSeek(event.shiftKey ? 1000 : 5000);
        return;
      case 'BracketLeft': event.preventDefault(); setLoop('a'); return;
      case 'BracketRight': event.preventDefault(); setLoop('b'); return;
      case 'Backslash': event.preventDefault(); setLoop('clear'); return;
      case 'Backspace':
        event.preventDefault();
        if (engine) void seekTo(engine.loop.a ?? 0);
        return;
      case 'Minus':
      case 'NumpadSubtract': event.preventDefault(); stepRate(-1); return;
      case 'Equal':
      case 'NumpadAdd': event.preventDefault(); stepRate(1); return;
      case 'KeyI':
        if (!event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); navigate('input'); }
        return;
      default: return;
    }
  };
  scope.on(window, 'keydown', onKeyDown);

  /* ── store wiring ─────────────────────────────────────────────────── */

  scope.defer(store.subscribe((s) => s.loadedChart, (record) => {
    if (record?.id === chartRecord?.id && engine) return;   // already showing this chart
    loadChart(record);
    if (record) refreshKeyLabels();
  }));

  // A preference changed elsewhere (the Settings page) must reach a live preview.
  scope.defer(prefs.on('change', ({ key }) => {
    if (!engine) return;
    if (key === 'practice.scrollSpeed') { applyScroll(prefs.get(key)); scrollSlider.setValue(prefs.get(key), { silent: true }); }
    if (key === 'practice.offsetMs') { applyOffset(prefs.get(key)); offsetSlider.setValue(prefs.get(key), { silent: true }); }
    if (key === 'practice.scrollDirection') {
      timing.setDirection(prefs.get(key) === 'up' ? Direction.UP : Direction.DOWN);
      directionToggle.setPressed(prefs.get(key) === 'up');
      renderer.invalidate();
      requestDraw();
    }
    if (key === 'practice.defaultRate' && engine.state !== PlaybackState.PLAYING) setRate(prefs.get(key));
    if (key.startsWith('practice.show') || key === 'practice.markSimultaneous' || key === 'practice.visibleNotes') {
      applyRendererOptions();
      syncControls();
    }
    if (key === 'performance.frameRate' && engine) engine.frameRate = num(prefs.get(key), 0);
    if (key === 'performance.pixelRatioCap') { renderer?.invalidate(); requestDraw(); }
  }));

  scope.defer(store.subscribe((s) => s.integration?.bridgeConnected, (connected) => {
    if (connected && chartRecord) refreshKeyLabels();
  }, { immediate: false }));

  loadChart(store.state.loadedChart);
  updateButtons();

  return {
    root,
    focus: () => playButton.focus({ preventScroll: true }),
    onSpace: () => { void togglePlay(); return true; },
    onChart(record) { if (record?.id !== chartRecord?.id) loadChart(record); },
    async dispose() {
      if (idleFrame) cancelAnimationFrame(idleFrame);
      idleFrame = 0;
      if (sessionOpen) await closeSession('aborted');
      teardownChart();
      // An object URL created for this preview is the record's, not ours; the library
      // revokes it when the chart is removed. Nothing else to release.
      audioUrl = null;
      scope.dispose();
      store.update({ playback: null });
    },
  };
}

export { SPEEDS };
