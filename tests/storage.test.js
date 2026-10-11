/**
 * Configuration validation, corrupt-storage recovery, and session persistence.
 *
 * These are the tests that protect the user's data: a preference file that has been
 * truncated, a value from an older schema, a browser that refuses storage, and a session
 * record that is missing half its fields. Each one has to degrade to something usable and
 * say what happened, rather than either losing data quietly or refusing to start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PreferencesStore, PREFERENCES_SCHEMA, defaultPreferences, validatePreference, STORAGE_KEY } from '../src/storage/PreferencesStore.js';
import { SessionStore, SessionKind, SessionStatus, normaliseSession, newId } from '../src/storage/SessionStore.js';
import { MemoryStorage } from './helpers/dom-stub.js';

/* ── schema ──────────────────────────────────────────────────────────── */

test('every schema entry is complete enough to build a control and validate a value', () => {
  assert.ok(PREFERENCES_SCHEMA.length >= 30, 'the schema covers appearance, practice, timing, simulation, integration, input and performance');
  const keys = new Set();
  for (const entry of PREFERENCES_SCHEMA) {
    assert.ok(entry.key && /^[a-z][\w]*\.[\w.]+$/.test(entry.key), `${entry.key}: a namespaced key`);
    assert.ok(!keys.has(entry.key), `${entry.key}: declared once — two entries would be two sources of truth`);
    keys.add(entry.key);
    assert.ok(entry.section, `${entry.key}: has a section`);
    assert.ok(['bool', 'select', 'range', 'int', 'text'].includes(entry.type), `${entry.key}: a supported control type`);
    assert.ok(entry.default !== undefined, `${entry.key}: has a default`);

    if (entry.type === 'select') {
      assert.ok(Array.isArray(entry.options) && entry.options.length, `${entry.key}: a select needs options`);
      assert.ok(entry.options.some((o) => o.id === entry.default), `${entry.key}: its default is one of its options`);
      for (const option of entry.options) {
        assert.ok(option.id && option.label, `${entry.key}: every option has an id and a label`);
      }
    }
    if (entry.type === 'range') {
      assert.ok(Number.isFinite(entry.min) && Number.isFinite(entry.max), `${entry.key}: a range needs bounds`);
      assert.ok(entry.min < entry.max, `${entry.key}: bounds are ordered`);
      assert.ok(entry.default >= entry.min && entry.default <= entry.max, `${entry.key}: the default is inside its own bounds`);
      assert.ok(Number.isFinite(entry.step) && entry.step > 0, `${entry.key}: a positive step`);
    }
    // The default must survive its own validator, or a reset would produce an invalid value.
    const checked = validatePreference(entry.key, entry.default);
    assert.ok(checked.ok, `${entry.key}: the default passes validation (${checked.reason})`);
    assert.deepEqual(checked.value, entry.default, `${entry.key}: validation leaves a valid default alone`);
  }
});

test('the minimum hold cannot be set below the game\'s own floor', () => {
  // Ashtonk!mania rejects a press and release closer than 5ms as impossible input, so a
  // preference that allowed less would produce schedules the game refuses.
  const entry = PREFERENCES_SCHEMA.find((e) => e.key === 'simulation.minHoldMs');
  assert.equal(entry.min, 5);
  assert.equal(validatePreference('simulation.minHoldMs', 0).value, 5);
  assert.equal(validatePreference('simulation.minHoldMs', -20).value, 5);
  assert.equal(validatePreference('simulation.minHoldMs', 12).value, 12);
});

test('an unknown preference is refused rather than stored', () => {
  const result = validatePreference('not.a.preference', 1);
  assert.equal(result.ok, false);
  assert.equal(result.value, undefined);
  assert.match(result.reason, /Unknown preference/);

  const store = new PreferencesStore({ storage: new MemoryStorage() });
  store.load();
  const set = store.set('not.a.preference', 1);
  assert.equal(set.ok, false);
  assert.equal(store.get('not.a.preference'), undefined);
});

/* ── validation and clamping ─────────────────────────────────────────── */

test('values outside their range are clamped, and the clamping is reported', () => {
  const store = new PreferencesStore({ storage: new MemoryStorage() });
  store.load();

  const rate = store.set('practice.defaultRate', 99);
  assert.equal(rate.ok, true);
  assert.equal(rate.value, 2, 'clamped to the maximum');
  assert.equal(rate.clamped, true);
  assert.ok(rate.reason, 'and the caller is told');

  assert.equal(store.set('practice.defaultRate', 0.001).value, 0.25);
  assert.equal(store.set('practice.defaultRate', 'nonsense').value, 1, 'an unreadable number falls back to the default');
  assert.equal(store.get('practice.defaultRate'), 1);

  assert.equal(store.set('practice.scrollSpeed', 1000).value, 40);
  assert.equal(store.set('practice.offsetMs', -99999).value, -300);
  assert.equal(store.set('simulation.sigmaMs', 1e9).value, 200);
  assert.equal(store.set('performance.pixelRatioCap', 0).value, 1);
});

