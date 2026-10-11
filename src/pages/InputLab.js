/**
 * Input Lab — the raw keyboard input system, and everything that makes it safe.
 *
 * What this screen drives is a separate keyboard path. It never touches Ashtonk!mania's
 * Auto mod, never calls its `generateAutoInputs`, and never writes to a gameplay session's
 * `feed`. Two backends implement one interface:
 *
 *   synthetic   the in-page bridge dispatches real `KeyboardEvent`s on `window`, which is
 *               where the game listens (capture phase) and which it resolves by
 *               `event.code`. They are `isTrusted === false`. That is stated on screen,
 *               because claiming otherwise would be a lie about what the browser did.
 *   os          the ManiaFlow server injects keys into the operating system's input queue
 *               through a native helper (xdotool, ydotool, cliclick, or PowerShell +
 *               SendInput). These are genuine OS-level events; they need a helper installed
 *               and the browser window focused.
 *
 * Before anything runs, the gate is checked against the live game state, and it only opens
 * inside the game's own practice mode. That is not a policy overlay bolted on afterwards —
 * a scored play in Ashtonk!mania is re-judged server-side from the beatmap and the recorded
 * key events, and an unstable rate below 15 over 100+ notes is rejected there as inhuman
 * timing. Perfect automated input on a scored play would be caught. Practice mode records no
 * input events at all and is never submitted.
 */

import { h, setText, clear, Scope } from '../utils/dom.js';
import { panel, stat, note, badge, emptyState, keycap, simulationBanner, statusDot } from '../components/primitives.js';
import { button, setDisabled } from '../components/Button.js';
import { toggle, slider, segmented, textInput } from '../components/controls.js';
import { icon } from '../components/Icon.js';
import { Toast } from '../components/Toast.js';
import { Dialog } from '../components/Dialog.js';
import { InputState } from '../input/InputScheduler.js';
import { validateKeyMapForBackend, BackendId } from '../input/KeyboardAdapter.js';
import { buildInputSchedule, validateSchedule, MIN_HOLD_MS } from '../playback/Simulation.js';
import { defaultKeyMap, displayName } from '../chart/ChartRecord.js';
import { validateKeyCode } from '../utils/validation.js';
import { describeError, ErrorCode } from '../utils/errors.js';
import { keyLabel, formatDuration, formatCount, formatMs, formatRate } from '../utils/formatters.js';
import { Level } from '../game/IntegrationStatus.js';

