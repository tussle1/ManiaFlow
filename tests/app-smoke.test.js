/**
 * Application smoke test.
 *
 * There is no browser here, so this mounts the real application against the DOM stub in
 * tests/helpers/dom-stub.js. It is not a visual test and does not claim to be: what it
 * proves is that the app boots, that every page constructs without throwing, that pages
 * tear down without leaving listeners or animation frames behind, and that a chart flows
 * from a file through the parser into a rendered frame.
 *
 * Those are the failures that make a project "start successfully" a false claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { installDom, FakeWebSocket, MemoryStorage } from './helpers/dom-stub.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const CONFIG = { version: '1.0.0', token: 'a'.repeat(48), wsPath: '/ws', origin: 'http://127.0.0.1:4310', osInput: { platform: 'linux' } };

/** A DOM plus a real store, preferences, session storage and adapter, wired as App does. */
async function harness(options = {}) {
  FakeWebSocket.reset();
  const dom = installDom({
    fetch: async (url) => (String(url).includes('/api/config')
      ? { ok: true, status: 200, json: async () => CONFIG }
      : { ok: false, status: 404, json: async () => ({}) }),
    ...options.dom,
  });

  const { Store, initialAppState } = await import('../src/app/state.js');
  const { PreferencesStore } = await import('../src/storage/PreferencesStore.js');
  const { SessionStore } = await import('../src/storage/SessionStore.js');
  const { SessionRecorder } = await import('../src/analytics/SessionRecorder.js');
  const { BridgeClient } = await import('../src/game/bridgeClient.js');
  const { AshtonKmaniaAdapter } = await import('../src/game/AshtonKmaniaAdapter.js');
  const { KeyboardAdapterRegistry } = await import('../src/input/KeyboardAdapter.js');
  const { InputScheduler } = await import('../src/input/InputScheduler.js');

  const store = new Store(initialAppState());
  const prefs = new PreferencesStore({ storage: options.storage ?? new MemoryStorage() });
  prefs.load();
  const sessions = new SessionStore();
  await sessions.init();
  const recorder = new SessionRecorder(sessions);
  const client = new BridgeClient({ url: 'ws://127.0.0.1:4310/ws', token: CONFIG.token });
  const adapter = new AshtonKmaniaAdapter({ client, options: { inputBackend: 'synthetic', requirePractice: true } });
  adapter.attach();
  const registry = new KeyboardAdapterRegistry(adapter);
  const scheduler = new InputScheduler({ registry, adapter, preferences: prefs, gameClock: () => null });

  const context = {
    store, prefs, sessions, recorder,
    client: () => client, adapter: () => adapter, input: () => scheduler, registry: () => registry,
    navigate: () => {}, toast: null, dialog: null,
    actions: {
      importFiles: async () => {}, openChart: async (r) => { store.update({ loadedChart: r, selectedChartId: r?.id ?? null }); return r; },
      refreshLibrary: async () => [], refreshSessions: async () => { store.update({ sessions: await sessions.list({ limit: 400 }) }); },
      removeChart: () => 0, clearCharts: async () => 0, recordAnalysis: async () => null,
      reconnect: async () => true, exportSessions: async () => null, showShortcuts: () => {},
      setStatus: (m) => store.update({ statusMessage: m }),
    },
  };

  // `raw` holds the instances themselves; the top level keeps the context's shape, where
  // client/adapter/input/registry are accessor functions. Overwriting one with the other is
  // exactly the kind of mistake this test exists to catch.
  return { ...dom, ...context, raw: { client, adapter, registry, scheduler }, store, prefs, sessions, recorder };
}

/** A parsed chart record, built the way the importer builds one. */
async function makeRecord(name = 'basic-4k.osu') {
  const { importOsuText } = await import('../src/chart/ChartImporter.js');
  return importOsuText(fixture(name), { fileName: name });
}

/* ── boot ────────────────────────────────────────────────────────────── */

