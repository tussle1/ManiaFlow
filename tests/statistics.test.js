/**
 * Session statistics.
 *
 * The property under test is honesty: an aggregation must return `null` for a metric no
 * session measured, never a zero that reads like a measurement. A dashboard that shows
 * "0 notes processed" when nothing was ever analysed is telling the user something false.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  totals, dailyTrend, rateHistogram, timingSummary, compare, byChart, errorBreakdown, coverage, usable,
} from '../src/analytics/StatisticsEngine.js';
import { SessionKind, SessionStatus } from '../src/storage/SessionStore.js';

const DAY = 86400000;
const now = Date.now();

function session(overrides = {}) {
  return {
    id: 'id',
    kind: SessionKind.ANALYSIS,
    status: SessionStatus.COMPLETED,
    startedAt: now,
    endedAt: now + 60000,
    durationMs: 60000,
    chart: { id: 'c1', title: 'T', artist: 'A', version: 'N', keys: 4, source: 'local', stars: null },
    analysis: null, playback: null, input: null, simulation: null, integration: null,
    errors: [], marks: [], seed: null, appVersion: '1.0.0',
    ...overrides,
  };
}

/* ── input hygiene ───────────────────────────────────────────────────── */

test('junk records are dropped before anything is aggregated', () => {
  const mixed = [session(), null, 'a string', 42, {}, { startedAt: 'not a number' }, undefined, session({ id: 'b' })];
  const kept = usable(mixed);
  assert.equal(kept.length, 2, 'only real records with a usable timestamp survive');
  assert.deepEqual(usable(null), []);
  assert.deepEqual(usable('nope'), []);
  assert.deepEqual(usable(undefined), []);
});

test('aggregations of nothing are empty, not zero-shaped', () => {
  const t = totals([]);
  assert.equal(t.sessions, 0);
  assert.equal(t.totalDurationMs, 0);
  assert.equal(t.notesProcessed, 0);
  assert.equal(t.meanRate, null, 'a mean with no samples is null, not 0');
  assert.equal(t.lastAt, null);
  assert.deepEqual(t.ratesUsed, []);

  assert.deepEqual(rateHistogram([]), []);
  assert.equal(timingSummary([]).runs, 0);
  assert.equal(timingSummary([]).mean, null);
  assert.equal(timingSummary([]).unstableRate, null);
  assert.deepEqual(byChart([]), []);
  assert.deepEqual(errorBreakdown([]), []);
  assert.equal(coverage([]).any, false);
});

/* ── totals ──────────────────────────────────────────────────────────── */

test('totals count what the sessions actually contain', () => {
  const list = [
    session({ id: 's1', kind: SessionKind.ANALYSIS, durationMs: 30000, analysis: { objectCount: 1200, lnCount: 100 }, chart: { id: 'c1' } }),
    session({ id: 's2', kind: SessionKind.PRACTICE, durationMs: 90000, analysis: { objectCount: 800 }, playback: { rate: 0.75 }, chart: { id: 'c1' } }),
    session({ id: 's3', kind: SessionKind.PRACTICE, durationMs: 45000, playback: { rate: 1 }, chart: { id: 'c2' } }),
    session({ id: 's4', kind: SessionKind.SIMULATION, status: SessionStatus.ERROR, durationMs: 5000, errors: [{ at: now, message: 'x', code: 'chart-parse' }] }),
    session({ id: 's5', kind: SessionKind.INPUT, status: SessionStatus.ABORTED, durationMs: 1000, input: { armed: true, executedEvents: 400 } }),
  ];
  const t = totals(list);
  assert.equal(t.sessions, 5);
  assert.equal(t.completed, 3);
  assert.equal(t.errored, 1);
  assert.equal(t.aborted, 1);
  assert.equal(t.totalDurationMs, 171000);
  assert.equal(t.chartsAnalysed, 2, 'only sessions that carry an analysis count');
  assert.equal(t.distinctCharts, 2, 'c1 appears twice but counts once');
  assert.equal(t.notesProcessed, 2000, '1200 + 800');
  assert.deepEqual(t.byKind, { analysis: 1, practice: 2, simulation: 1, input: 1 });
  assert.deepEqual(t.ratesUsed, [0.75, 1], 'sorted and deduplicated');
  assert.equal(t.meanRate, 0.875);
  assert.equal(t.inputRuns, 1);
  assert.equal(t.errors, 1);
  assert.equal(t.lastAt, now);
});

test('a session with no chart contributes nothing to the chart figures', () => {
  const t = totals([session({ id: 'x', chart: null, analysis: { objectCount: 500 } })]);
  assert.equal(t.distinctCharts, 0);
  assert.equal(t.chartsAnalysed, 1, 'the analysis still happened');
  assert.equal(t.notesProcessed, 500, 'and its note count still counts');
});

