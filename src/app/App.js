/**
 * App — the shell, and the only place the pieces are wired together.
 *
 * Everything below it receives a `context` and nothing else: the store, the preferences,
 * the session recorder, the game adapter, the input registry and a small set of shared
 * actions. A page never constructs an adapter or opens a WebSocket, which is what keeps
 * there being exactly one of each.
 *
 * Boot order matters and is explicit: configuration → preferences → storage → integration.
 * Each step can fail without stopping the next, because a ManiaFlow with no bridge and no
 * stored preferences is still a working chart analyser, and it should say so rather than
 * show a blank screen.
 */

import { Store, initialAppState, ROUTES, routeById } from './state.js';
import { Router } from './router.js';
import { h, Scope, installFocusMode, setText } from '../utils/dom.js';
import { PreferencesStore } from '../storage/PreferencesStore.js';
import { SessionStore } from '../storage/SessionStore.js';
import { SessionRecorder } from '../analytics/SessionRecorder.js';
import { BridgeClient } from '../game/bridgeClient.js';
import { AshtonKmaniaAdapter } from '../game/AshtonKmaniaAdapter.js';
import { KeyboardAdapterRegistry } from '../input/KeyboardAdapter.js';
import { InputScheduler } from '../input/InputScheduler.js';
import { createSidebar } from '../components/Sidebar.js';
import { createTopBar } from '../components/TopBar.js';
import { createStatusArea } from '../components/StatusArea.js';
import { installTooltips } from '../components/Tooltip.js';
import { Toast } from '../components/Toast.js';
import { Dialog, showError, confirm } from '../components/Dialog.js';
import { importFiles, importOsuText } from '../chart/ChartImporter.js';
import { toAppError, describeError, ErrorCode } from '../utils/errors.js';
import { displayFullName } from '../chart/ChartRecord.js';

/** Apply appearance preferences to the document root. */
export function applyAppearance(prefs) {
  const root = document.documentElement;
  root.dataset.theme = prefs.get('appearance.theme') || 'dark';
  root.dataset.accent = prefs.get('appearance.accent') || 'violet';
  root.dataset.density = prefs.get('appearance.density') || 'comfortable';
  root.dataset.contrast = prefs.get('appearance.contrast') ? 'high' : 'normal';
  const motion = prefs.get('appearance.motion') || 'auto';
  if (motion === 'auto') root.removeAttribute('data-motion');
  else root.dataset.motion = motion;
}

/** Pages are loaded on demand so the first paint is not waiting on all six of them. */
const PAGE_MODULES = {
  dashboard: () => import('../pages/Dashboard.js'),
  library: () => import('../pages/ChartLibrary.js'),
  practice: () => import('../pages/PracticeStudio.js'),
  timing: () => import('../pages/TimingLab.js'),
  input: () => import('../pages/InputLab.js'),
  statistics: () => import('../pages/Statistics.js'),
  settings: () => import('../pages/Settings.js'),
};

export class App {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.scope = new Scope();
    this.store = new Store(initialAppState());
    this.prefs = new PreferencesStore();
    this.sessions = new SessionStore();
    this.recorder = new SessionRecorder(this.sessions);
    this.router = new Router({ onChange: (routeId, params) => this.show(routeId, params) });

    this.client = null;
    this.adapter = null;
    this.inputRegistry = null;
    this.inputScheduler = null;