test('a select refuses a value that is not one of its options', () => {
  const store = new PreferencesStore({ storage: new MemoryStorage() });
  store.load();
  const result = store.set('appearance.accent', 'chartreuse');
  assert.equal(result.value, 'violet', 'falls back to the default');
  assert.equal(result.clamped, true);
  assert.match(result.reason, /not one of/);

  assert.equal(store.set('appearance.accent', 'ice').value, 'ice');
  assert.equal(store.set('appearance.theme', 'solarised').value, 'dark');
  assert.equal(store.set('appearance.density', 'enormous').value, 'comfortable');
  assert.equal(store.set('input.backend', 'telepathy').value, 'synthetic');
});

test('booleans accept the shapes a stored file actually contains', () => {
  const store = new PreferencesStore({ storage: new MemoryStorage() });
  store.load();
  assert.equal(store.set('practice.showBarlines', true).value, true);
  assert.equal(store.set('practice.showBarlines', false).value, false);
  assert.equal(store.set('practice.showBarlines', 'true').value, true, 'a stringified boolean from JSON');
  assert.equal(store.set('practice.showBarlines', 'false').value, false);
  // Anything else falls back to the schema default — which for this preference is `true`,
  // not `false`. Falling back to the default is the point; guessing the opposite would not be.
  assert.equal(store.set('practice.showBarlines', 'yes').value, true, 'anything else falls back to the default');
  // `set` reports `ok` for "the value was stored" and `clamped` for "not what you asked
  // for", so a repair is visible to the caller without being treated as a failure.
  const reported = store.set('practice.showLaneGuides', 'yes');
  assert.equal(reported.ok, true, 'a usable value was stored');
  assert.equal(reported.clamped, true, 'and the caller is told it was replaced');
  assert.match(reported.reason, /not a boolean/);
  assert.equal(store.get('practice.showLaneGuides'), true);
});

test('a reset returns one preference, and resetAll returns every one', () => {
  const store = new PreferencesStore({ storage: new MemoryStorage() });
  store.load();
  store.set('appearance.accent', 'rose');
  store.set('practice.defaultRate', 1.5);
  store.setOverride('keymap.some-chart', [['KeyA']]);

  assert.equal(store.reset('appearance.accent').value, 'violet');
  assert.equal(store.get('practice.defaultRate'), 1.5, 'resetting one leaves the others');
  assert.equal(store.reset('nope').ok, false);

  store.resetAll();
  assert.deepEqual(store.values, defaultPreferences(), 'everything is back to the schema defaults');
  assert.equal(store.overrides.size, 0, 'including the structured overrides');
});

/* ── persistence and recovery ────────────────────────────────────────── */