test('negative or missing durations cannot make the total go backwards', () => {
  const t = totals([
    session({ id: 'a', durationMs: -5000 }),
    session({ id: 'b', durationMs: null }),
    session({ id: 'c', durationMs: undefined }),
    session({ id: 'd', durationMs: 2000 }),
  ]);
  assert.equal(t.totalDurationMs, 2000, 'only the real one counts');
});

/* ── trends ──────────────────────────────────────────────────────────── */

test('the daily trend includes empty days so a gap is not read as a zero', () => {
  const list = [
    session({ id: 'a', startedAt: now, durationMs: 1000, analysis: { objectCount: 10 } }),
    session({ id: 'b', startedAt: now - 3 * DAY, durationMs: 2000 }),
    session({ id: 'c', startedAt: now - 3 * DAY, durationMs: 3000 }),
    session({ id: 'd', startedAt: now - 40 * DAY, durationMs: 4000 }),   // outside the window
  ];
  const days = dailyTrend(list, { days: 14, endDate: now });
  assert.equal(days.length, 14, 'every day in the window is present');
  assert.ok(days.every((d) => Number.isFinite(d.day)), 'each has a timestamp');
  assert.ok(days[days.length - 1].day >= days[0].day, 'ascending');
  assert.equal(days[days.length - 1].sessions, 1, 'today');
  const threeDaysAgo = days[days.length - 4];
  assert.equal(threeDaysAgo.sessions, 2);
  assert.equal(threeDaysAgo.durationMs, 5000);
  assert.deepEqual(threeDaysAgo.kinds, { analysis: 2 });
  assert.equal(days.reduce((sum, d) => sum + d.sessions, 0), 3, 'the session outside the window is excluded, not lost');
  assert.ok(days.some((d) => d.sessions === 0), 'and the empty days are visibly empty');
});

test('the trend window is bounded so a bad preference cannot allocate absurdly', () => {
  assert.equal(dailyTrend([], { days: 0 }).length, 1);
  assert.equal(dailyTrend([], { days: -5 }).length, 1);
  assert.equal(dailyTrend([], { days: 100000 }).length, 365);
  assert.equal(dailyTrend([], { days: 'many' }).length, 14);
});

test('the rate histogram counts real usage', () => {
  const list = [
    session({ id: 'a', playback: { rate: 1 } }),
    session({ id: 'b', playback: { rate: 1 } }),
    session({ id: 'c', playback: { rate: 0.5 } }),
    session({ id: 'd', playback: { rate: 1.0000001 } }),   // float noise collapses onto 1
    session({ id: 'e', playback: null }),
    session({ id: 'f', playback: { rate: 0 } }),           // not a real rate
  ];
  const hist = rateHistogram(list);
  assert.deepEqual(hist, [{ rate: 0.5, count: 1 }, { rate: 1, count: 3 }]);
});

/* ── timing ──────────────────────────────────────────────────────────── */

test('timing summary reads simulation runs and input timing alike', () => {
  const list = [
    session({ id: 'a', kind: SessionKind.SIMULATION, simulation: { mean: -4, stdDev: 12, unstableRate: 120 } }),
    session({ id: 'b', kind: SessionKind.SIMULATION, simulation: { mean: 2, stdDev: 8, unstableRate: 80 } }),
    session({ id: 'c', kind: SessionKind.INPUT, input: { timing: { meanMs: 1.5, stdDevMs: 0.4 } } }),
    session({ id: 'd', kind: SessionKind.ANALYSIS }),
  ];
  const summary = timingSummary(list);
  assert.equal(summary.runs, 3, 'the analysis session with no timing does not count');
  // summarise() rounds to three decimals, so the comparison allows for that.
  assert.ok(Math.abs(summary.mean.mean - (-4 + 2 + 1.5) / 3) < 1e-3);
  assert.ok(summary.unstableRate.count === 3);
  // An input run reports a std deviation, so its UR is derived the way osu! derives it.
  assert.ok(summary.history.some((run) => Math.abs(run.unstableRate - 4) < 1e-9));
  assert.deepEqual(summary.history.map((r) => r.id), ['a', 'b', 'c'], 'in chronological order');
});

test('a session with neither mean nor deviation is skipped rather than counted as zero', () => {
  const summary = timingSummary([
    session({ id: 'a', simulation: { seed: 1 } }),
    session({ id: 'b', simulation: { mean: null, stdDev: null } }),
  ]);
  assert.equal(summary.runs, 0);
  assert.equal(summary.mean, null);
});

/* ── comparison ──────────────────────────────────────────────────────── */