test('the application boots, builds its shell and lands on the dashboard', async () => {
  const env = await harness();
  try {
    const { App } = await import('../src/app/App.js');
    const root = env.document.createElement('div');
    root.id = 'app';
    env.document.body.append(root);

    const app = new App(root);
    await app.start();

    assert.equal(root.classList.contains('app'), true, 'the shell class is applied');
    assert.equal(root.hasAttribute('aria-busy'), false, 'the busy flag is cleared once mounted');
    assert.ok(root.querySelector('.sidebar'), 'a sidebar is present');
    assert.ok(root.querySelector('.topbar'), 'a top bar is present');
    assert.ok(root.querySelector('.statusbar'), 'a status area is present');
    assert.ok(root.querySelector('main.app__main'), 'a main region is present');

    assert.equal(app.store.state.ready, true);
    assert.equal(app.store.state.route, 'dashboard');
    assert.equal(app.store.state.bridgeToken, CONFIG.token);
    assert.ok(app.store.state.integration, 'an integration status was produced');
    assert.equal(app.store.state.bootError, null, 'no boot error');
    assert.ok(root.querySelector('.page'), 'the dashboard page mounted');

    app.dispose();
    assert.equal(env.frameCount(), 0, 'no animation frames survive disposal');
  } finally {
    env.uninstall();
  }
});

test('a missing server configuration is reported, and the app still starts', async () => {
  const env = await harness({ dom: { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) } });
  try {
    const { App } = await import('../src/app/App.js');
    const root = env.document.createElement('div');
    env.document.body.append(root);
    const app = new App(root);
    await app.start();

    assert.equal(app.store.state.ready, true, 'the app is usable without a server');
    assert.match(app.store.state.bootError, /could not read the ManiaFlow server configuration/i);
    assert.equal(app.client, null, 'no integration is invented when there is no token');
    assert.ok(root.querySelector('.page'), 'and the dashboard still renders');
    app.dispose();
  } finally {
    env.uninstall();
  }
});

/* ── every page ──────────────────────────────────────────────────────── */

const PAGES = [
  ['dashboard', '../src/pages/Dashboard.js', 'createDashboardPage'],
  ['library', '../src/pages/ChartLibrary.js', 'createChartLibraryPage'],
  ['practice', '../src/pages/PracticeStudio.js', 'createPracticeStudioPage'],
  ['timing', '../src/pages/TimingLab.js', 'createTimingLabPage'],
  ['input', '../src/pages/InputLab.js', 'createInputLabPage'],
  ['statistics', '../src/pages/Statistics.js', 'createStatisticsPage'],
  ['settings', '../src/pages/Settings.js', 'createSettingsPage'],
];