    this.page = null;
    this.pageId = null;
    this._loadingPage = null;
    this._focusFrame = 0;
    this._disposed = false;
    this.config = null;
  }

  /* ── boot ──────────────────────────────────────────────────────────── */

  async start() {
    installFocusMode(this.scope);
    this.scope.defer(installTooltips());
    this.buildShell();
    this.installGlobalHandlers();

    // 1. Preferences first: everything else reads them.
    this.prefs.load();
    applyAppearance(this.prefs);
    this.store.update({ preferenceHealth: this.prefs.health, unicodeMetadata: this.prefs.get('appearance.unicodeMetadata') });
    this.scope.defer(this.prefs.on('change', ({ key }) => {
      if (key.startsWith('appearance.')) applyAppearance(this.prefs);
      if (key === 'appearance.unicodeMetadata') this.store.update({ unicodeMetadata: this.prefs.get(key) });
      if (key === 'performance.sessionHistoryLimit') this.sessions.setLimit(this.prefs.get(key));
      if (key === 'integration.pollHz' && this.adapter?.client?.bridgeConnected) {
        this.adapter.subscribeState(this.prefs.get(key)).catch(() => {});
      }
    }));
    if (this.prefs.health.reason) {
      Toast.warn(this.prefs.health.reason, 'Preferences');
    }

    // 2. Session storage.
    this.sessions.setLimit(this.prefs.get('performance.sessionHistoryLimit'));
    const sessionHealth = await this.sessions.init().catch((err) => {
      this.store.update({ sessionHealth: { backend: 'memory', available: false, reason: describeError(err) } });
      return null;
    });
    if (sessionHealth) this.store.update({ sessionHealth });
    await this.refreshSessions();

    // 3. Server configuration, then the integration.
    await this.loadConfig();
    this.connectIntegration();

    this.store.update({ ready: true });
    // Awaited: `start()` resolving means a screen is on the page, not that one was asked for.
    await this.router.start();
    return this;
  }

  async loadConfig() {
    try {
      const response = await fetch('./api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.config = await response.json();
      this.store.update({
        bridgeToken: this.config.token || null,
        bridgeScriptUrl: `${window.location.origin}/bridge/installed.js`,
      });
    } catch (err) {
      // Without the token the bridge cannot authenticate, so integration is off — but the
      // rest of the app is unaffected and must still start.
      this.config = null;
      this.store.update({
        bootError: `Could not read the ManiaFlow server configuration: ${describeError(err)}. Charts you import still work offline.`,
      });
    }
  }

  connectIntegration() {
    if (!this.config?.token) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.client = new BridgeClient({
      url: `${protocol}//${window.location.host}${this.config.wsPath || '/ws'}`,
      token: this.config.token,
      requestTimeoutMs: this.prefs.get('integration.requestTimeoutMs'),
    });

    this.adapter = new AshtonKmaniaAdapter({
      client: this.client,
      options: {
        inputBackend: this.prefs.get('input.backend'),
        requirePractice: this.prefs.get('input.requirePractice'),
      },
    });
    this.inputRegistry = new KeyboardAdapterRegistry(this.adapter);
    this.inputScheduler = new InputScheduler({
      registry: this.inputRegistry,
      adapter: this.adapter,
      preferences: this.prefs,
      gameClock: () => this.adapter.gameState?.clock?.gameTime ?? null,
    });

    this.adapter.attach();
    this.store.update({
      integration: this.adapter.status,
      gameState: this.adapter.gameState,
    });

    this.scope.defer(this.adapter.on('status', (status) => {
      this.store.update({ integration: status, gameState: this.adapter.gameState });
    }));
    this.scope.defer(this.adapter.on('state', (gameState) => {
      this.store.update({ gameState });
      this.syncPlaybackToGame();
    }));
    this.scope.defer(this.adapter.on('library', ({ records, error }) => {
      this.store.update({ libraryError: error });
      if (records?.length) this.mergeCharts(records);
    }));
    this.scope.defer(this.adapter.on('error', (err) => {
      this.store.update({ statusMessage: describeError(err) });
    }));
    this.scope.defer(this.adapter.on('gate-lost', (reason) => {
      Toast.warn(reason || 'Practice mode ended', 'Input stopped');
    }));
    this.scope.defer(this.inputScheduler.on('state', () => {
      this.store.update({ input: this.inputScheduler.describe() });
    }));
    this.scope.defer(this.inputScheduler.on('complete', (run) => {
      this.store.update({ input: this.inputScheduler.describe() });
      this.recordInputRun(run);
    }));
    this.scope.defer(this.inputScheduler.on('refused', (err) => {
      this.store.update({ input: this.inputScheduler.describe() });
      Toast.error(err.message, 'Input refused');
    }));
    this.scope.defer(this.client.on('os-input', (message) => {
      if (message.type === 'os-input:detect:result') this.store.update({ osDetect: message.payload });
      if (message.type === 'os-input:error' && message.message) Toast.error(message.message, 'OS input');
      this.store.update({ integration: this.adapter.status });
    }));
    this.scope.defer(this.prefs.on('change', ({ key, value }) => {
      if (key === 'input.backend') this.adapter.options.inputBackend = value;
      if (key === 'input.requirePractice') this.adapter.options.requirePractice = value;
    }));

    if (this.prefs.get('integration.enabled')) this.client.connect();
    this.store.update({ integration: this.adapter.status });
  }

  /* ── shell ─────────────────────────────────────────────────────────── */

  buildShell() {
    this.sidebar = createSidebar({ store: this.store, onNavigate: (id) => this.navigate(id) });
    this.topbar = createTopBar({
      store: this.store,
      onNavigate: (id) => this.navigate(id),
      onShortcuts: () => this.showShortcuts(),
    });
    this.statusArea = createStatusArea({ store: this.store });
    this.main = h('main.app__main', { id: 'main', tabindex: '-1' });

    this.root.classList.add('app');
    this.root.removeAttribute('aria-busy');
    this.root.replaceChildren(this.sidebar.root, this.topbar.root, this.main, this.statusArea.root);
  }

  installGlobalHandlers() {
    // Drag & drop anywhere in the window imports charts, as the game itself does.
    let depth = 0;
    const onEnter = (event) => {
      if (!hasFiles(event)) return;
      depth++;
      this.root.classList.add('is-dropping');
      event.preventDefault();
    };
    const onOver = (event) => { if (hasFiles(event)) event.preventDefault(); };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.root.classList.remove('is-dropping');
    };
    const onDrop = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      this.root.classList.remove('is-dropping');
      this.importDrop(event.dataTransfer.files);
    };
    this.scope.on(window, 'dragenter', onEnter);
    this.scope.on(window, 'dragover', onOver);
    this.scope.on(window, 'dragleave', onLeave);
    this.scope.on(window, 'drop', onDrop);

    // Global shortcuts. They yield to anything already handling the key.
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const typing = target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]');

      if (event.key === '?' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        this.showShortcuts();
        return;
      }
      if (event.key === 'Escape') {
        if (Dialog.isOpen()) return;                 // the dialog owns Escape
        if (this.inputScheduler?.isRunning) {
          event.preventDefault();
          this.inputScheduler.emergencyStop('Escape');
          Toast.warn('All keys released', 'Input stopped');
          return;
        }
      }
      // Space toggles playback when nothing else is focused and no dialog is open.
      if (event.code === 'Space' && !typing && !Dialog.isOpen() && !(target instanceof HTMLButtonElement)) {
        const handled = this.page?.onSpace?.();
        if (handled) event.preventDefault();
      }
    };
    this.scope.on(window, 'keydown', onKeyDown);

    // Never leave a key down when the window goes away.
    const onUnload = () => {
      this.inputScheduler?.emergencyStop('window unloading').catch(() => {});
      this.prefs.flush();
    };
    this.scope.on(window, 'pagehide', onUnload);
    this.scope.on(window, 'beforeunload', onUnload);
  }

  /* ── navigation ────────────────────────────────────────────────────── */

  navigate(routeId, params = null) {
    return this.router.navigate(routeId, { params });
  }

  /** Mount a page. The previous one is disposed first, frames and listeners with it. */
  async show(routeId, params = new URLSearchParams(), { initial = false } = {}) {
    if (!routeById(routeId)) routeId = ROUTES[0].id;
    if (this.pageId === routeId && this.page && !initial) {
      this.page.onParams?.(params);
      return;
    }

    const token = Symbol(routeId);
    this._loadingPage = token;
    this.store.update({ route: routeId, busy: true, busyLabel: `Loading ${routeById(routeId).title}…` });

    let factory;
    try {
      const module = await PAGE_MODULES[routeId]();
      if (this._disposed) return;
      factory = module[`create${PASCAL[routeId]}`] || module.default || Object.values(module).find((v) => typeof v === 'function');
    } catch (err) {
      this.store.update({ busy: false, busyLabel: null });
      this.main.replaceChildren(h('div.page', h('div.error-note', `This screen could not be loaded: ${describeError(err)}`)));
      return;
    }
    if (this._loadingPage !== token || this._disposed) return;   // superseded, or shut down

    // Tear the old page down before the new one is built, so two pages never hold the same
    // engine or the same listeners at once.
    if (this.page?.dispose) {
      try { this.page.dispose(); } catch (err) { console.error('[ManiaFlow] page teardown failed', err); }
    }
    this.page = null;
    this.pageId = routeId;

    let page;
    try {
      page = factory(this.context(), params);
    } catch (err) {
      this.store.update({ busy: false, busyLabel: null });
      this.main.replaceChildren(h('div.page', h('div.error-note', `This screen failed to start: ${describeError(err)}`)));
      return;
    }

    const element = page.root || page;
    // The page scaffold is applied here rather than in each page, so no screen can forget it
    // and every one gets the same max width, padding and vertical rhythm.
    element.classList.add('page', 'page-enter');
    this.main.replaceChildren(element);
    this.main.scrollTop = 0;
    this.page = page;
    page.onParams?.(params);
    this.store.update({ busy: false, busyLabel: null });
    this.topbar.setRoute(routeId);

    // Removing the entrance animation once it has finished keeps the page off its own
    // compositor layer, which is what stops a long list from allocating one layer per row.
    const clearEntrance = () => {
      element.classList.remove('page-enter');
      element.getAnimations?.({ subtree: true }).forEach((animation) => {
        if (animation.playState === 'finished') animation.cancel();
      });
    };
    const timer = setTimeout(clearEntrance, 500);
    this.scope.defer(() => clearTimeout(timer));

    if (page.focus) {
      cancelAnimationFrame(this._focusFrame);
      this._focusFrame = requestAnimationFrame(() => {
        this._focusFrame = 0;
        try { page.focus(); } catch (err) { console.error('[ManiaFlow] page focus failed', err); }
      });
    }
  }

  /** Everything a page is given. Built once, shared by reference. */
  context() {
    if (this._context) return this._context;
    this._context = {
      store: this.store,
      prefs: this.prefs,
      sessions: this.sessions,
      recorder: this.recorder,
      client: () => this.client,
      adapter: () => this.adapter,
      input: () => this.inputScheduler,
      registry: () => this.inputRegistry,
      app: this,
      navigate: (routeId, params) => this.navigate(routeId, params),
      toast: Toast,
      dialog: Dialog,
      actions: {
        importFiles: (files) => this.importDrop(files),
        openChart: (record) => this.openChart(record),
        refreshLibrary: () => this.refreshLibrary(),
        refreshSessions: () => this.refreshSessions(),
        removeChart: (id) => this.removeChart(id),
        clearCharts: () => this.clearCharts(),
        recordAnalysis: (payload) => this.recordAnalysis(payload),
        loadExamples: () => this.loadExamples(),
        reconnect: () => this.reconnect(),
        exportSessions: () => this.exportSessions(),
        showShortcuts: () => this.showShortcuts(),
        setStatus: (message) => this.store.update({ statusMessage: message }),
      },
    };
    return this._context;
  }

  /* ── shared actions ────────────────────────────────────────────────── */

  async importDrop(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    this.store.update({ importing: true, busyLabel: 'Importing charts…' });
    const session = await this.recorder.begin({ kind: 'analysis' });
    this.recorder.mark('import:start');
    try {
      const result = await importFiles(list, {
        onProgress: ({ current, done, total }) => {
          this.store.update({ busyLabel: current ? `Importing ${current}` : `Importing ${done}/${total}` });
          this.topbar.flash(current ? `Importing ${current}` : `Imported ${done}/${total}`);
        },
      });
      this.mergeCharts(result.records);
      this.recorder.record({ analysis: { imported: result.records.length, failures: result.failures.length } });
      this.recorder.mark('import:end');

      if (result.records.length) {
        Toast.ok(`Imported ${result.records.length} ${result.records.length === 1 ? 'chart' : 'charts'}`, 'Import complete');
        // Opening the first playable chart is what a drop is for.
        const playable = result.records.find((record) => record.previewable) || result.records[0];
        await this.openChart(playable);
      }
      if (result.failures.length) {
        const first = result.failures[0];
        Toast.error(
          result.failures.length === 1 ? first.reason : `${result.failures.length} files could not be imported. ${first.name}: ${first.reason}`,
          'Import problems',
        );
        result.failures.forEach((failure) => this.recorder.recordError({ message: `${failure.name}: ${failure.reason}`, code: failure.code }));
      }
      if (!result.records.length && !result.failures.length) {
        Toast.info('Nothing to import — drop .osu difficulties or .osz beatmap sets.');
      }
      await this.recorder.end('completed');
      void session;
    } catch (err) {
      this.recorder.recordError(err);
      await this.recorder.end('error');
      Toast.error(describeError(err), 'Import failed');
    } finally {
      this.store.update({ importing: false, busyLabel: null });
    }
  }

  /** Add records to the library, replacing any with the same id. */
  mergeCharts(records) {
    if (!Array.isArray(records) || !records.length) return [];
    const existing = new Map(this.store.state.charts.map((record) => [record.id, record]));
    const added = [];
    for (const record of records) {
      if (!record?.id) continue;
      const previous = existing.get(record.id);
      // Keep an object URL already created for this chart rather than leaking a second one.
      if (previous?.audioUrl && !record.audioUrl) record.audioUrl = previous.audioUrl;
      if (previous?.openedAt) record.openedAt = previous.openedAt;
      existing.set(record.id, record);
      added.push(record);
    }
    const charts = [...existing.values()].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0) || (b.added || 0) - (a.added || 0));
    const sources = new Set(charts.map((c) => c.source));
    this.store.update({
      charts,
      chartsSource: sources.has('bridge') && (sources.has('local') || sources.has('archive')) ? 'both'
        : sources.has('bridge') ? 'bridge' : sources.size ? 'local' : 'none',
    });
    return added;
  }

  /** Select a chart and make sure its notes are loaded. */
  async openChart(record) {
    if (!record) return null;
    let loaded = record;
    this.store.update({ selectedChartId: record.id, loadError: null });

    if (!loaded.chart && record.source === 'bridge' && this.adapter) {
      // A library row from the game has metadata only; its notes come from loadChart().
      this.store.update({ busy: true, busyLabel: 'Loading chart from the game…' });
      try {
        loaded = await this.adapter.loadChart(record.id);
        this.mergeCharts([loaded]);
      } catch (err) {
        const error = toAppError(err);
        this.store.update({ loadError: { message: error.message, code: error.code }, busy: false, busyLabel: null });
        Toast.error(error.message, 'Chart unavailable');
        return null;
      } finally {
        this.store.update({ busy: false, busyLabel: null });
      }
    }

    const stamped = { ...loaded, openedAt: Date.now() };
    this.mergeCharts([stamped]);
    this.store.update({ loadedChart: stamped, selectedChartId: stamped.id, loadError: null });
    this.page?.onChart?.(stamped);
    return stamped;
  }

  removeChart(id) {
    const record = this.store.state.charts.find((c) => c.id === id);
    if (record?.audioUrl) { try { URL.revokeObjectURL(record.audioUrl); } catch { /* already revoked */ } }
    const charts = this.store.state.charts.filter((c) => c.id !== id);
    const loaded = this.store.state.loadedChart?.id === id ? null : this.store.state.loadedChart;
    this.store.update({ charts, loadedChart: loaded, selectedChartId: loaded?.id ?? null });
    return charts.length;
  }

  async clearCharts() {
    const count = this.store.state.charts.length;
    if (!count) return 0;
    const yes = await confirm({
      title: 'Remove every chart from ManiaFlow?',
      body: `This clears the ${count} chart${count === 1 ? '' : 's'} in this list. Charts stored inside Ashtonk!mania are not touched — reconnecting the bridge reads them again.`,
      confirmLabel: 'Remove all',
      destructive: true,
      icon: 'trash',
    });
    if (!yes) return 0;
    for (const record of this.store.state.charts) {
      if (record.audioUrl) { try { URL.revokeObjectURL(record.audioUrl); } catch { /* already revoked */ } }
    }
    this.store.update({ charts: [], loadedChart: null, selectedChartId: null, loadError: null, chartsSource: 'none' });
    Toast.ok(`Removed ${count} charts`, 'Library cleared');
    return count;
  }

  /**
   * Load the sample charts that ship with ManiaFlow.
   * They are generated patterns with no audio, and they are labelled as examples wherever
   * they appear — the point is a first run that has something real to look at, not data
   * dressed up as the user's own.
   */
  async loadExamples() {
    this.store.update({ busy: true, busyLabel: 'Loading example charts…' });
    try {
      const manifest = await (await fetch('./examples/index.json', { cache: 'no-store' })).json();
      const charts = Array.isArray(manifest.charts) ? manifest.charts : [];
      if (!charts.length) throw new Error('the example manifest lists no charts');

      const records = [];
      const failures = [];
      for (const entry of charts) {
        try {
          const response = await fetch(`./examples/${entry.file}`, { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const record = importOsuText(await response.text(), { fileName: `examples/${entry.file}` });
          record.isExample = true;
          records.push(record);
        } catch (err) {
          failures.push({ name: entry.file, reason: describeError(err) });
        }
      }
      if (!records.length) {
        throw new Error(failures.length ? failures[0].reason : 'no example chart could be read');
      }
      this.mergeCharts(records);
      await this.openChart(records[0]);
      Toast.ok(
        `Loaded ${records.length} example chart${records.length === 1 ? '' : 's'}${failures.length ? ` (${failures.length} failed)` : ''}`,
        'Example charts',
      );
      return records;
    } catch (err) {
      Toast.error(`${describeError(err)}. The example charts are served from /examples by the ManiaFlow server.`, 'Could not load examples');
      return [];
    } finally {
      this.store.update({ busy: false, busyLabel: null });
    }
  }

  async refreshLibrary() {
    if (!this.adapter) {
      Toast.info('No integration is configured, so there is no game library to read.');
      return [];
    }
    this.store.update({ busy: true, busyLabel: 'Reading the game library…' });
    try {
      const records = await this.adapter.readLibrary();
      this.mergeCharts(records);
      this.store.update({ libraryError: null });
      Toast.ok(`Read ${records.length} ${records.length === 1 ? 'chart' : 'charts'} from the game`, 'Library');
      return records;
    } catch (err) {
      const message = describeError(err);
      this.store.update({ libraryError: message });
      Toast.error(message, 'Could not read the library');
      return [];
    } finally {
      this.store.update({ busy: false, busyLabel: null });
    }
  }

  async refreshSessions() {
    try {
      const sessions = await this.sessions.list({ limit: 400 });
      const recents = await this.sessions.recentCharts(8);
      this.store.update({ sessions, recents, sessionHealth: this.sessions.health });
      return sessions;
    } catch (err) {
      this.store.update({ sessionHealth: { ...this.sessions.health, reason: describeError(err) } });
      return [];
    }
  }

  /** Record an analysis run — called by the Timing Lab and the Practice Studio. */
  async recordAnalysis(payload) {
    const chart = this.store.state.loadedChart;
    const session = await this.recorder.begin({
      kind: payload.kind || 'analysis',
      chart: chart ? {
        id: chart.id, title: chart.title, artist: chart.artist, version: chart.version,
        creator: chart.creator, keys: chart.keys, hash: chart.hash, source: chart.source, stars: chart.stars,
      } : null,
      seed: payload.seed ?? null,
    });
    this.recorder.mark('analysis:start');
    this.recorder.record(payload);
    this.recorder.mark('analysis:end');
    const saved = await this.recorder.end(payload.status || 'completed');
    await this.refreshSessions();
    this.store.update({ activeSession: null });
    return saved ?? session;
  }

  /** Record a completed input run against the chart it ran on. */
  async recordInputRun(run) {
    const chart = this.store.state.loadedChart;
    await this.recorder.begin({
      kind: 'input',
      chart: chart ? { id: chart.id, title: chart.title, artist: chart.artist, version: chart.version, keys: chart.keys, source: chart.source } : null,
      seed: run.seed ?? null,
    });
    this.recorder.record({
      input: {
        backendId: run.backendId,
        trusted: run.trusted,
        armed: true,
        plannedEvents: run.eventCount ?? run.planned ?? null,
        executedEvents: run.executed ?? null,
        scheduledNotes: run.scheduledNotes ?? null,
        skippedNotes: run.skippedNotes ?? null,
        rate: run.rate ?? null,
        timing: run.timing ? { meanMs: run.timing.mean, stdDevMs: run.timing.count ? undefined : undefined, ...run.timing } : null,
        refused: false,
      },
      simulation: run.distribution ? { seed: run.seed, distribution: run.distribution } : null,
    });
    await this.recorder.end('completed');
    await this.refreshSessions();
  }

  /**
   * Keep ManiaFlow's own preview aligned with the game while a practice session runs, so
   * the two stages do not visibly disagree. Read-only: nothing here writes to the game.
   */
  syncPlaybackToGame() {
    const gameplay = this.adapter?.gameState?.gameplay;
    if (!gameplay?.active || !gameplay.practice) return;
    this.store.update({ gameState: this.adapter.gameState });
  }

  async reconnect() {
    if (!this.client) {
      await this.loadConfig();
      this.connectIntegration();
      if (!this.client) { Toast.error('The ManiaFlow server did not provide a bridge token.', 'Cannot connect'); return false; }
    }
    this.client.connect();
    this.store.update({ statusMessage: 'Reconnecting to the ManiaFlow server…' });
    return true;
  }

  async exportSessions() {
    try {
      const data = await this.sessions.exportAll();
      downloadJson(`maniaflow-sessions-${new Date().toISOString().slice(0, 10)}.json`, data);
      Toast.ok(`Exported ${data.count} ${data.count === 1 ? 'session' : 'sessions'}`, 'Export complete');
      return data;
    } catch (err) {
      Toast.error(describeError(err), 'Export failed');
      return null;
    }
  }

  showShortcuts() {
    const rows = [
      ['Navigate', ['Alt', '1'] , 'Dashboard … Settings, in sidebar order'],
      ['Shortcuts', ['?'], 'This list'],
      ['Play / pause preview', ['Space'], 'When no field or button has focus'],
      ['Stop input immediately', ['Esc'], 'Releases every key on every backend'],
      ['Search charts', ['/'], 'On the Chart Library screen'],
      ['Import charts', ['Drop', 'files'], 'Anywhere in the window: .osu or .osz'],
    ];
    Dialog.info({
      title: 'Keyboard shortcuts',
      size: 'default',
      body: h('div.stack', ...rows.map(([label, keys, description]) => h('div.shortcut-row',
        h('div', h('div', label), description ? h('div.xs.muted', description) : null),
        h('div.shortcut-row__keys', ...keys.map((key) => h('span.kbd', key))),
      ))),
      confirmLabel: 'Close',
    });
  }

  /* ── teardown ──────────────────────────────────────────────────────── */

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._focusFrame);
    this._focusFrame = 0;
    this.inputScheduler?.dispose();
    this.adapter?.dispose();
    this.client?.dispose();
    this.page?.dispose?.();
    this.sidebar?.dispose();
    this.topbar?.dispose();
    this.statusArea?.dispose();
    this.router.stop();
    this.sessions.dispose();
    this.prefs.dispose();
    this.store.clearSubscriptions();
    this.scope.dispose();
    Toast.clear();
  }
}

const PASCAL = {
  dashboard: 'DashboardPage', library: 'ChartLibraryPage', practice: 'PracticeStudioPage',
  timing: 'TimingLabPage', input: 'InputLabPage', statistics: 'StatisticsPage', settings: 'SettingsPage',
};

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

/** Offer a JSON document as a download. */
export function downloadJson(filename, data) {
  const text = JSON.stringify(data, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers; one turn of the loop is enough.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export { setText, showError, ErrorCode };