test('preferences survive a reload', () => {
  const storage = new MemoryStorage();
  const first = new PreferencesStore({ storage });
  first.load();
  first.set('appearance.accent', 'mint');
  first.set('practice.defaultRate', 0.75);
  first.setOverride('keymap.chart-1', [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF']]);
  first.flush();

  const second = new PreferencesStore({ storage });
  second.load();
  assert.equal(second.get('appearance.accent'), 'mint');
  assert.equal(second.get('practice.defaultRate'), 0.75);
  assert.deepEqual(second.get('keymap.chart-1'), [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF']]);
  assert.equal(second.health.recovered, false, 'nothing needed repairing');
  assert.equal(second.health.reason, null);
});

test('a corrupt preference file is quarantined, not lost, and defaults are used', () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, '{"appearance.accent": "ice", broken json');

  const store = new PreferencesStore({ storage });
  store.load();

  assert.deepEqual(store.values, defaultPreferences(), 'the app runs on defaults');
  assert.equal(store.health.recovered, true);
  assert.match(store.health.reason, /not valid JSON/);

  const quarantined = JSON.parse(storage.getItem('maniaflow.preferences.corrupt'));
  assert.match(quarantined.raw, /appearance\.accent/, 'the original text was kept');
  assert.match(quarantined.reason, /not valid JSON/);
  assert.ok(quarantined.at > 0, 'and stamped with when it happened');

  // A later clean save does not resurrect the bad data.
  store.set('appearance.accent', 'rose');
  store.flush();
  const reopened = new PreferencesStore({ storage });
  reopened.load();
  assert.equal(reopened.get('appearance.accent'), 'rose');
  assert.equal(reopened.health.recovered, false);
});

test('a preference file of the wrong shape is recovered the same way', () => {
  for (const bad of ['[]', '"a string"', '42', 'null', '{"values": 5}', '{"noValues": true}']) {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, bad);
    const store = new PreferencesStore({ storage });
    store.load();
    assert.deepEqual(store.values, defaultPreferences(), `${bad}: defaults are used`);
    assert.equal(store.health.recovered, true, `${bad}: reported as recovered`);
    assert.match(store.health.reason, /unexpected shape/, `${bad}: the reason is specific`);
  }
});

test('individual invalid values are repaired while the valid ones are kept', () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    values: {
      'appearance.accent': 'ice',            // valid
      'practice.defaultRate': 999,           // out of range
      'practice.showBarlines': 'not-a-bool', // wrong type
      'gone.oldPreference': true,            // no longer in the schema
      'simulation.seed': -5,                 // below the minimum
    },
    overrides: { 'keymap.x': [['KeyQ']] },
  }));

  const store = new PreferencesStore({ storage });
  store.load();

  assert.equal(store.get('appearance.accent'), 'ice', 'a valid value is kept');
  assert.equal(store.get('practice.defaultRate'), 2, 'an out-of-range value is clamped');
  assert.equal(store.get('practice.showBarlines'), true, 'a wrong type falls back to the default');
  assert.equal(store.get('gone.oldPreference'), undefined, 'a retired preference is dropped');
  assert.equal(store.get('simulation.seed'), 1, 'a below-minimum seed is clamped into range');
  assert.deepEqual(store.get('keymap.x'), [['KeyQ']], 'structured overrides survive');

  assert.equal(store.health.recovered, true);
  assert.match(store.health.reason, /4 stored value\(s\) were invalid/);
  assert.equal(store.health.repaired.length, 4, 'including the boolean that was not one');
  assert.ok(store.health.repaired.some((r) => r.key === 'gone.oldPreference' && /no longer a known preference/.test(r.reason)));
});

test('storage that is unavailable or full degrades instead of throwing', () => {
  const missing = new PreferencesStore({ storage: null });
  missing.load();
  assert.equal(missing.health.available, false);
  assert.match(missing.health.reason, /no localStorage/);
  missing.set('appearance.accent', 'ice');
  assert.equal(missing.get('appearance.accent'), 'ice', 'still works for this session');
  assert.equal(missing.flush().ok, false);

  const full = new MemoryStorage();
  full.setItem = () => { const err = new Error('exceeded'); err.name = 'QuotaExceededError'; throw err; };
  const store = new PreferencesStore({ storage: full });
  store.load();
  const failures = [];
  store.on('health', (health) => failures.push(health));
  store.set('appearance.accent', 'rose');
  const result = store.flush();
  assert.equal(result.ok, false);
  assert.equal(result.quota, true, 'a quota failure is distinguished from any other write error');
  assert.match(result.reason, /full/);
  assert.ok(failures.length > 0, 'and the UI is told');
  assert.equal(store.get('appearance.accent'), 'rose', 'the in-memory value is still correct');
});

test('an export round-trips, and an import validates every key', () => {
  const store = new PreferencesStore({ storage: new MemoryStorage() });
  store.load();
  store.set('appearance.accent', 'amber');
  store.set('practice.scrollSpeed', 30);
  store.setOverride('keymap.c', [['Space']]);
  const exported = store.export();
  assert.equal(exported.values['appearance.accent'], 'amber');
  assert.ok(exported.exportedAt);

  const target = new PreferencesStore({ storage: new MemoryStorage() });
  target.load();
  const result = target.import({ ...exported, values: { ...exported.values, 'bogus.key': 1, 'practice.defaultRate': 999 } });
  assert.equal(result.ok, true);
  assert.equal(target.get('appearance.accent'), 'amber');
  assert.equal(target.get('practice.scrollSpeed'), 30);
  assert.equal(target.get('practice.defaultRate'), 2, 'an imported value is clamped like any other');
  assert.deepEqual(target.get('keymap.c'), [['Space']]);
  assert.ok(result.rejected.some((r) => r.key === 'bogus.key'), 'an unknown key is reported, not silently kept');

  assert.equal(target.import('not an object').ok, false);
  assert.equal(target.import({}).ok, false);
});

/* ── session records ─────────────────────────────────────────────────── */