for (const [id, path, factoryName] of PAGES) {
  test(`the ${id} page mounts, renders and tears down cleanly`, async () => {
    const env = await harness();
    try {
      const module = await import(path);
      const factory = module[factoryName];
      assert.equal(typeof factory, 'function', `${path} exports ${factoryName}`);

      const baseline = env.listenerCount();
      const page = factory(env);
      assert.ok(page.root instanceof env.Element, 'the page produced a root element');
      assert.equal(typeof page.dispose, 'function', 'the page can be disposed');

      // It rendered something: an empty root would mean the page silently drew nothing.
      assert.ok(page.root.children.length > 0, 'the page rendered content');
      env.document.body.append(page.root);

      page.dispose();
      assert.equal(env.listenerCount(), baseline, 'every window/document listener was removed');
      assert.equal(env.frameCount(), 0, 'no animation frame was left running');
    } finally {
      env.uninstall();
    }
  });

  test(`the ${id} page handles a loaded chart without throwing`, async () => {
    const env = await harness();
    try {
      const module = await import(path);
      const record = await makeRecord('basic-4k.osu');
      env.store.update({ charts: [record], loadedChart: record, selectedChartId: record.id });

      const page = module[factoryName](env);
      env.document.body.append(page.root);
      await new Promise((r) => setTimeout(r, 0));
      page.onChart?.(record);
      page.onParams?.(new URLSearchParams(''));
      await new Promise((r) => setTimeout(r, 0));

      // Feed it the harder fixtures too: holds, chords, spinners and SV changes.
      for (const name of ['chords-jacks.osu', 'sv-changes.osu', 'spinners-8k.osu', 'sliders.osu']) {
        const harder = await makeRecord(name);
        env.store.update({ loadedChart: harder, selectedChartId: harder.id, charts: [record, harder] });
        page.onChart?.(harder);
        await new Promise((r) => setTimeout(r, 0));
      }
      page.dispose();
    } finally {
      env.uninstall();
    }
  });

  test(`the ${id} page survives a chart it cannot preview`, async () => {
    const env = await harness();
    try {
      const module = await import(path);
      const { importOsuText } = await import('../src/chart/ChartImporter.js');
      const unsupported = importOsuText(fixture('mode-taiko.osu'), { fileName: 'mode-taiko.osu' });
      assert.equal(unsupported.previewable, false, 'a taiko chart really is not previewable');
      env.store.update({ charts: [unsupported], loadedChart: unsupported, selectedChartId: unsupported.id });

      const page = module[factoryName](env);
      env.document.body.append(page.root);
      page.onChart?.(unsupported);
      await new Promise((r) => setTimeout(r, 0));
      page.dispose();
    } finally {
      env.uninstall();
    }
  });
}

/* ── the preview actually draws ──────────────────────────────────────── */

test('the practice stage draws notes, and only the notes in range', async () => {
  const env = await harness();
  try {
    const { StageRenderer } = await import('../src/components/ChartCanvas.js');
    const { TimingEngine } = await import('../src/playback/TimingEngine.js');
    const { scrollSegments, redTimingPoints, barLines, toNotes, keyCount, parseOsu } = await import('../src/chart/ChartParser.js');

    const chart = parseOsu(fixture('chords-jacks.osu'));
    const notes = toNotes(chart, keyCount(chart));
    const timing = new TimingEngine({ segments: scrollSegments(chart, {}), red: redTimingPoints(chart) });

    const canvas = env.document.createElement('canvas');
    canvas.clientWidth = 700;
    canvas.clientHeight = 420;
    env.document.body.append(canvas);

    const renderer = new StageRenderer(canvas, { timing });
    renderer.setChart({ notes, keys: notes.keys, barlines: barLines(redTimingPoints(chart), 4000) });

    renderer.draw(0);
    const ctx = canvas.getContext('2d');
    const afterFirst = { ...ctx._calls };
    assert.ok(afterFirst.fillRect > 0, 'something was painted');

    // At t=0 the notes at 3500ms are far outside the visible time range, so a culled
    // renderer draws fewer rects than one drawing the whole chart.
    renderer.setOptions({ cull: false });
    renderer.invalidate();
    renderer.draw(0);
    const uncalled = { ...ctx._calls };
    assert.ok(uncalled.fillRect > afterFirst.fillRect, 'culling really does skip off-screen notes');

    // A note at its own time lands on the receptor.
    const g = renderer.geometry();
    const y = timing.yFor(1000, 1000, { receptorY: g.receptorY, travelPx: g.travelPx });
    assert.equal(Math.round(y), Math.round(g.receptorY));
    renderer.dispose();
  } finally {
    env.uninstall();
  }
});

/* ── integration wiring ──────────────────────────────────────────────── */