export function createInputLabPage(context) {
  const { store, prefs, actions, navigate } = context;
  const scope = new Scope();
  const unicode = () => !!prefs.get('appearance.unicodeMetadata');

  const scheduler = () => context.input();
  const registry = () => context.registry();
  const adapter = () => context.adapter();

  let record = null;
  let keyMap = null;
  let keyMapOrigin = 'default';
  let captureLane = null;          // which lane is waiting for a key press
  const caps = new Map();          // lane → keycap component
  const liveKeys = new Map();      // code → keycap component (physical press display)

  /* ── gate ─────────────────────────────────────────────────────────── */

  const gateDot = statusDot({ level: 'idle', label: 'Checking…' });
  const gateReason = h('div.small.dim');
  const gatePanel = panel({
    title: 'Safety gate',
    icon: 'shield',
    body: h('div.stack',
      h('div.row', { style: { gap: '8px' } }, gateDot.root),
      gateReason,
      h('div.row.row--wrap', { style: { gap: '6px' } },
        button({ label: 'Re-check', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => checkGate(true) }),
        button({ label: 'How this works', icon: 'question', size: 'sm', variant: 'ghost', onClick: showSafetyExplanation }),
      ),
    ),
  });

  function showSafetyExplanation() {
    Dialog.info({
      title: 'Why the gate only opens in practice mode',
      size: 'wide',
      body: h('div.stack',
        h('p', 'Ashtonk!mania verifies a scored play on its own server. Given the beatmap file, checked against its hash, '
          + 'and the play’s recorded key events, it replays them through the same judging engine the game uses and computes the '
          + 'score, accuracy, combo, grade, star rating and pp itself. It never takes a client’s word for a result.'),
        h('p', 'Two of its checks matter here:'),
        h('ul', { style: { paddingLeft: '18px', listStyle: 'disc', display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('li', `A press and release closer than ${MIN_HOLD_MS} ms is rejected as impossible input — “not a finger”.`),
          h('li', 'An unstable rate below 15 over 100 or more judged notes is rejected as inhuman timing: '
            + '“no person hits a hundred notes that evenly”. Perfect automated input is caught by design.'),
        ),
        h('p', 'A play is only submitted for verification when it passed, is not Auto, is in play mode, and is not practice. '
          + 'Practice mode records no input events at all — the game’s own code skips them — so a practice session can never '
          + 'become a ranked score.'),
        h('p', 'ManiaFlow therefore refuses to arm input unless the game reports it is in practice mode, and refuses outright '
          + 'during multiplayer or while spectating. That is not caution for its own sake: it is the only context in which '
          + 'automated input is both permitted and incapable of producing a score.'),
        note({
          variant: 'warn', icon: 'alert', title: 'This is a practice, accessibility and analysis tool',
          text: 'Do not use it to gain an advantage in public competitive play. Nothing here bypasses, evades or attempts to '
            + 'defeat the game’s anti-cheat, and no timing profile is presented as human or undetectable.',
        }),
      ),
    });
  }

  /* ── backend ──────────────────────────────────────────────────────── */

  const backendSegment = segmented({
    label: 'Input backend', value: prefs.get('input.backend'),
    options: [
      { id: 'synthetic', label: 'Synthetic (in-page)', tooltip: 'KeyboardEvents dispatched inside the game page by the bridge' },
      { id: 'os', label: 'Operating system', tooltip: 'Real key events injected through a native helper by the ManiaFlow server' },
    ],
    onChange: (id) => { prefs.set('input.backend', id); renderBackend(); },
  });

  const backendBody = h('div.stack');
  const backendPanel = panel({ title: 'Input backend', icon: 'plug', body: h('div.stack', backendSegment.root, backendBody) });

  const osBody = h('div.stack');
  const trustedNote = h('div');

  function renderBackend() {
    const reg = registry();
    if (!reg) {
      clear(backendBody);
      backendBody.append(note({ variant: 'warn', icon: 'alert', text: 'No integration is configured, so no input backend can be armed. Charts you import still analyse and preview normally.' }));
      return;
    }
    const described = reg.describeAll();
    const selected = described.find((b) => b.id === reg.selectedId);

    clear(backendBody);
    clear(trustedNote);
    trustedNote.append(note({
      variant: selected?.trusted ? 'accent' : 'warn',
      icon: selected?.trusted ? 'check' : 'alert',
      title: selected?.trusted ? 'Operating-system input' : 'Synthetic input is not hardware input',
      text: selected?.trusted
        ? 'Keys are injected into the operating system’s input queue by a native helper, so the focused browser window receives them as real key events. The helper must be installed and the game window must be focused.'
        : 'The bridge constructs KeyboardEvent objects inside the game page. Ashtonk!mania resolves them by key code and does not check isTrusted, so they are accepted — but the browser marks them isTrusted === false and they are not the same thing as a physical key press.',
    }));
    backendBody.append(trustedNote);

    for (const backend of described) {
      const row = h('div.panel.panel--sunken', { style: { padding: '10px 12px', gap: '6px' } });
      row.append(h('div.row', { style: { gap: '8px' } },
        h(`span.dot.dot--${backend.available ? 'ok' : backend.id === reg.selectedId ? 'warn' : 'idle'}`),
        h('span.small.strong', backend.label),
        backend.id === reg.selectedId ? badge({ label: 'selected', variant: 'accent' }) : null,
        backend.armed ? badge({ label: 'armed', variant: 'ok' }) : null,
        h('div.grow'),
        h('span.xs.muted', backend.available ? 'available' : 'unavailable'),
      ));
      row.append(h('div.xs.muted', backend.detail || backend.note || ''));
      if (backend.id === 'os') {
        row.append(h('div.xs.faint', backend.recommended ? `Detected helper: ${backend.recommended}` : 'No helper detected on this machine yet'));
        row.append(h('div.row', { style: { gap: '6px', marginTop: '6px' } },
          button({ label: 'Detect helpers', icon: 'search', size: 'sm', variant: 'ghost', onClick: () => detectOs() }),
          button({
            label: backend.armed ? 'Disarm' : 'Arm helper', icon: backend.armed ? 'power' : 'bolt', size: 'sm',
            variant: backend.armed ? 'ghost' : 'default', disabled: !backend.available && !backend.armed,
            onClick: () => (backend.armed ? disarmOs() : armOs()),
          }),
        ));
        osBody.replaceChildren(...osBackendDetails(backend));
        row.append(osBody);
      }
      backendBody.append(row);
    }
  }

  function osBackendDetails(backend) {
    if (!backend.backends) return [h('div.xs.faint', 'Run “Detect helpers” to see what this machine offers.')];
    const out = [];
    for (const candidate of backend.backends) {
      out.append(h('div.stack', { style: { gap: '2px', padding: '6px 0', borderTop: '1px solid var(--line-faint)' } },
        h('div.row', { style: { gap: '6px' } },
          h(`span.dot.dot--${candidate.available ? 'ok' : 'idle'}`),
          h('span.small', candidate.label),
          h('div.grow'),
          h('span.badge', candidate.installed ? (candidate.available ? 'available' : 'installed, unusable') : 'not installed'),
        ),
        h('div.xs.muted', candidate.note || ''),
        candidate.reason ? h('div.xs', { style: { color: 'var(--danger)' } }, candidate.reason) : null,
        Array.isArray(candidate.supports) ? h('div.xs.faint', `Verified keys: ${candidate.supports.map(keyLabel).join(' ')}`) : null,
      ));
    }
    if (backend.warnings?.length) {
      for (const warning of backend.warnings) out.push(h('div.xs', { style: { color: 'var(--warn)' } }, warning));
    }
    return out;
  }

  /* ── key mapping ──────────────────────────────────────────────────── */

  const mapBody = h('div.stack');
  const mapPanel = panel({
    title: 'Lane → key mapping', icon: 'keyboard',
    body: mapBody,
    actions: h('div.row', { style: { gap: '6px' } },
      button({ label: 'Read from game', icon: 'plug', size: 'sm', variant: 'ghost', onClick: () => readKeybinds(true) }),
      button({ label: 'Reset to defaults', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => resetKeyMap() }),
    ),
  });

  const mapProblems = h('div.stack', { style: { gap: '4px' } });

  function renderKeyMap() {
    clear(mapBody);
    if (!record) {
      mapBody.append(emptyState({
        icon: 'keyboard', title: 'No chart loaded',
        body: 'The mapping follows the chart’s lane count. Load a chart to configure it.',
        actions: [button({ label: 'Chart library', icon: 'library', size: 'sm', onClick: () => navigate('library') })],
      }));
      return;
    }
    const keys = record.keys;
    mapBody.append(h('div.row.row--between',
      h('div.small.muted', `${keys} lanes · ${keyMapOrigin === 'game' ? 'read from Ashtonk!mania’s configured keybinds' : keyMapOrigin === 'override' ? 'your saved override for this chart' : 'Ashtonk!mania’s documented defaults for this key count'}`),
      h('span.badge', `${keys}K`),
    ));

    const grid = h('div.lane-map');
    caps.clear();
    for (let lane = 0; lane < keys; lane++) {
      const codes = keyMap[lane] || [];
      const cap = keycap({ label: codes.length ? keyLabel(codes[0]) : '—', lane, tooltip: `Lane ${lane + 1}${codes.length > 1 ? ` · also ${codes.slice(1).map(keyLabel).join(', ')}` : ''}` });
      caps.set(lane, cap);
      const cell = h('div.lane-map__cell',
        h('div.row.row--between',
          h('span.lane-map__lane', `Lane ${lane + 1}`),
          button({ icon: 'sliders', size: 'sm', variant: 'ghost', ariaLabel: `Rebind lane ${lane + 1}`, tooltip: 'Rebind this lane', onClick: () => beginCapture(lane) }),
        ),
        cap.root,
        h('div.row', { style: { gap: '3px', flexWrap: 'wrap' } },
          ...(codes.length ? codes.map((code) => h('span.kbd', keyLabel(code))) : [h('span.xs.faint', 'unbound')]),
        ),
        button({ label: 'Test key', size: 'sm', variant: 'ghost', onClick: () => testLane(lane) }),
      );
      grid.append(cell);
    }
    mapBody.append(grid);
    mapBody.append(h('div.xs.muted', 'Click a lane’s rebind button, then press the key you want. A key already bound to another lane is refused rather than silently moved.'));
    mapBody.append(mapProblems);
    renderMapProblems();
  }

  function renderMapProblems() {
    clear(mapProblems);
    if (!record || !keyMap) return;
    const backend = registry()?.selected;
    const check = validateKeyMapForBackend(keyMap, record.keys, backend);
    if (check.ok) {
      mapProblems.append(note({ variant: 'accent', icon: 'check', text: 'Every lane has a distinct, sendable key.' }));
      return;
    }
    for (const problem of check.problems) {
      mapProblems.append(note({ variant: 'warn', icon: 'alert', text: problem }));
    }
  }

  function beginCapture(lane) {
    captureLane = lane;
    caps.get(lane)?.setTarget(true);
    store.update({ statusMessage: `Press a key for lane ${lane + 1}… (Escape cancels)` });
  }

  function cancelCapture() {
    if (captureLane == null) return;
    caps.get(captureLane)?.setTarget(false);
    captureLane = null;
    store.update({ statusMessage: null });
  }

  async function applyCapture(code) {
    const lane = captureLane;
    cancelCapture();
    if (lane == null || !record) return false;

    const validity = validateKeyCode(code);
    if (!validity.ok) { Toast.error(validity.reason, 'Key not usable'); return false; }

    const backend = registry()?.selected;
    const supported = backend?.id === BackendId.OS
      ? backend.detection?.backends?.find((b) => b.id === backend.helperId)?.supports
      : null;
    if (Array.isArray(supported) && !supported.includes(code)) {
      Toast.error(`${backend.helperId} cannot send “${keyLabel(code)}”. Choose one of: ${supported.map(keyLabel).join(' ')}.`, 'Key not supported');
      return false;
    }

    const next = keyMap.map((codes) => [...codes]);
    // A key bound to two lanes would press both at once; refuse rather than guess.
    for (let i = 0; i < next.length; i++) {
      if (i !== lane && next[i].includes(code)) {
        Toast.error(`“${keyLabel(code)}” is already bound to lane ${i + 1}. Rebind that lane first.`, 'Key already bound');
        return false;
      }
    }
    next[lane] = [code];
    keyMap = next;
    keyMapOrigin = 'override';
    prefs.setOverride(`keymap.${record.id}`, keyMap);
    renderKeyMap();
    Toast.ok(`Lane ${lane + 1} is now ${keyLabel(code)}`, 'Mapping updated');
    return true;
  }

  function resetKeyMap() {
    if (!record) return;
    keyMap = defaultKeyMap(record.keys);
    keyMapOrigin = 'default';
    prefs.setOverride(`keymap.${record.id}`, null);
    renderKeyMap();
  }

  async function readKeybinds(announce = false) {
    if (!record) return;
    const override = prefs.get(`keymap.${record.id}`);
    if (Array.isArray(override) && override.length === record.keys && !announce) {
      keyMap = override.map((codes) => [...codes]);
      keyMapOrigin = 'override';
      renderKeyMap();
      return;
    }
    const current = adapter();
    if (!current) {
      if (announce) Toast.info('No integration is configured, so the game’s keybinds cannot be read. The documented defaults are used.');
      keyMap = defaultKeyMap(record.keys);
      keyMapOrigin = 'default';
      renderKeyMap();
      return;
    }
    try {
      const result = await current.keybindsFor(record.keys, null);
      if (scope.disposed) return;
      keyMap = result.bindings;
      keyMapOrigin = result.origin;
      if (result.origin === 'game') prefs.setOverride(`keymap.${record.id}`, keyMap);
      renderKeyMap();
      if (announce) {
        Toast.ok(result.origin === 'game' ? 'Read your keybinds from Ashtonk!mania' : 'Used the documented defaults', 'Lane mapping');
      }
    } catch (err) {
      Toast.error(describeError(err), 'Could not read keybinds');
    }
  }

  /* ── run controls ─────────────────────────────────────────────────── */

  const runStats = {
    state: stat({ label: 'Session', value: 'idle', accent: true }),
    planned: stat({ label: 'Events planned', value: '—' }),
    executed: stat({ label: 'Events executed', value: '—' }),
    backend: stat({ label: 'Backend', value: '—' }),
  };

  const startButton = button({ label: 'Arm and start', icon: 'bolt', variant: 'primary', onClick: () => startRun() });
  const pauseButton = button({ label: 'Pause input', icon: 'pause', onClick: () => pauseRun() });
  const resumeButton = button({ label: 'Resume', icon: 'play', onClick: () => resumeRun() });
  const stopButton = button({ label: 'Stop', icon: 'stop', onClick: () => stopRun() });
  const emergencyButton = button({
    label: 'Release all keys', icon: 'power', variant: 'danger',
    tooltip: 'Emergency stop: releases every key on every backend immediately (Esc)',
    onClick: () => emergencyStop('button'),
  });

  const anchorSegment = segmented({
    label: 'Start anchor', value: 'gameClock',
    options: [
      { id: 'gameClock', label: 'Game clock', tooltip: 'Begin when Ashtonk!mania’s own audio clock reaches the start time — the accurate option' },
      { id: 'now', label: 'After a lead-in', tooltip: 'Begin a fixed lead-in after arming; used when there is no game clock to anchor to' },
    ],
    onChange: () => {},
  });

  const startSlider = slider({
    label: 'Start at', min: 0, max: 600000, step: 100, value: 0,
    format: (v) => formatDuration(v),
    hint: 'Chart time the schedule starts from. Notes before it are not played.',
  });
  const leadSlider = slider({
    label: 'Lead-in', min: 50, max: 5000, step: 50,
    value: prefs.get('simulation.leadMs'), format: (v) => `${Math.round(v)} ms`,
    onChange: (v) => prefs.set('simulation.leadMs', v),
  });
  const rateSlider = slider({
    label: 'Playback speed', min: 0.25, max: 2, step: 0.05,
    value: prefs.get('practice.defaultRate'), format: (v) => formatRate(v),
    hint: 'The schedule is compressed by this rate; the game must be at the same speed or notes will not line up.',
    onChange: (v) => prefs.set('practice.defaultRate', v),
  });

  const previewBody = h('div.code', { style: { maxHeight: '180px' } });
  const previewStats = h('div.grid.grid--4');
  const previewWarnings = h('div.stack', { style: { gap: '4px' } });

  const runPanel = panel({
    title: 'Run', icon: 'bolt',
    body: h('div.stack',
      h('div.grid.grid--4', ...Object.values(runStats).map((s) => s.root)),
      h('div.row.row--wrap', { style: { gap: '6px' } }, startButton, pauseButton, resumeButton, stopButton, h('div.grow'), emergencyButton),
      h('div.grid.grid--2', anchorSegment.root, rateSlider.root),
      h('div.grid.grid--2', startSlider.root, leadSlider.root),
      previewWarnings,
      h('div.stack',
        h('div.label-upper', 'Schedule preview'),
        previewStats,
        previewBody,
      ),
      button({ label: 'Rebuild preview', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => buildPreview(true) }),
    ),
  });

  /* ── live key display ─────────────────────────────────────────────── */

  const liveRow = h('div.keycaps');
  const livePanel = panel({
    title: 'Keys', icon: 'keyboard',
    subtitle: 'your physical presses, and what ManiaFlow sends',
    body: h('div.stack',
      liveRow,
      h('div.xs.muted', 'Press a key anywhere in ManiaFlow to see it here. This is a mapping check — it does not send anything to the game.'),
    ),
  });

  function renderLiveKeys() {
    clear(liveRow);
    liveKeys.clear();
    const codes = [...new Set((keyMap || []).flat())];
    for (const code of codes) {
      const lane = keyMap.findIndex((list) => list.includes(code));
      const cap = keycap({ label: keyLabel(code), tooltip: lane >= 0 ? `Lane ${lane + 1}` : 'Not bound to a lane' });
      liveRow.append(cap.root);
      liveKeys.set(code, cap);
    }
  }

  /* ── errors ───────────────────────────────────────────────────────── */

  const errorBody = h('div.stack', { style: { gap: '4px' } });
  const errorPanel = panel({ title: 'Input errors', icon: 'alert', body: errorBody });

  function renderErrors() {
    clear(errorBody);
    const described = scheduler()?.describe();
    const errors = [];
    if (described?.lastError) errors.push(described.lastError);
    const gate = described?.gate;
    if (gate && !gate.ok) errors.push({ message: gate.reason, code: ErrorCode.INPUT_GATE_REFUSED });
    if (!errors.length) {
      errorBody.append(h('div.small.muted', 'No input errors. A refusal is reported here with the reason the game or the backend gave, in its own words.'));
      return;
    }
    for (const error of errors) {
      errorBody.append(note({
        variant: 'warn', icon: 'alert',
        title: error.code === ErrorCode.INPUT_GATE_REFUSED ? 'Refused by the safety gate' : error.code || 'Input error',
        text: error.message,
      }));
    }
  }

  /* ── layout ───────────────────────────────────────────────────────── */

  const root = h('div',
    h('div.page__head-row',
      h('div.page__head',
        h('h1.page__title', 'Input Lab'),
        h('p.page__subtitle', 'A separate keyboard path for authorised local practice. It maps lanes to keys, verifies them, '
          + 'and sends real key events on a monotonic clock — never Ashtonk!mania’s own Auto.'),
      ),
      h('div.page__actions',
        button({ label: 'Timing Lab', icon: 'timing', size: 'sm', variant: 'ghost', onClick: () => navigate('timing') }),
      ),
    ),
    simulationBanner('A run below sends key events to Ashtonk!mania only when the game reports it is in its own practice mode. Practice records no input events and is never submitted for score verification.'),
    h('div.grid.grid--split',
      h('div.stack', gatePanel.root, mapPanel.root, runPanel.root, livePanel.root),
      h('div.stack', backendPanel.root, errorPanel.root),
    ),
  );

  /* ── actions ──────────────────────────────────────────────────────── */

  async function checkGate(announce = false) {
    const current = adapter();
    const control = scheduler();
    if (!current || !control) {
      gateDot.set({ level: 'idle', label: 'No integration' });
      setText(gateReason, 'No integration is configured. ManiaFlow can still analyse and preview charts you import; sending input needs the in-page bridge.');
      return { ok: false };
    }
    let verdict;
    try {
      verdict = await current.checkGate();
    } catch (err) {
      verdict = { ok: false, reason: describeError(err) };
    }
    // The gate check is asynchronous and starts during construction. If the user has
    // navigated away while it was in flight, writing the answer into a detached page would
    // be work for nobody — and a toast about a screen they left.
    if (scope.disposed) return verdict;
    gateDot.set({
      level: verdict.ok ? 'ok' : verdict.local ? 'idle' : 'warn',
      label: verdict.ok ? 'Open — practice mode' : verdict.local ? 'Closed — no bridge' : 'Closed',
      live: verdict.ok,
    });
    setText(gateReason, verdict.ok
      ? 'The game reports it is in practice mode, running, with no Auto, no replay feed, no multiplayer and no spectating. Input may be armed.'
      : verdict.reason || 'Input is not permitted right now.');
    if (announce) {
      if (verdict.ok) Toast.ok('Gate open — the game is in practice mode', 'Safety gate');
      else Toast.warn(verdict.reason || 'The gate is closed', 'Safety gate');
    }
    renderErrors();
    updateRunButtons();
    return verdict;
  }

  function buildPreview(announce = false) {
    if (!record?.notes?.length) {
      clear(previewBody);
      setText(previewBody, 'Load a chart to build a schedule.');
      clear(previewStats);
      clear(previewWarnings);
      return null;
    }
    const mapCheck = validateKeyMapForBackend(keyMap, record.keys, registry()?.selected);
    clear(previewWarnings);
    if (!mapCheck.ok) {
      for (const problem of mapCheck.problems) previewWarnings.append(note({ variant: 'warn', icon: 'alert', text: problem }));
    }
    let schedule;
    try {
      schedule = buildInputSchedule({
        notes: record.notes,
        keyMap,
        rate: rateSlider.value,
        startChartTime: startSlider.value,
        latencyMs: prefs.get('input.compensateLatency') ? (adapter()?.gameState?.settings?.inputLatency ?? 0) : 0,
        seed: prefs.get('simulation.seed'),
        tapHoldMs: prefs.get('simulation.tapHoldMs'),
        minHoldMs: prefs.get('simulation.minHoldMs'),
        distribution: {
          kind: prefs.get('simulation.distribution'),
          sigmaMs: prefs.get('simulation.sigmaMs'),
          rangeMs: prefs.get('simulation.rangeMs'),
          biasMs: prefs.get('simulation.biasMs'),
          splitRatio: prefs.get('simulation.splitRatio'),
        },
      });
    } catch (err) {
      clear(previewBody);
      setText(previewBody, `A schedule could not be built: ${describeError(err)}`);
      clear(previewStats);
      return null;
    }

    const check = validateSchedule(schedule.events);
    if (!check.ok) {
      previewWarnings.append(note({ variant: 'warn', icon: 'alert', title: 'This schedule would be refused', text: check.problems[0] }));
    }
    for (const warning of schedule.warnings) {
      previewWarnings.append(note({ variant: 'warn', icon: 'alert', text: warning }));
    }

    clear(previewStats);
    previewStats.append(
      stat({ label: 'Events', value: formatCount(schedule.events.length) }).root,
      stat({ label: 'Notes scheduled', value: formatCount(schedule.stats.scheduledNotes) }).root,
      stat({ label: 'Notes skipped', value: formatCount(schedule.stats.skippedNotes) }).root,
      stat({ label: 'Real duration', value: formatDuration(schedule.stats.realDurationMs) }).root,
    );

    const lines = schedule.events.slice(0, 30)
      .map(([delay, code, down]) => `${delay.toFixed(3).padStart(10)} ms  ${code.padEnd(12)} ${down ? 'down' : 'up  '}`)
      .join('\n');
    setText(previewBody, lines + (schedule.events.length > 30 ? `\n\n… ${formatCount(schedule.events.length - 30)} more events` : ''));
    if (announce) Toast.ok(`Schedule built: ${formatCount(schedule.events.length)} events for ${formatCount(schedule.stats.scheduledNotes)} notes`, 'Preview');
    return schedule;
  }

  async function startRun() {
    const control = scheduler();
    if (!control) { Toast.error('No input system is configured.', 'Cannot start'); return; }
    if (!record?.notes?.length) { Toast.error('Load a chart first.', 'Cannot start'); return; }

    const verdict = await checkGate();
    if (!verdict.ok && prefs.get('input.requirePractice')) {
      Toast.error(verdict.reason || 'The safety gate is closed.', 'Refused');
      return;
    }

    const schedule = buildPreview();
    if (!schedule) return;
    const check = validateSchedule(schedule.events);
    if (!check.ok) { Toast.error(`The schedule is not valid: ${check.problems[0]}`, 'Refused'); return; }

    const gameRate = adapter()?.gameState?.gameplay?.rate;
    if (gameRate && Math.abs(gameRate - rateSlider.value) > 0.02) {
      const proceed = await Dialog.confirm({
        title: 'The speeds do not match',
        body: `ManiaFlow would schedule at ${formatRate(rateSlider.value)} but the game is running at ${formatRate(gameRate)}. `
          + 'Every note would land at the wrong moment. Set the game’s practice speed to match, or change the speed here.',
        confirmLabel: 'Start anyway', cancelLabel: 'Cancel', destructive: true,
      });
      if (!proceed) return;
    }

    try {
      startSlider.setValue(Math.max(0, startSlider.value));
      await control.start({
        notes: record.notes,
        keyMap,
        rate: rateSlider.value,
        startChartTime: startSlider.value,
        anchor: anchorSegment.value === 'now' ? 'now' : 'songPosition',
        leadMs: leadSlider.value,
        backendId: prefs.get('input.backend'),
      });
      Toast.ok(`Sending ${formatCount(schedule.events.length)} key events`, 'Input running');
    } catch (err) {
      Toast.error(describeError(err), 'Input refused');
    }
    renderRunState();
  }

  async function pauseRun() {
    const result = await scheduler()?.pause();
    if (result?.ok === false) Toast.info(result.reason || 'Nothing is running', 'Pause');
    else Toast.info('Keys released. The game keeps playing — ManiaFlow stopped sending. Resume rebuilds from the game’s current position.', 'Input paused');
    renderRunState();
  }

  async function resumeRun() {
    try {
      await scheduler()?.resume({ notes: record?.notes, keyMap });
    } catch (err) {
      Toast.error(describeError(err), 'Could not resume');
    }
    renderRunState();
  }

  async function stopRun() {
    await scheduler()?.stop('stopped by the user');
    Toast.ok('Input stopped and every key released', 'Stopped');
    renderRunState();
  }

  async function emergencyStop(reason) {
    const result = await scheduler()?.emergencyStop(reason);
    const released = result?.released?.length ?? 0;
    Toast.warn(released ? `Released ${released} key${released === 1 ? '' : 's'}` : 'No keys were held', 'Emergency stop');
    renderRunState();
  }

  async function testLane(lane) {
    const code = keyMap?.[lane]?.[0];
    if (!code) { Toast.error(`Lane ${lane + 1} has no key bound.`, 'Nothing to test'); return; }
    const control = scheduler();
    if (!control) return;
    try {
      if (!scheduler().describe().backend.armed) await control.arm({ backendId: prefs.get('input.backend') });
      const backend = registry().selected;
      const result = backend.id === BackendId.OS
        ? await backend.testKey(code, 40)
        : await context.adapter().input.testKey(code, 40);
      flashCap(lane);
      Toast.ok(`${keyLabel(code)} sent to lane ${lane + 1}${result?.trusted === false ? ' (synthetic, isTrusted false)' : ' (OS-level)'}`, 'Test key');
    } catch (err) {
      Toast.error(describeError(err), 'Test key failed');
    }
  }

  function flashCap(lane) {
    const cap = caps.get(lane);
    if (!cap) return;
    cap.setDown(true);
    setTimeout(() => cap.setDown(false), 140);
  }

  async function detectOs() {
    const backend = registry()?.os;
    if (!backend) { Toast.error('No integration is configured.', 'Detection unavailable'); return; }
    try {
      const result = await backend.detect();
      store.update({ osDetect: result });
      if (scope.disposed) return;
      renderBackend();
      renderMapProblems();
      if (result?.recommended) Toast.ok(`${result.recommended} is available on this machine`, 'OS input');
      else Toast.warn(result?.warnings?.[0] || 'No OS keyboard helper was found.', 'OS input');
    } catch (err) {
      Toast.error(describeError(err), 'Detection failed');
    }
  }

  async function armOs() {
    try {
      const result = await registry().os.arm();
      if (scope.disposed) return;
      Toast.ok(`Armed ${result.helperId}`, 'OS input');
      renderBackend();
      renderMapProblems();
    } catch (err) {
      Toast.error(describeError(err), 'Could not arm OS input');
      renderBackend();
    }
  }

  async function disarmOs() {
    try {
      await registry().os.disarm();
      Toast.ok('OS input disarmed and all keys released', 'OS input');
    } catch (err) {
      Toast.error(describeError(err), 'Could not disarm');
    }
    renderBackend();
  }

  /* ── state rendering ──────────────────────────────────────────────── */

  function renderRunState() {
    const described = scheduler()?.describe();
    const state = described?.state || InputState.IDLE;
    runStats.state.setValue(state);
    runStats.backend.setValue(described?.backend?.id === 'os'
      ? `OS · ${described.backend.helperId || 'not armed'}`
      : 'Synthetic');
    runStats.planned.setValue(described?.session ? formatCount(described.session.plannedEvents) : '—');
    runStats.executed.setValue(described?.lastRun?.executed != null ? formatCount(described.lastRun.executed) : '—');
    updateRunButtons();
    renderErrors();
  }

  function updateRunButtons() {
    const described = scheduler()?.describe();
    const state = described?.state || InputState.IDLE;
    const gateOpen = described?.gate?.ok;
    const hasChart = !!record?.notes?.length;

    setDisabled(startButton, !hasChart || state === InputState.RUNNING || state === InputState.ARMING,
      !hasChart ? 'Load a chart first' : state === InputState.RUNNING ? 'A run is already in progress' : null);
    setDisabled(pauseButton, state !== InputState.RUNNING, 'Nothing is running');
    setDisabled(resumeButton, state !== InputState.PAUSED, 'Nothing is paused');
    setDisabled(stopButton, state === InputState.IDLE, 'Nothing to stop');
    // The emergency stop is never disabled: it is the control you reach for when something
    // else has already gone wrong.
    setDisabled(emergencyButton, false);
    startButton.dataset.tooltip = gateOpen
      ? 'Check the gate, arm the backend and send the schedule'
      : 'The gate is closed — input would be refused. Start practice mode in the game first.';
  }

  /* ── physical key capture ─────────────────────────────────────────── */

  const onKeyDown = (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]')) return;

    if (captureLane != null) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { cancelCapture(); return; }
      if (event.repeat) return;
      void applyCapture(event.code);
      return;
    }

    // Show the press on the live keycaps, and light the lane it belongs to.
    if (!event.repeat) {
      liveKeys.get(event.code)?.setDown(true);
      const lane = keyMap?.findIndex((codes) => codes.includes(event.code)) ?? -1;
      if (lane >= 0) caps.get(lane)?.setDown(true);
    }
    if (event.code === 'Escape' && scheduler()?.isRunning) {
      event.preventDefault();
      void emergencyStop('Escape');
    }
  };
  const onKeyUp = (event) => {
    liveKeys.get(event.code)?.setDown(false);
    const lane = keyMap?.findIndex((codes) => codes.includes(event.code)) ?? -1;
    if (lane >= 0) caps.get(lane)?.setDown(false);
  };
  scope.on(window, 'keydown', onKeyDown);
  scope.on(window, 'keyup', onKeyUp);

  /* ── wiring ───────────────────────────────────────────────────────── */

  async function loadChart(next) {
    if (scope.disposed) return;
    record = next;
    if (!record) {
      keyMap = null;
      renderKeyMap();
      renderLiveKeys();
      buildPreview();
      startSlider.setValue(0, { silent: true });
      return;
    }
    startSlider.input.max = String(Math.max(1000, Math.round(record.length || 60000)));
    await readKeybinds(false);
    renderLiveKeys();
    buildPreview();
  }

  scope.defer(store.subscribe((s) => s.loadedChart, (next) => { void loadChart(next); }));
  scope.defer(store.subscribe((s) => s.input, () => renderRunState()));
  scope.defer(store.subscribe((s) => s.integration, (status) => {
    renderBackend();
    if (status?.level !== Level.UNAVAILABLE) void checkGate(false);
    else {
      gateDot.set({ level: 'idle', label: 'No integration' });
      setText(gateReason, 'No bridge is connected. Install it from Settings → Integration, or use ManiaFlow offline for analysis and preview only.');
    }
  }));
  scope.defer(store.subscribe((s) => s.gameState, () => { void checkGate(false); }, { immediate: false }));
  scope.defer(store.subscribe((s) => s.osDetect, () => renderBackend(), { immediate: false }));

  scope.defer(prefs.on('change', ({ key }) => {
    if (key === 'input.backend') { renderBackend(); renderMapProblems(); updateRunButtons(); }
    if (key.startsWith('simulation.')) buildPreview();
    if (key === 'input.requirePractice') void checkGate(false);
  }));

  void loadChart(store.state.loadedChart);
  renderBackend();
  renderRunState();
  void checkGate(false);

  return {
    root,
    onChart(next) { void loadChart(next); },
    dispose() {
      cancelCapture();
      // Leaving the screen releases keys but does not disarm an OS helper: the user may have
      // armed it deliberately and re-arming needs a detection round trip.
      scheduler()?.emergencyStop('left the Input Lab').catch(() => {});
      scope.dispose();
    },
  };
}
