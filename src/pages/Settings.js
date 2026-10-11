/**
 * Settings — rendered from the preference schema, not written by hand.
 *
 * The controls on this page come from `PREFERENCES_SCHEMA`, which is also what supplies the
 * defaults and the clamping applied on every read and write. That is deliberate: a settings
 * screen written separately from the validation drifts, and the drift shows up as a control
 * that appears to work and a value that was silently replaced. Here, adding a preference is
 * one schema entry and the control, its bounds, its default and its reset all follow.
 *
 * Two sections are not schema-driven, because they are not preferences:
 *   Integration   live connection state, the bridge script, and OS input diagnostics
 *   Data          export, import, and the destructive actions, each behind a confirmation
 */

import { h, setText, clear, Scope } from '../utils/dom.js';
import { panel, note, definitionList, statusDot, tabs } from '../components/primitives.js';
import { button } from '../components/Button.js';
import { toggle, slider, selectInput, textInput, searchInput } from '../components/controls.js';
import { Toast } from '../components/Toast.js';
import { Dialog, confirm } from '../components/Dialog.js';
import { PREFERENCES_SCHEMA, ACCENTS, MOTION_MODES, SCHEMA_VERSION } from '../storage/PreferencesStore.js';
import { Level } from '../game/IntegrationStatus.js';
import { formatCount, formatRelative, formatDateTime, formatElapsed } from '../utils/formatters.js';
import { describeError } from '../utils/errors.js';
import { displayName } from '../chart/ChartRecord.js';
import { downloadJson } from '../app/App.js';
import { scrollSpeedToTimeRange } from '../playback/TimingEngine.js';
import { MIN_HOLD_MS, BOT_UNSTABLE_RATE, BOT_MIN_NOTES } from '../playback/Simulation.js';

const SECTIONS = ['Appearance', 'Practice', 'Timing', 'Simulation', 'Integration', 'Input', 'Performance', 'Data'];

