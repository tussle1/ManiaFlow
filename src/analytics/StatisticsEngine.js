/**
 * StatisticsEngine — pure aggregation over recorded sessions.
 *
 * Everything here is a function of the records it is given. There is no cache, no state and
 * no fabrication: a metric with no data behind it comes back `null`, and the UI shows a dash
 * rather than a plausible-looking zero. That distinction matters, because "no sessions
 * recorded" and "sessions recorded, none of which measured this" are different facts.
 */

import { isPlainObject, num } from '../utils/validation.js';
import { SessionKind, SessionStatus } from '../storage/SessionStore.js';
import { summarise } from '../playback/Simulation.js';

const DAY_MS = 86400000;

/** Filter out anything that is not a usable record before it reaches an aggregation. */
export function usable(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => isPlainObject(s) && Number.isFinite(num(s.startedAt, Number.NaN)));
}

/**
 * Headline totals for the Statistics page.
 * @returns {{
 *   sessions: number, completed: number, aborted: number, errored: number,
 *   totalDurationMs: number, chartsAnalysed: number, distinctCharts: number,
 *   notesProcessed: number, byKind: Record<string, number>,
 *   ratesUsed: number[], meanRate: number|null, inputRuns: number,
 *   refusedRuns: number, lastAt: number|null
 * }}
 */
export function totals(sessions) {
  const list = usable(sessions);
  const byKind = {};
  const rates = [];
  const chartIds = new Set();
  let notesProcessed = 0;
  let chartsAnalysed = 0;
  let inputRuns = 0;
  let refusedRuns = 0;

  for (const session of list) {
    byKind[session.kind] = (byKind[session.kind] || 0) + 1;
    if (session.chart?.id) chartIds.add(session.chart.id);
    if (isPlainObject(session.analysis)) {
      chartsAnalysed++;
      notesProcessed += Math.max(0, num(session.analysis.objectCount, 0));
    }
    const rate = num(session.playback?.rate, Number.NaN);
    if (Number.isFinite(rate) && rate > 0) rates.push(rate);
    if (isPlainObject(session.input)) {
      if (num(session.input.executedEvents, 0) > 0 || session.input.armed) inputRuns++;
      if (session.input.refused) refusedRuns++;
      notesProcessed = Math.max(notesProcessed, 0);
    }
  }

  return {
    sessions: list.length,
    completed: list.filter((s) => s.status === SessionStatus.COMPLETED).length,
    aborted: list.filter((s) => s.status === SessionStatus.ABORTED).length,
    errored: list.filter((s) => s.status === SessionStatus.ERROR).length,
    running: list.filter((s) => s.status === SessionStatus.RUNNING).length,
    totalDurationMs: list.reduce((total, s) => total + Math.max(0, num(s.durationMs, 0)), 0),
    chartsAnalysed,
    distinctCharts: chartIds.size,
    notesProcessed,
    byKind,
    ratesUsed: [...new Set(rates)].sort((a, b) => a - b),
    meanRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    inputRuns,
    refusedRuns,
    lastAt: list.length ? Math.max(...list.map((s) => s.startedAt)) : null,
    errors: list.reduce((total, s) => total + (Array.isArray(s.errors) ? s.errors.length : 0), 0),
  };
}

/**
 * Sessions bucketed by day, for the trend chart.
 * Days with no activity are included so the series has no gaps that could be read as zeros.
 */
export function dailyTrend(sessions, { days = 14, endDate = Date.now() } = {}) {
  const list = usable(sessions);
  const span = Math.max(1, Math.min(365, Math.round(num(days, 14))));
  const end = startOfDay(num(endDate, Date.now()));
  const buckets = [];
  for (let i = span - 1; i >= 0; i--) {
    const day = end - i * DAY_MS;
    buckets.push({ day, sessions: 0, durationMs: 0, notes: 0, kinds: {} });
  }
  const index = new Map(buckets.map((b) => [b.day, b]));
  for (const session of list) {
    const bucket = index.get(startOfDay(session.startedAt));
    if (!bucket) continue;
    bucket.sessions++;
    bucket.durationMs += Math.max(0, num(session.durationMs, 0));
    bucket.notes += Math.max(0, num(session.analysis?.objectCount, 0));
    bucket.kinds[session.kind] = (bucket.kinds[session.kind] || 0) + 1;
  }
  return buckets;
}

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** How often each playback rate was used — real usage, not a histogram of possibilities. */
export function rateHistogram(sessions) {
  const rates = usable(sessions)
    .map((s) => num(s.playback?.rate, Number.NaN))
    .filter((r) => Number.isFinite(r) && r > 0);
  const counts = new Map();
  for (const rate of rates) {
    const key = Math.round(rate * 100) / 100;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, count]) => ({ rate, count }));
}

/**
 * Aggregate timing-deviation statistics from recorded simulation and input runs.
 * Only sessions that actually carry deviations contribute; the count is reported so the UI
 * can say "from N runs" instead of implying a sample it does not have.
 */
export function timingSummary(sessions) {
  const list = usable(sessions);
  const means = [];
  const stdDevs = [];
  const unstableRates = [];
  const runs = [];

  for (const session of list) {
    for (const source of [session.simulation, session.input?.timing]) {
      if (!isPlainObject(source)) continue;
      const stdDev = num(source.stdDev ?? source.stdDevMs, Number.NaN);
      const mean = num(source.mean ?? source.meanMs, Number.NaN);
      if (!Number.isFinite(stdDev) && !Number.isFinite(mean)) continue;
      if (Number.isFinite(mean)) means.push(mean);
      if (Number.isFinite(stdDev)) stdDevs.push(stdDev);
      const ur = Number.isFinite(num(source.unstableRate, Number.NaN)) ? num(source.unstableRate) : stdDev * 10;
      if (Number.isFinite(ur)) unstableRates.push(ur);
      runs.push({ id: session.id, at: session.startedAt, kind: session.kind, mean, stdDev, unstableRate: ur, seed: session.seed });
    }
  }

  return {
    runs: runs.length,
    mean: means.length ? summarise(means) : null,
    stdDev: stdDevs.length ? summarise(stdDevs) : null,
    unstableRate: unstableRates.length ? summarise(unstableRates) : null,
    history: runs.sort((a, b) => a.at - b.at),
  };
}