test('a session record is normalised, so a partial one never reaches the UI', () => {
  const record = normaliseSession({
    kind: 'nonsense',
    status: 'also-nonsense',
    startedAt: 'not a number',
    chart: { id: 'c1', title: 'T', keys: 4, source: 'somewhere', stars: 'high' },
    errors: [{ message: 'x' }, 'a bare string'],
    marks: null,
  });
  assert.equal(record.kind, SessionKind.ANALYSIS, 'an unknown kind falls back');
  assert.equal(record.status, SessionStatus.COMPLETED);
  assert.ok(Number.isFinite(record.startedAt), 'an unreadable timestamp is replaced, not kept as NaN');
  assert.equal(record.endedAt, null);
  assert.equal(record.durationMs, 0, 'and the duration does not become NaN');
  assert.equal(record.chart.source, 'local', 'an unknown chart source falls back');
  assert.equal(record.chart.stars, null, 'a non-numeric star rating is dropped rather than coerced');
  assert.equal(record.errors.length, 2);
  assert.ok(record.errors.every((e) => typeof e.message === 'string' && Number.isFinite(e.at)));
  assert.deepEqual(record.marks, []);
  assert.ok(record.id, 'an id is generated');

  assert.equal(normaliseSession(null).status, SessionStatus.COMPLETED);
  assert.equal(normaliseSession('nope').kind, SessionKind.ANALYSIS);
  assert.equal(normaliseSession({}).errors.length, 0);
});

test('a session id is unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId()));
  assert.equal(ids.size, 500);
});

test('an update merges into a stored session rather than replacing it', async () => {
  const store = new SessionStore();
  await store.init();
  const created = await store.put({ id: 's1', kind: SessionKind.PRACTICE, startedAt: 1000, analysis: { objectCount: 500 } });
  assert.equal(created.analysis.objectCount, 500);

  const updated = await store.update('s1', { status: SessionStatus.COMPLETED, endedAt: 9000, playback: { rate: 1.5 } });
  assert.equal(updated.analysis.objectCount, 500, 'the analysis survived');
  assert.equal(updated.playback.rate, 1.5);
  assert.equal(updated.status, 'completed');
  assert.equal(updated.durationMs, 8000, 'the duration is measured from the timestamps');

  assert.equal((await store.count()), 1, 'an update does not create a second record');
  const missing = await store.update('does-not-exist', { status: SessionStatus.COMPLETED });
  assert.equal(missing.id, 'does-not-exist', 'updating a missing id creates a record with that id');
  assert.equal(missing.analysis, null, 'and invents no data for it');
});

test('sessions are listed newest first and can be filtered', async () => {
  const store = new SessionStore();
  await store.init();
  for (let i = 0; i < 6; i++) {
    await store.put({
      id: `s${i}`, startedAt: 1000 + i * 1000, endedAt: 1500 + i * 1000,
      kind: i % 2 ? SessionKind.PRACTICE : SessionKind.SIMULATION,
      status: i === 5 ? SessionStatus.ERROR : SessionStatus.COMPLETED,
      chart: { id: `chart-${i % 3}`, title: `T${i}`, keys: 4, source: 'local' },
      analysis: { objectCount: 100 * (i + 1) },
    });
  }
  const all = await store.list({});
  assert.equal(all.length, 6);
  assert.deepEqual(all.map((s) => s.id), ['s5', 's4', 's3', 's2', 's1', 's0'], 'newest first');

  assert.equal((await store.list({ kind: SessionKind.PRACTICE })).length, 3);
  assert.equal((await store.list({ status: SessionStatus.ERROR })).length, 1);
  assert.equal((await store.list({ limit: 2 })).length, 2);
  assert.deepEqual((await store.list({ limit: 2, offset: 2 })).map((s) => s.id), ['s3', 's2']);
  assert.equal((await store.list({ limit: 'many' })).length, 6, 'a bad limit falls back rather than throwing');
});

test('recents and per-chart history come from real records', async () => {
  const store = new SessionStore();
  await store.init();
  await store.put({ id: 'a1', startedAt: 1000, kind: SessionKind.ANALYSIS, chart: { id: 'c1', title: 'One', keys: 4, source: 'local' } });
  await store.put({ id: 'a2', startedAt: 2000, kind: SessionKind.PRACTICE, chart: { id: 'c1', title: 'One', keys: 4, source: 'local' } });
  await store.put({ id: 'a3', startedAt: 3000, kind: SessionKind.INPUT, chart: { id: 'c2', title: 'Two', keys: 7, source: 'bridge' } });
  await store.put({ id: 'a4', startedAt: 4000, kind: SessionKind.ANALYSIS });   // no chart

  const recents = await store.recentCharts(8);
  assert.equal(recents.length, 2, 'a session with no chart does not invent one');
  assert.equal(recents[0].chart.id, 'c2', 'most recent first');
  assert.equal(recents[1].sessions, 2, 'the older chart has two sessions behind it');

  assert.equal((await store.forChart('c1')).length, 2);
  assert.deepEqual((await store.forChart('c1')).map((s) => s.id), ['a2', 'a1']);
  assert.deepEqual(await store.forChart('nope'), []);
  assert.deepEqual(await store.forChart(null), []);
});