test('a bridge that connects is reflected in the integration status', async () => {
  const env = await harness();
  try {
    env.raw.client.connect();
    await new Promise((r) => setTimeout(r, 5));
    const socket = FakeWebSocket.instances[0];
    assert.ok(socket, 'a WebSocket was opened');
    assert.deepEqual(socket.lastSent, { type: 'hello', role: 'app', token: CONFIG.token });

    socket.simulateMessage({ type: 'hello:ok', role: 'app', clientId: 'c1', hub: { bridgeConnected: false, bridge: null, appClients: 1 } });
    assert.equal(env.raw.client.state, 'ready');
    assert.equal(env.raw.client.isConnected, true);

    socket.simulateMessage({
      type: 'bridge:status',
      payload: {
        bridgeConnected: true, appClients: 1,
        bridge: { bridgeVersion: '1.0.0', gameVersion: null, url: 'https://ashtonkmania.vercel.app/', origin: 'https://ashtonkmania.vercel.app', capabilities: ['state', 'library'], connectedAt: Date.now() },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(env.raw.client.bridgeConnected, true);

    socket.simulateMessage({
      type: 'relay', from: 'bridge',
      message: {
        type: 'bridge:state',
        payload: {
          available: true, screen: 'songselect', busy: false, safeMode: false,
          gameplay: { active: false },
          clock: { playing: false, rate: 1, songPosition: 0, gameTime: 0, gen: 0, duration: 0 },
          settings: { audioOffset: 0, inputLatency: 0, practiceSpeed: 1 },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const status = env.raw.adapter.status;
    assert.equal(status.links.find((l) => l.id === 'bridge').ok, true);
    assert.equal(status.links.find((l) => l.id === 'game').ok, true);
    assert.equal(status.screen, 'songselect');
    assert.equal(status.capabilities.readLibrary, true);
    assert.equal(status.capabilities.syntheticInput, false, 'input is not allowed on song select');

    // Practice mode opens the gate.
    socket.simulateMessage({
      type: 'relay', from: 'bridge',
      message: { type: 'bridge:state', payload: { available: true, screen: 'gameplay', gameplay: { active: true, practice: true, running: true, keys: 4, rate: 1, mode: 'practice' }, clock: { playing: true, rate: 1, gameTime: 1200 }, settings: {} } },
    });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(env.raw.adapter.status.capabilities.syntheticInput, true);
    assert.equal(env.raw.adapter.status.practice, true);

    env.raw.client.dispose();
  } finally {
    env.uninstall();
  }
});

test('input is refused while the game is not in practice mode', async () => {
  const env = await harness();
  try {
    const record = await makeRecord('basic-4k.osu');
    env.store.update({ loadedChart: record });

    // No bridge at all.
    const local = env.raw.adapter.localGate();
    assert.equal(local.ok, false);
    assert.match(local.reason, /No gameplay session/);

    await assert.rejects(
      () => env.raw.scheduler.start({ notes: record.notes, keyMap: [[ 'KeyD' ], ['KeyF'], ['KeyJ'], ['KeyK']] }),
      (err) => {
        assert.match(err.message, /practice mode|No bridge|No gameplay/i);
        return true;
      },
    );
    assert.equal(env.raw.scheduler.state, 'error', 'a refused run leaves the scheduler in a known state, not a running one');
    assert.ok(env.raw.scheduler.lastError, 'and the reason is kept for the UI');

    env.raw.client.dispose();
    env.raw.scheduler.dispose();
  } finally {
    env.uninstall();
  }
});

/* ── example charts, end to end ──────────────────────────────────────── */

test('the example charts load from disk through the real parser into the store', async () => {
  // Served from the actual files on disk, so this exercises manifest → fetch → parse →
  // record → store, not a mock of any of it.
  const examples = async (url) => {
    const path = String(url).replace(/^\.\//, '');
    if (path === 'api/config') return { ok: true, status: 200, json: async () => CONFIG };
    if (path.startsWith('examples/')) {
      const name = path.slice('examples/'.length);
      try {
        const text = readFileSync(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), 'utf8');
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
      } catch {
        return { ok: false, status: 404, json: async () => ({}) };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const env = await harness({ dom: { fetch: examples } });
  try {
    const { App } = await import('../src/app/App.js');
    const root = env.document.createElement('div');
    env.document.body.append(root);
    const app = new App(root);
    await app.start();

    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/index.json', import.meta.url)), 'utf8'));
    const loaded = await app.loadExamples();

    assert.equal(loaded.length, manifest.charts.length, 'every listed example loaded');
    assert.equal(app.store.state.charts.length, manifest.charts.length);
    assert.ok(app.store.state.loadedChart, 'and the first one was opened');
    assert.equal(app.store.state.loadedChart.isExample, true, 'an example is labelled as one');

    for (const [index, record] of loaded.entries()) {
      const entry = manifest.charts[index];
      assert.equal(record.keys, entry.keys, `${entry.file}: the lane count matches what the manifest claims`);
      assert.ok(record.notes.length > 0, `${entry.file}: notes were parsed`);
      assert.equal(record.previewable, true, `${entry.file}: it can be previewed`);
      assert.equal(record.valid, true, `${entry.file}: it validates cleanly`);
      assert.equal(record.audioUrl, null, `${entry.file}: no audio is claimed for a chart that has none`);
      assert.equal(record.stars, null, `${entry.file}: and no star rating is invented`);
      assert.ok(record.analysis, `${entry.file}: analysis ran`);
      assert.ok(record.notes.byColumn.length === record.keys);
      // Notes are sorted, in range, and holds end after they start.
      for (let i = 1; i < record.notes.length; i++) {
        assert.ok(record.notes[i].time >= record.notes[i - 1].time, `${entry.file}: sorted`);
      }
      for (const note of record.notes) {
        assert.ok(note.col >= 0 && note.col < record.keys, `${entry.file}: lane in range`);
        assert.ok(note.end >= note.time, `${entry.file}: a hold does not end before it starts`);
      }
    }

    // Loading twice must not duplicate the library.
    await app.loadExamples();
    assert.equal(app.store.state.charts.length, manifest.charts.length, 'a second load replaces rather than duplicates');

    app.dispose();
  } finally {
    env.uninstall();
  }
});

test('a missing example is reported per file rather than failing the batch', async () => {
  const env = await harness({
    dom: {
      fetch: async (url) => {
        const path = String(url).replace(/^\.\//, '');
        if (path === 'api/config') return { ok: true, status: 200, json: async () => CONFIG };
        if (path === 'examples/index.json') {
          return { ok: true, status: 200, json: async () => ({ charts: [{ file: 'exists.osu' }, { file: 'gone.osu' }] }), text: async () => '' };
        }
        if (path === 'examples/exists.osu') {
          return { ok: true, status: 200, text: async () => readFileSync(fileURLToPath(new URL('../examples/neon-drift-4k.osu', import.meta.url)), 'utf8') };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
    },
  });
  try {
    const { App } = await import('../src/app/App.js');
    const root = env.document.createElement('div');
    env.document.body.append(root);
    const app = new App(root);
    await app.start();
    const loaded = await app.loadExamples();
    assert.equal(loaded.length, 1, 'the readable one still loaded');
    assert.equal(app.store.state.charts.length, 1);
    app.dispose();
  } finally {
    env.uninstall();
  }
});

/* ── teardown ────────────────────────────────────────────────────────── */

test('navigating between pages does not accumulate listeners', async () => {
  const env = await harness();
  try {
    const pages = [];
    for (const [, path, factoryName] of PAGES) {
      pages.push([(await import(path))[factoryName]]);
    }
    const baseline = env.listenerCount();
    const open = [];
    // Cycle through every page three times, disposing as a route change would.
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const [factory] of pages) {
        for (const previous of open.splice(0)) previous.dispose();
        open.push(factory(env));
      }
    }
    for (const page of open.splice(0)) page.dispose();
    assert.equal(env.listenerCount(), baseline, 'three full cycles left no listeners behind');
    assert.equal(env.frameCount(), 0, 'and no animation frames');
  } finally {
    env.uninstall();
  }
});