test('comparison reports a delta only where both sessions measured the thing', () => {
  const a = session({ id: 'a', durationMs: 60000, playback: { rate: 1, offsetMs: 0, seekCount: 3 }, analysis: { objectCount: 1000 } });
  const b = session({ id: 'b', durationMs: 90000, playback: { rate: 0.75, seekCount: 5 }, analysis: { objectCount: 1000 }, simulation: { mean: 3, unstableRate: 60 } });
  const rows = compare(a, b);
  const byField = new Map(rows.map((r) => [r.field, r]));

  assert.equal(byField.get('durationMs').delta, 30000);
  assert.equal(byField.get('rate').delta, -0.25, 'a slowdown is a negative delta, not a magnitude');
  assert.equal(byField.get('seeks').delta, 2);
  assert.equal(byField.get('objectCount').delta, 0, 'the same measurement twice compares equal');
  assert.equal(byField.get('offsetMs').delta, null, 'b did not record an offset, so there is no delta');
  assert.equal(byField.get('unstableRate').delta, null, 'a did not record one');
  assert.equal(byField.get('meanError').delta, null);
  assert.ok(rows.every((r) => r.label), 'every row has a label a person can read');

  // Comparing against nothing yields rows with no deltas, not a crash.
  const empty = compare(null, b);
  assert.ok(empty.every((r) => r.delta === null));
  assert.equal(compare(null, null).length, empty.length);
});

/* ── per-chart and errors ────────────────────────────────────────────── */

test('per-chart roll-up keeps the most recent session and every kind', () => {
  const list = [
    session({ id: 'a', startedAt: now - 3000, kind: SessionKind.ANALYSIS, durationMs: 1000, chart: { id: 'c1', title: 'One' } }),
    session({ id: 'b', startedAt: now - 1000, kind: SessionKind.PRACTICE, durationMs: 2000, chart: { id: 'c1', title: 'One' } }),
    session({ id: 'c', startedAt: now - 2000, kind: SessionKind.INPUT, durationMs: 3000, chart: { id: 'c2', title: 'Two' } }),
    session({ id: 'd', startedAt: now, chart: null }),
  ];
  const roll = byChart(list);
  assert.equal(roll.length, 2, 'a session with no chart does not create an entry');
  assert.equal(roll[0].chart.id, 'c1', 'most recently used first');
  assert.equal(roll[0].sessions, 2);
  assert.equal(roll[0].totalDurationMs, 3000);
  assert.equal(roll[0].lastAt, now - 1000);
  assert.equal(roll[0].lastSession.id, 'b');
  assert.deepEqual(roll[0].kinds.sort(), ['analysis', 'practice']);
  assert.equal(roll[1].chart.id, 'c2');
});

test('the error breakdown groups by code and keeps a sample message', () => {
  const list = [
    session({ id: 'a', errors: [{ at: now, message: 'first', code: 'chart-parse' }, { at: now, message: 'second', code: 'chart-parse' }] }),
    session({ id: 'b', errors: [{ at: now, message: 'other', code: 'bridge-timeout' }] }),
    session({ id: 'c', errors: [{ at: now, message: 'no code' }] }),
    session({ id: 'd', errors: null }),
  ];
  const breakdown = errorBreakdown(list);
  assert.deepEqual(breakdown.map((e) => e.code).sort(), ['bridge-timeout', 'chart-parse', 'unknown']);
  assert.equal(breakdown[0].code, 'chart-parse', 'most frequent first');
  assert.equal(breakdown[0].count, 2);
  assert.equal(breakdown[0].sample, 'first');
  assert.ok(breakdown.some((e) => e.code === 'unknown' && e.sample === 'no code'), 'an error with no code is grouped, not dropped');
  assert.ok(breakdown.some((e) => e.code === 'bridge-timeout'));
});

/* ── coverage ────────────────────────────────────────────────────────── */

test('coverage says exactly which measurements are missing', () => {
  assert.equal(coverage([]).any, false);
  assert.ok(coverage([]).missing.includes('analysis'));

  const partial = coverage([session({ id: 'a', analysis: { objectCount: 1 } })]);
  assert.equal(partial.any, true);
  assert.equal(partial.analysis, true);
  assert.equal(partial.playback, false);
  assert.ok(partial.missing.includes('playback'), 'the missing list names it');
  assert.ok(!partial.missing.includes('analysis'));

  const full = coverage([
    session({ id: 'a', chart: { id: 'c1' }, analysis: { objectCount: 1 }, playback: { rate: 1 }, simulation: { mean: 1 }, input: { armed: true } }),
    session({ id: 'b', chart: { id: 'c2' }, analysis: { objectCount: 2 } }),
  ]);
  assert.equal(full.multipleCharts, true);
  assert.equal(full.comparable, true);
  assert.deepEqual(full.missing, []);
});

test('a single chart is not reported as comparable with itself', () => {
  const single = coverage([
    session({ id: 'a', chart: { id: 'c1' }, analysis: { objectCount: 1 } }),
    session({ id: 'b', chart: { id: 'c1' }, analysis: { objectCount: 2 } }),
  ]);
  assert.equal(single.multipleCharts, false);
  assert.equal(single.comparable, true, 'two sessions on one chart can still be compared');
});