export function createSettingsPage(context) {
  const { store, prefs, sessions, actions, navigate } = context;
  const scope = new Scope();

  const search = searchInput({
    placeholder: 'Filter settings…',
    ariaLabel: 'Filter settings',
    onInput: (value) => filterSettings(value.trim().toLowerCase()),
  });

  const tabBar = tabs({
    id: 'settings', label: 'Settings sections', active: 'Appearance',
    tabs: SECTIONS.map((section) => ({ id: section, label: section })),
    onChange: (id) => showSection(id),
  });

  const bodies = {};
  const panels = {};
  for (const section of SECTIONS) {
    const body = h('div.stack', { id: `settings-panel-${section}`, role: 'tabpanel', 'aria-labelledby': `settings-${section}` });
    bodies[section] = body;
  }

  /* ── schema-driven sections ───────────────────────────────────────── */

  const controls = new Map();   // preference key → { setValue, root }

  function buildSchemaSections() {
    for (const section of SECTIONS) {
      if (section === 'Data') continue;
      const entries = PREFERENCES_SCHEMA.filter((e) => e.section === section);
      const groups = new Map();
      for (const entry of entries) {
        const key = entry.group || section;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      }
      for (const [groupName, groupEntries] of groups) {
        const rows = groupEntries.map((entry) => buildControl(entry));
        panels[`${section}:${groupName}`] = panel({
          title: groupName,
          body: h('div.stack', { style: { gap: '14px' } }, ...rows),
        }).root;
        bodies[section].append(panels[`${section}:${groupName}`]);
      }
      if (section === 'Integration') bodies[section].append(integrationPanel.root);
      if (section === 'Input') bodies[section].append(safetyPanel.root);
      if (section === 'Performance') bodies[section].append(performancePanel.root);
    }
    bodies.Data.append(dataPanel.root);
  }

  function buildControl(entry) {
    const value = prefs.get(entry.key);
    let control;

    switch (entry.type) {
      case 'bool':
        control = toggle({
          label: entry.label, hint: entry.hint || entry.desc, value,
          onChange: (next) => applyPreference(entry.key, next),
        });
        break;
      case 'select':
        control = selectInput({
          label: entry.label, hint: entry.hint, value,
          options: (entry.options || []).map((o) => ({ id: o.id, label: o.label })),
          onChange: (next) => applyPreference(entry.key, next),
        });
        break;
      case 'range':
        control = slider({
          label: entry.label, hint: entry.hint, value,
          min: entry.min, max: entry.max, step: entry.step,
          format: formatterFor(entry),
          onChange: (next) => applyPreference(entry.key, next),
        });
        break;
      case 'int':
      case 'text':
        control = textInput({
          label: entry.label, hint: entry.hint, value: value == null ? '' : String(value),
          mono: entry.type === 'int', type: entry.type === 'int' ? 'number' : 'text',
          min: entry.min, max: entry.max, step: entry.step,
          onChange: (next) => applyPreference(entry.key, entry.type === 'int' ? Number.parseInt(next, 10) : next),
        });
        break;
      default:
        control = { root: note({ variant: 'warn', icon: 'alert', text: `The preference "${entry.key}" has an unsupported control type (${entry.type}).` }), setValue() {} };
    }

    const resetButton = button({
      icon: 'refresh', size: 'sm', variant: 'ghost',
      ariaLabel: `Reset ${entry.label} to its default`,
      tooltip: `Reset to ${describeDefault(entry)}`,
      onClick: () => {
        prefs.reset(entry.key);
        control.setValue?.(prefs.get(entry.key), { silent: true });
        Toast.ok(`${entry.label} reset to ${describeDefault(entry)}`, 'Preference reset');
      },
    });

    // One shape for every control type: the control grows, the reset button stays at the
    // right. A toggle already renders its own label, so it needs nothing extra here.
    const row = h('div.row', { style: { gap: '12px', alignItems: 'flex-start', justifyContent: 'space-between' } },
      h('div.grow', control.root), resetButton);
    row.dataset.search = `${entry.label} ${entry.group || ''} ${entry.hint || ''} ${entry.key}`.toLowerCase();

    controls.set(entry.key, { control, row, entry });
    return row;
  }

  function formatterFor(entry) {
    switch (entry.format) {
      case 'percent': return (v) => `${Math.round(v * 100)}%`;
      case 'ms': return (v) => `${v > 0 ? '+' : ''}${Math.round(v)} ms`;
      case 'hz': return (v) => `${Math.round(v)} Hz`;
      case 'fps': return (v) => (v === 0 ? 'Uncapped' : `${Math.round(v)} fps`);
      case 'count': return (v) => formatCount(v);
      case 'ratio': return (v) => v.toFixed(2);
      case 'scrollSpeed': return (v) => `${Math.round(v)} · ${Math.round(scrollSpeedToTimeRange(v))} ms`;
      default: return (v) => (Number.isInteger(entry.step || 1) ? String(Math.round(v)) : String(Math.round(v * 100) / 100));
    }
  }

  function describeDefault(entry) {
    if (entry.type === 'select') return entry.options?.find((o) => o.id === entry.default)?.label ?? String(entry.default);
    if (entry.type === 'bool') return entry.default ? 'on' : 'off';
    if (entry.format === 'percent') return `${Math.round(entry.default * 100)}%`;
    if (entry.format === 'scrollSpeed') return `${entry.default} (${Math.round(scrollSpeedToTimeRange(entry.default))} ms)`;
    return String(entry.default);
  }

  function applyPreference(key, value) {
    const result = prefs.set(key, value);
    if (!result.ok) {
      Toast.error(result.reason || `"${key}" could not be set`, 'Invalid value');
      controls.get(key)?.control.setValue?.(prefs.get(key), { silent: true });
      return;
    }
    if (result.clamped) {
      Toast.warn(`${labelFor(key)} was adjusted to ${describeValue(key, result.value)} — ${result.reason}`, 'Value clamped');
      controls.get(key)?.control.setValue?.(result.value, { silent: true });
    }
  }

  function labelFor(key) {
    return PREFERENCES_SCHEMA.find((e) => e.key === key)?.label || key;
  }

  function describeValue(key, value) {
    const entry = PREFERENCES_SCHEMA.find((e) => e.key === key);
    if (!entry) return String(value);
    if (entry.type === 'select') return entry.options?.find((o) => o.id === value)?.label ?? String(value);
    if (entry.type === 'bool') return value ? 'on' : 'off';
    if (entry.format === 'percent') return `${Math.round(value * 100)}%`;
    return `${value}${entry.format === 'ms' ? ' ms' : ''}`;
  }

  function filterSettings(query) {
    let matches = 0;
    for (const [, entry] of controls) {
      const haystack = entry.row.dataset.search || '';
      const hit = !query || haystack.includes(query);
      entry.row.style.display = hit ? '' : 'none';
      if (hit) matches++;
    }
    // Hide a group panel when nothing in it matches, so filtering does not leave empty boxes.
    for (const key of Object.keys(panels)) {
      const node = panels[key];
      if (!node) continue;
      const rows = [...node.querySelectorAll('[data-search]')];
      const anyVisible = rows.some((row) => row.style.display !== 'none');
      node.style.display = !query || anyVisible ? '' : 'none';
    }
    store.update({ statusMessage: query ? `${matches} setting${matches === 1 ? '' : 's'} match “${query}”` : null });
  }

  function showSection(section) {
    for (const name of SECTIONS) {
      const on = name === section;
      bodies[name].style.display = on ? '' : 'none';
      bodies[name].hidden = !on;
    }
  }

  /* ── integration ──────────────────────────────────────────────────── */

  const connectionBody = h('div.stack');
  const integrationPanel = panel({ title: 'Connection', icon: 'plug', body: connectionBody });

  function renderIntegration() {
    clear(connectionBody);
    const status = store.state.integration;
    const token = store.state.bridgeToken;
    const scriptUrl = store.state.bridgeScriptUrl;

    if (!status) {
      connectionBody.append(note({
        variant: 'warn', icon: 'alert', title: 'No integration is configured',
        text: store.state.bootError || 'The ManiaFlow server did not provide a bridge token. Start it with “npm start” and reload this page. '
          + 'Charts you import still work — analysis, preview and timing do not need the game.',
        actions: [button({ label: 'Try again', icon: 'refresh', size: 'sm', onClick: () => actions.reconnect() })],
      }));
      return;
    }

    const dot = statusDot({
      level: status.level === Level.OK ? 'ok' : status.level === Level.PARTIAL ? 'warn' : 'danger',
      label: status.label,
      live: status.level === Level.OK,
    });
    connectionBody.append(h('div.stack', { style: { gap: '8px' } },
      dot.root,
      h('div.small.dim', status.detail),
    ));

    const links = h('div.stack', { style: { gap: '4px' } });
    for (const link of status.links) {
      links.append(h('div.row', { style: { gap: '8px' } },
        h(`span.dot.dot--${link.ok ? 'ok' : link.optional ? 'idle' : 'danger'}`),
        h('span.small', { style: { minWidth: '140px' } }, link.label),
        h('span.small.muted.grow.truncate', link.detail || ''),
      ));
    }
    connectionBody.append(links);

    connectionBody.append(h('div.row.row--wrap', { style: { gap: '6px' } },
      button({ label: 'Reconnect', icon: 'refresh', size: 'sm', onClick: () => actions.reconnect() }),
      button({ label: 'Read the game library', icon: 'library', size: 'sm', variant: 'ghost', disabled: !status.capabilities?.readLibrary, onClick: () => actions.refreshLibrary() }),
      button({ label: 'Diagnostics', icon: 'bug', size: 'sm', variant: 'ghost', onClick: showDiagnostics }),
    ));

    // The bridge script, with this machine's token already in it.
    connectionBody.append(h('div.divider'));
    connectionBody.append(h('div.stack', { style: { gap: '6px' } },
      h('div.label-upper', 'Install the in-page bridge'),
      h('div.small.dim', 'ManiaFlow runs on 127.0.0.1 and Ashtonk!mania runs on its own domain. That is a cross-origin boundary '
        + 'browsers enforce, so ManiaFlow cannot read the game from outside. This script runs inside the game page and relays to '
        + 'ManiaFlow over the local WebSocket. You install it yourself, on purpose.'),
      h('div.row.row--wrap', { style: { gap: '6px' } },
        button({ label: 'Open the ready-made script', icon: 'external', size: 'sm', variant: 'primary', onClick: () => window.open(scriptUrl, '_blank', 'noopener') }),
        button({ label: 'Copy script URL', icon: 'copy', size: 'sm', variant: 'ghost', onClick: () => copyText(scriptUrl, 'Script URL') }),
        button({ label: 'Copy bridge token', icon: 'key', size: 'sm', variant: 'ghost', onClick: () => copyText(token, 'Bridge token') }),
        button({ label: 'Installation steps', icon: 'question', size: 'sm', variant: 'ghost', onClick: showBridgeHelp }),
      ),
      h('div.xs.muted', `Endpoint ${endpointFor(scriptUrl)} · preferences schema v${SCHEMA_VERSION}`),
      note({
        icon: 'shield',
        text: 'The token stops another page in your browser from posing as a bridge or reading your chart data. '
          + 'It is not a secret from anyone who can open this ManiaFlow UI, and it never leaves your machine.',
      }),
    ));

    // What the bridge reports, when one is connected.
    if (status.bridgeInfo) {
      connectionBody.append(h('div.divider'));
      const info = status.bridgeInfo;
      connectionBody.append(h('div.stack', { style: { gap: '4px' } },
        h('div.label-upper', 'Connected bridge'),
        definitionList([
          { label: 'Bridge version', value: info.bridgeVersion || '—', mono: true },
          { label: 'Game version', value: info.gameVersion || 'not reported', mono: true },
          { label: 'Page', value: info.origin || info.url || '—' },
          { label: 'Connected', value: info.connectedAt ? formatRelative(info.connectedAt) : '—' },
          { label: 'Round trip', value: status.latencyMs != null ? `${Math.round(status.latencyMs)} ms` : 'not measured yet', mono: true },
          { label: 'Capabilities', value: (info.capabilities || []).join(', ') || '—' },
        ]).root,
      ));
    }
  }

  /** The WebSocket address the bridge connects to, derived from the script URL. */
  function endpointFor(scriptUrl) {
    try {
      return scriptUrl ? `${new URL(scriptUrl).origin}/ws` : 'unavailable — the server did not provide one';
    } catch {
      return 'unavailable';
    }
  }

  function showBridgeHelp() {
    Dialog.info({
      title: 'Installing the bridge',
      size: 'wide',
      body: h('div.stack',
        h('p', 'The bridge is a small script that runs inside the Ashtonk!mania page. It reads the game’s own '
          + 'window.AshtonkMania surface and relays to ManiaFlow over the local WebSocket. It is the only supported way in: '
          + 'a page on 127.0.0.1 cannot read a page on another domain, and no browser allows it.'),
        h('div.label-upper', 'Option 1 — a userscript manager'),
        h('ol', { style: { paddingLeft: '18px', listStyle: 'decimal', display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('li', 'Install Tampermonkey or Violentmonkey in your browser.'),
          h('li', h('span', 'Create a new script and paste the contents of '), h('code.inline', '/bridge/installed.js'), h('span', ' — that copy already contains this machine’s token.')),
          h('li', 'Save it, then reload ashtonkmania.vercel.app. The console prints “[ManiaFlow] bridge loaded”.'),
        ),
        h('div.label-upper', 'Option 2 — DevTools, for a single session'),
        h('ol', { style: { paddingLeft: '18px', listStyle: 'decimal', display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('li', 'Open DevTools on the game page and paste the same script into the Console.'),
          h('li', 'It runs until the page is reloaded. Nothing is installed and nothing persists.'),
        ),
        h('div.label-upper', 'Option 3 — an extension content script'),
        h('p', 'Load it in the page’s MAIN world so it can see window.AshtonkMania. An isolated content script cannot.'),
        note({
          icon: 'info', title: 'What the bridge will and will not do',
          text: 'It relays read-only state and dispatches key events inside the game page. It never enables the game’s Auto mod, '
            + 'never calls its generateAutoInputs, and never writes to a gameplay session’s feed. It refuses to dispatch input '
            + 'unless the game reports its own practice mode.',
        }),
      ),
    });
  }

  async function copyText(text, what) {
    if (!text) { Toast.error(`There is no ${what.toLowerCase()} to copy.`, 'Nothing to copy'); return; }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        // A clipboard permission can be denied; a hidden field still works and says what it did.
        const area = h('textarea', { style: { position: 'fixed', opacity: '0' } });
        area.value = text;
        document.body.append(area);
        area.select();
        const ok = document.execCommand?.('copy');
        area.remove();
        if (!ok) throw new Error('copy command was refused');
      }
      Toast.ok(`${what} copied to the clipboard`, 'Copied');
    } catch (err) {
      Dialog.info({
        title: `Copy the ${what.toLowerCase()} manually`,
        body: h('div.stack', h('p.small.dim', `The clipboard is not available here (${describeError(err)}). Select and copy this:`), h('div.code', text)),
      });
    }
  }

  function showDiagnostics() {
    const adapter = context.adapter();
    const client = context.client();
    const data = adapter ? adapter.diagnostics() : null;
    Dialog.info({
      title: 'Integration diagnostics',
      size: 'wide',
      body: h('div.stack',
        h('div.label-upper', 'Connection'),
        h('pre.code', JSON.stringify(client?.describe() ?? { error: 'no client' }, null, 2)),
        h('div.label-upper', 'Game state'),
        h('pre.code', JSON.stringify(data?.game ?? null, null, 2)),
        h('div.label-upper', 'Library'),
        h('pre.code', JSON.stringify(data?.library ?? null, null, 2)),
        h('div.label-upper', 'OS input detection'),
        h('pre.code', JSON.stringify(data?.osDetect ?? store.state.osDetect ?? null, null, 2)),
        h('div.label-upper', 'Selected input backend'),
        h('pre.code', JSON.stringify(data?.inputBackend ?? null, null, 2)),
        h('div.label-upper', 'Preference health'),
        h('pre.code', JSON.stringify(prefs.health, null, 2)),
        h('div.label-upper', 'Session storage'),
        h('pre.code', JSON.stringify(store.state.sessionHealth, null, 2)),
      ),
    });
  }

  /* ── input safety panel ───────────────────────────────────────────── */

  const safetyPanel = panel({
    title: 'What the input system will not do',
    icon: 'shield',
    body: h('div.stack',
      note({
        variant: 'accent', icon: 'shield',
        text: 'ManiaFlow never uses Ashtonk!mania’s built-in Auto. It does not enable the AT mod, does not call the game’s '
          + 'generateAutoInputs, and never writes to a gameplay session’s feed. The keyboard path in the Input Lab is separate '
          + 'and it sends key events the game resolves by key code, exactly as a physical press would be resolved.',
      }),
      definitionList([
        { label: 'Gate', value: 'Arms only when the game reports practice mode, running, with no Auto, no replay feed, no multiplayer and no spectating' },
        { label: 'Minimum hold', value: `${MIN_HOLD_MS} ms — the game rejects a shorter press/release as impossible input`, mono: true },
        { label: 'Bot threshold', value: `Unstable rate below ${BOT_UNSTABLE_RATE} over ${BOT_MIN_NOTES}+ notes is rejected as inhuman timing`, mono: true },
        { label: 'Why practice', value: 'Practice mode records no input events and is never submitted for verification, so it cannot produce a ranked score' },
        { label: 'Synthetic input', value: 'isTrusted === false. The game accepts it; it is not hardware input and ManiaFlow does not claim otherwise' },
        { label: 'OS input', value: 'Genuine OS-level key events through a native helper. Needs the helper installed and the game window focused' },
        { label: 'On failure', value: 'Every key is released on stop, pause, error, gate loss, window blur, tab hide and page unload' },
      ]).root,
      note({
        variant: 'warn', icon: 'alert',
        text: 'Use this for local practice, accessibility, replay study or an explicitly authorised test environment. '
          + 'Do not use it to gain an advantage in public competitive play, and do not use it to evade anti-cheat.',
      }),
    ),
  });

  /* ── performance ──────────────────────────────────────────────────── */

  const perfBody = h('div.stack');
  const performancePanel = panel({ title: 'This machine', icon: 'gauge', body: perfBody });

  function renderPerformance() {
    clear(perfBody);
    const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const rows = [
      { label: 'Device pixel ratio', value: String(window.devicePixelRatio || 1), mono: true },
      { label: 'Canvas resolution cap', value: `${prefs.get('performance.pixelRatioCap')}×`, mono: true },
      { label: 'Viewport', value: `${window.innerWidth} × ${window.innerHeight}`, mono: true },
      { label: 'System reduce-motion', value: motionQuery ? (motionQuery.matches ? 'requested' : 'not requested') : 'unsupported', },
      { label: 'Animation preference', value: MOTION_MODES.find((m) => m.id === prefs.get('appearance.motion'))?.label || '—' },
      { label: 'WebSocket', value: typeof WebSocket === 'function' ? 'supported' : 'not supported' },
      { label: 'DecompressionStream', value: typeof DecompressionStream === 'function' ? 'supported — .osz archives can be opened' : 'not supported — import loose .osu files' },
      { label: 'IndexedDB', value: typeof indexedDB !== 'undefined' ? 'available' : 'not available' },
      { label: 'Active subscriptions', value: formatCount(store.subscriptionCount), mono: true },
    ];
    perfBody.append(definitionList(rows).root);
    perfBody.append(note({
      icon: 'info',
      text: 'These are read from the browser, not estimated. “Active subscriptions” is the number of store listeners currently '
        + 'registered across every open screen; it should fall when you leave a page, which is how you can see that teardown works.',
    }));
  }

  /* ── data ─────────────────────────────────────────────────────────── */

  const dataBody = h('div.stack');
  const dataPanel = panel({ title: 'Stored data', icon: 'save', body: dataBody });

  function renderData() {
    clear(dataBody);
    const list = store.state.sessions;
    const health = store.state.sessionHealth;
    const prefHealth = store.state.preferenceHealth;

    dataBody.append(h('div.grid.grid--2',
      panel({
        title: 'Session history', body: h('div.stack',
          definitionList([
            { label: 'Sessions stored', value: formatCount(list.length), mono: true },
            { label: 'Backend', value: health?.backend === 'indexeddb' ? 'IndexedDB' : health?.backend === 'localstorage' ? 'localStorage' : 'memory only' },
            { label: 'Oldest', value: list.length ? formatDateTime(list[list.length - 1].startedAt) : '—' },
            { label: 'Newest', value: list.length ? formatRelative(list[0].startedAt) : '—' },
            { label: 'Total recorded', value: formatElapsed(list.reduce((a, s) => a + (s.durationMs || 0), 0)) },
            { label: 'Retention', value: `${formatCount(prefs.get('performance.sessionHistoryLimit'))} sessions`, mono: true },
          ]).root,
          health?.reason ? note({ variant: 'warn', icon: 'alert', text: health.reason }) : null,
          h('div.row.row--wrap', { style: { gap: '6px' } },
            button({ label: 'Export all', icon: 'download', size: 'sm', onClick: () => actions.exportSessions() }),
            button({ label: 'Open Statistics', icon: 'statistics', size: 'sm', variant: 'ghost', onClick: () => navigate('statistics') }),
            button({ label: 'Delete all history', icon: 'trash', size: 'sm', variant: 'danger', onClick: () => clearSessions() }),
          ),
        ),
      }).root,
      panel({
        title: 'Preferences', body: h('div.stack',
          definitionList([
            { label: 'Schema version', value: `v${SCHEMA_VERSION}`, mono: true },
            { label: 'Preferences', value: formatCount(PREFERENCES_SCHEMA.length), mono: true },
            { label: 'Chart overrides', value: formatCount(prefs.overrides.size), mono: true },
            { label: 'Storage', value: prefs.health.available ? 'localStorage' : 'memory only' },
            { label: 'Recovered', value: prefs.health.recovered ? 'yes — invalid values were reset' : 'no' },
          ]).root,
          prefHealth?.reason ? note({ variant: 'warn', icon: 'alert', title: 'Preferences were recovered', text: prefHealth.reason }) : null,
          h('div.row.row--wrap', { style: { gap: '6px' } },
            button({ label: 'Export preferences', icon: 'download', size: 'sm', onClick: () => exportPreferences() }),
            button({ label: 'Import', icon: 'upload', size: 'sm', variant: 'ghost', onClick: () => prefsFile.click() }),
            button({ label: 'Reset everything', icon: 'refresh', size: 'sm', variant: 'danger', onClick: () => resetPreferences() }),
          ),
        ),
      }).root,
    ));

    dataBody.append(h('div.divider'));
    dataBody.append(panel({
      title: 'Charts in ManiaFlow',
      body: h('div.stack',
        definitionList([
          { label: 'Charts', value: formatCount(store.state.charts.length), mono: true },
          { label: 'From the game', value: formatCount(store.state.charts.filter((c) => c.source === 'bridge').length), mono: true },
          { label: 'Imported here', value: formatCount(store.state.charts.filter((c) => c.source !== 'bridge').length), mono: true },
          { label: 'Selected', value: store.state.loadedChart ? displayName(store.state.loadedChart) : 'none' },
        ]).root,
        h('div.xs.muted', 'Charts are held in this tab’s memory, not written to disk. Charts stored inside Ashtonk!mania are never modified or removed by ManiaFlow.'),
        h('div.row', button({ label: 'Remove all charts from ManiaFlow', icon: 'trash', size: 'sm', variant: 'danger', onClick: () => actions.clearCharts() })),
      ),
    }).root);

    dataBody.append(note({
      icon: 'shield',
      text: 'Everything ManiaFlow stores stays in this browser on this device: preferences in localStorage, session history in '
        + 'IndexedDB, imported charts in memory for the life of the tab. Nothing is uploaded, there is no account, and there is '
        + 'no analytics. The only network traffic is the local WebSocket to the ManiaFlow server you started yourself, and any '
        + 'request the game makes on its own behalf.',
    }));
  }

  const prefsFile = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  prefsFile.addEventListener('change', async () => {
    const file = prefsFile.files?.[0];
    prefsFile.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const result = prefs.import(data);
      if (!result.ok) { Toast.error(result.reason, 'Import failed'); return; }
      syncControlsFromPrefs();
      renderAll();
      Toast.ok(`Applied ${result.applied} preference${result.applied === 1 ? '' : 's'}${result.rejected.length ? `, ignored ${result.rejected.length}` : ''}`, 'Preferences imported');
    } catch (err) {
      Toast.error(describeError(err), 'Import failed');
    }
  });

  function exportPreferences() {
    downloadJson('maniaflow-preferences.json', prefs.export());
    Toast.ok('Preferences exported', 'Export');
  }

  async function resetPreferences() {
    const yes = await confirm({
      title: 'Reset every preference to its default?',
      body: `All ${PREFERENCES_SCHEMA.length} preferences and every per-chart key override return to their defaults. `
        + 'Session history and imported charts are not touched.',
      confirmLabel: 'Reset preferences', destructive: true, icon: 'refresh',
    });
    if (!yes) return;
    prefs.resetAll();
    syncControlsFromPrefs();
    renderAll();
    Toast.ok('Preferences reset to their defaults', 'Reset complete');
  }

  async function clearSessions() {
    const count = store.state.sessions.length;
    if (!count) { Toast.info('There is no recorded history to delete.', 'Data'); return; }
    const yes = await confirm({
      title: 'Delete all recorded history?',
      body: `This removes ${formatCount(count)} session record${count === 1 ? '' : 's'} and their measurements from this browser. `
        + 'Preferences and charts are kept. This cannot be undone.',
      confirmLabel: 'Delete everything', destructive: true, icon: 'trash',
    });
    if (!yes) return;
    try {
      await sessions.clear();
      await actions.refreshSessions();
      renderAll();
      Toast.ok(`Deleted ${formatCount(count)} sessions`, 'History cleared');
    } catch (err) {
      Toast.error(describeError(err), 'Could not clear history');
    }
  }

  function syncControlsFromPrefs() {
    for (const [key, entry] of controls) {
      entry.control.setValue?.(prefs.get(key), { silent: true });
    }
  }

  /* ── accent preview ───────────────────────────────────────────────── */

  const accentRow = h('div.row.row--wrap', { style: { gap: '6px' } });
  function buildAccentPicker() {
    for (const accent of ACCENTS) {
      const swatch = h('button.chip', {
        type: 'button', 'aria-label': `Accent colour: ${accent.label}`,
        'data-tooltip': accent.label,
        style: { gap: '6px' },
      });
      const dot = h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: `hsl(var(--accent-h) var(--accent-s) var(--accent-l))` } });
      swatch.append(dot, h('span', accent.label));
      swatch.addEventListener('click', () => {
        prefs.set('appearance.accent', accent.id);
        paintSwatches();
      });
      swatch.dataset.accent = accent.id;
      // The dot is painted per accent rather than from the live variable, so the picker shows
      // all six colours at once instead of six copies of the current one.
      const hue = { violet: 258, ice: 199, mint: 162, amber: 38, rose: 344, slate: 215 }[accent.id] ?? 258;
      const sat = accent.id === 'slate' ? '16%' : accent.id === 'mint' ? '62%' : accent.id === 'rose' ? '78%' : accent.id === 'amber' ? '88%' : '88%';
      const light = accent.id === 'ice' ? '62%' : accent.id === 'mint' ? '55%' : accent.id === 'amber' ? '62%' : accent.id === 'slate' ? '66%' : '67%';
      dot.style.background = `hsl(${hue} ${sat} ${light})`;
      accentRow.append(swatch);
    }
    paintSwatches();
  }
  function paintSwatches() {
    const current = prefs.get('appearance.accent');
    for (const node of accentRow.children) node.classList.toggle('is-on', node.dataset.accent === current);
  }

  /* ── layout ───────────────────────────────────────────────────────── */

  buildSchemaSections();
  buildAccentPicker();
  bodies.Appearance.prepend(panel({
    title: 'Accent colour',
    icon: 'note',
    body: h('div.stack', accentRow, h('div.xs.muted', 'One restrained accent, applied through a single hue variable. Everything tinted in the interface follows it.')),
  }).root);

  const root = h('div',
    h('div.page__head-row',
      h('div.page__head',
        h('h1.page__title', 'Settings'),
        h('p.page__subtitle', 'Preferences are validated on every write and stored in this browser. A value outside its range is '
          + 'clamped and you are told, rather than stored as given and silently replaced later.'),
      ),
      h('div.page__actions', search.root),
    ),
    tabBar.root,
    ...SECTIONS.map((section) => bodies[section]),
    prefsFile,
  );

  function renderAll() {
    renderIntegration();
    renderPerformance();
    renderData();
    paintSwatches();
  }

  showSection('Appearance');
  renderAll();

  /* ── wiring ───────────────────────────────────────────────────────── */

  scope.defer(store.subscribe((s) => s.integration, renderIntegration, { immediate: false }));
  scope.defer(store.subscribe((s) => s.osDetect, renderIntegration, { immediate: false }));
  scope.defer(store.subscribe((s) => s.sessions, renderData, { immediate: false }));
  scope.defer(store.subscribe((s) => s.charts, renderData, { immediate: false }));
  scope.defer(store.subscribe((s) => s.preferenceHealth, renderData, { immediate: false }));
  scope.defer(prefs.on('change', ({ key }) => {
    // A preference changed from another screen must be reflected here without re-firing.
    const entry = controls.get(key);
    if (entry) entry.control.setValue?.(prefs.get(key), { silent: true });
    if (key.startsWith('appearance.') || key.startsWith('performance.')) renderAll();
  }));

  const onResize = () => renderPerformance();
  scope.on(window, 'resize', onResize);

  return {
    root,
    onParams(params) {
      const section = params?.get?.('section');
      if (section && SECTIONS.includes(section)) { tabBar.select(section); showSection(section); }
    },
    focus: () => search.focus(),
    dispose: () => scope.dispose(),
  };
}