test('the retention limit drops the oldest sessions', async () => {
  const store = new SessionStore({ limit: 5 });
  await store.init();
  for (let i = 0; i < 12; i++) await store.put({ id: `s${i}`, startedAt: 1000 + i, kind: SessionKind.ANALYSIS });
  const all = await store.list({ limit: 100 });
  assert.ok(all.length <= 5, `kept ${all.length} of 12`);
  assert.equal(all[0].id, 's11', 'and they are the newest');
  store.setLimit(20);
  assert.equal(store.limit, 20);
  assert.equal(store.setLimit('many'), 200, 'a bad limit falls back to the default');
});

test('removing and clearing work, and report honestly when there was nothing to do', async () => {
  const store = new SessionStore();
  await store.init();
  await store.put({ id: 'x1', startedAt: 1000, kind: SessionKind.ANALYSIS });
  assert.equal(await store.remove('x1'), true);
  assert.equal(await store.remove('x1'), false, 'removing twice says so');
  assert.equal(await store.remove(null), false);
  assert.equal(await store.count(), 0);

  await store.put({ id: 'x2', startedAt: 2000, kind: SessionKind.ANALYSIS });
  await store.clear();
  assert.equal(await store.count(), 0);
  assert.deepEqual(await store.list({}), []);
});

test('an export round-trips, and a partly corrupt import keeps what it can', async () => {
  const store = new SessionStore();
  await store.init();
  await store.put({ id: 'e1', startedAt: 1000, endedAt: 5000, kind: SessionKind.PRACTICE, analysis: { objectCount: 900 }, chart: { id: 'c', title: 'T', keys: 4, source: 'local' } });
  await store.put({ id: 'e2', startedAt: 2000, endedAt: 3000, kind: SessionKind.SIMULATION, simulation: { seed: 7, unstableRate: 42 } });

  const exported = await store.exportAll();
  assert.equal(exported.count, 2);
  assert.equal(exported.sessions[0].startedAt, 1000, 'oldest first, so an import restores the order');
  assert.ok(exported.exportedAt);

  const target = new SessionStore();
  await target.init();
  const result = await target.importAll({ ...exported, sessions: [...exported.sessions, null, 'junk', { noStartedAt: true }, { id: 'e3', startedAt: 3000 }] });
  assert.equal(result.imported, 3, 'the three readable records came in');
  assert.equal(result.skipped.length, 3, 'and the three unreadable ones were counted, not dropped silently');
  assert.equal(await target.count(), 3);
  assert.ok((await target.get('e1')).analysis.objectCount === 900, 'measurements survived the trip');

  await assert.rejects(() => target.importAll({ nope: true }), /not a ManiaFlow session export/);
  await assert.rejects(() => target.importAll('a string'), /not a ManiaFlow session export/);
});

test('session storage reports which backend it got, so the UI can warn about memory-only', async () => {
  // No IndexedDB and no localStorage in a bare Node test: memory only, and it says so.
  const store = new SessionStore();
  const health = await store.init();
  assert.ok(['memory', 'localstorage'].includes(health.backend), `got ${health.backend}`);
  assert.equal(health.available, true, 'the app still works');
  if (health.backend === 'memory') {
    assert.match(health.reason, /lasts for this session only/, 'the reason says what the user loses');
  }

  await store.put({ id: 'm1', startedAt: 1000, kind: SessionKind.ANALYSIS });
  assert.equal(await store.count(), 1, 'writes still work on the fallback backend');
  store.dispose();
  assert.equal(await store.count(), 0, 'and dispose releases the records');
});

test('a change event fires for every write, so one listener can keep a list current', async () => {
  const store = new SessionStore();
  await store.init();
  const seen = [];
  store.on('change', (change) => seen.push(change.type));
  await store.put({ id: 'c1', startedAt: 1000, kind: SessionKind.ANALYSIS });
  await store.update('c1', { status: SessionStatus.COMPLETED });
  await store.remove('c1');
  await store.clear();
  assert.deepEqual(seen, ['put', 'update', 'remove', 'clear']);
});