/**
 * Compare two sessions field by field. Used by the session detail view and by
 * "compare with the previous run".
 * @returns {Array<{ field: string, label: string, a: unknown, b: unknown, delta: number|null, unit: string|null }>}
 */
export function compare(a, b) {
  const left = isPlainObject(a) ? a : {};
  const right = isPlainObject(b) ? b : {};
  const rows = [];
  const add = (field, label, extract, unit = null) => {
    const va = extract(left);
    const vb = extract(right);
    const both = Number.isFinite(num(va, Number.NaN)) && Number.isFinite(num(vb, Number.NaN));
    rows.push({ field, label, a: va, b: vb, delta: both ? num(vb) - num(va) : null, unit });
  };

  add('startedAt', 'Started', (s) => s.startedAt ?? null);
  add('durationMs', 'Duration', (s) => num(s.durationMs, Number.NaN), 'ms');
  add('rate', 'Playback rate', (s) => num(s.playback?.rate, Number.NaN), '×');
  add('offsetMs', 'Timing offset', (s) => num(s.playback?.offsetMs ?? s.integration?.offsetMs, Number.NaN), 'ms');
  add('scrollSpeed', 'Scroll speed', (s) => num(s.playback?.scrollSpeed, Number.NaN));
  add('objectCount', 'Notes analysed', (s) => num(s.analysis?.objectCount, Number.NaN));
  add('lnCount', 'Holds analysed', (s) => num(s.analysis?.lnCount, Number.NaN));
  add('bpm', 'BPM', (s) => num(s.analysis?.bpm, Number.NaN));
  add('peakNps', 'Peak density', (s) => num(s.analysis?.peakNps, Number.NaN), 'n/s');
  add('seeks', 'Seeks', (s) => num(s.playback?.seekCount, Number.NaN));
  add('loops', 'Loops', (s) => num(s.playback?.loopCount, Number.NaN));
  add('plannedEvents', 'Input events planned', (s) => num(s.input?.plannedEvents, Number.NaN));
  add('executedEvents', 'Input events executed', (s) => num(s.input?.executedEvents, Number.NaN));
  add('meanError', 'Mean timing error', (s) => num(s.simulation?.mean ?? s.input?.timing?.meanMs, Number.NaN), 'ms');
  add('stdDev', 'Timing spread (σ)', (s) => num(s.simulation?.stdDev ?? s.input?.timing?.stdDevMs, Number.NaN), 'ms');
  add('unstableRate', 'Unstable rate', (s) => num(s.simulation?.unstableRate, Number.NaN));
  add('errors', 'Errors', (s) => (Array.isArray(s.errors) ? s.errors.length : Number.NaN));

  return rows;
}

/**
 * Per-chart roll-up: how many sessions, total time, and the most recent one.
 * The library's "recently opened" and the dashboard's recents both read this.
 */
export function byChart(sessions) {
  const out = new Map();
  for (const session of usable(sessions)) {
    const chart = session.chart;
    if (!chart?.id) continue;
    let entry = out.get(chart.id);
    if (!entry) {
      entry = { chart, sessions: 0, totalDurationMs: 0, lastAt: 0, kinds: new Set(), lastSession: null };
      out.set(chart.id, entry);
    }
    entry.sessions++;
    entry.totalDurationMs += Math.max(0, num(session.durationMs, 0));
    entry.kinds.add(session.kind);
    if (session.startedAt >= entry.lastAt) {
      entry.lastAt = session.startedAt;
      entry.lastSession = session;
    }
  }
  return [...out.values()]
    .map((entry) => ({ ...entry, kinds: [...entry.kinds] }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

/** The most common failure codes across sessions, for the diagnostics panel. */
export function errorBreakdown(sessions) {
  const counts = new Map();
  for (const session of usable(sessions)) {
    for (const error of Array.isArray(session.errors) ? session.errors : []) {
      const key = error?.code || 'unknown';
      const entry = counts.get(key) || { code: key, count: 0, sample: null };
      entry.count++;
      if (!entry.sample) entry.sample = error.message;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/**
 * A compact, honest description of what the store holds — used by the Statistics empty
 * state so it can say what is missing rather than a generic "no data".
 */
export function coverage(sessions) {
  const list = usable(sessions);
  const has = {
    any: list.length > 0,
    analysis: list.some((s) => isPlainObject(s.analysis)),
    playback: list.some((s) => isPlainObject(s.playback)),
    timing: list.some((s) => isPlainObject(s.simulation) || isPlainObject(s.input?.timing)),
    input: list.some((s) => isPlainObject(s.input)),
    multipleCharts: new Set(list.map((s) => s.chart?.id).filter(Boolean)).size > 1,
    comparable: list.filter((s) => s.chart?.id && isPlainObject(s.analysis)).length >= 2,
  };
  const missing = Object.entries(has).filter(([key, value]) => key !== 'any' && !value).map(([key]) => key);
  return { ...has, missing };
}

export const StatisticsEngine = {
  usable, totals, dailyTrend, rateHistogram, timingSummary, compare, byChart, errorBreakdown, coverage,
  SessionKind,
};
