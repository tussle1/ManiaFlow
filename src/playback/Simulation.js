/**
 * Simulation — turning notes into a schedule of key transitions, and studying timing.
 *
 * Two jobs, both offline and both deterministic:
 *
 *   1. `buildInputSchedule` produces `[[delayMs, code, down], …]` from a chart, a lane→key
 *      map, a rate and a timing profile. This is the *only* thing the keyboard adapters
 *      execute. The timing engine decided when; this decides which key and for how long;
 *      the adapter decides how the key actually goes down.
 *   2. `simulateTimingErrors` produces the distribution of hit errors a timing profile
 *      would give, so the Timing Lab can show what a profile does without claiming it is
 *      human, undetectable, or anything other than a simulation.
 *
 * Derivation of `delayMs`. The engine's clock is `songPosition(t) = S0 + t·rate`, and
 * chart time is `songPosition − offset·rate`. Ashtonk!mania judges an event by
 * `Music.timeAtCtx(event.timeStamp) − offset·rate − input.latency·rate`, so an event
 * dispatched `t` real ms after the anchor is judged at chart time
 * `S0 + t·rate − offset·rate − latency·rate`. Anchoring at chart time `C0`
 * (so `S0 = C0 + offset·rate`) and solving for a target chart time `T` gives
 *
 *       t = (T − C0) / rate + latency
 *
 * which is what `chartDelayToRealMs` implements. Jitter is applied to `T` in chart
 * milliseconds, because that is the space the game judges in.
 *
 * SAFETY. Nothing here reaches the game's autoplay. It never touches the `AT` mod,
 * `generateAutoInputs` or `state.feed`; it produces an event list that an adapter turns
 * into key transitions. The adapters refuse to run outside practice mode.
 */

import { SeededRandom, toSeed } from '../utils/rng.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { num, validateDistribution, validateRate, LIMITS } from '../utils/validation.js';

/** The game's `VERIFY.MIN_HOLD`: a press and release closer than this "isn't a finger". */
export const MIN_HOLD_MS = 5;
/** The game's `VERIFY.BOT_UR` / `BOT_NOTES`: below this unstable rate over that many hits is flagged as a script. */
export const BOT_UNSTABLE_RATE = 15;
export const BOT_MIN_NOTES = 100;

/** Chart-time milliseconds to real milliseconds after the anchor. */
export function chartDelayToRealMs(chartDeltaMs, rate, latencyMs = 0) {
  const r = validateRate(rate).value || 1;
  return chartDeltaMs / r + num(latencyMs, 0);
}

/**
 * Sample a timing deviation from a distribution.
 * Every kind is bounded, so a large sigma cannot produce an absurd schedule.
 *
 * @param {SeededRandom} rng
 * @param {{kind:string, sigmaMs:number, rangeMs:number, biasMs:number, splitRatio:number}} distribution
 * @returns {number} deviation in chart milliseconds
 */
export function sampleDeviation(rng, distribution) {
  const d = distribution;
  switch (d.kind) {
    case 'none': return d.biasMs;
    case 'uniform': return d.biasMs + rng.range(-d.rangeMs, d.rangeMs);
    case 'gaussian': {
      // Truncated at three sigma: an unbounded Gaussian occasionally produces a value
      // that would move a note past its neighbour, which is a bug, not a distribution.
      const raw = rng.gaussian() * d.sigmaMs;
      const bounded = Math.max(-3 * d.sigmaMs, Math.min(3 * d.sigmaMs, raw));
      return d.biasMs + bounded;
    }
    case 'bimodal': {
      // Early or late, chosen by `splitRatio` — the shape a real early/late split has.
      const sign = rng.float() < d.splitRatio ? -1 : 1;
      const magnitude = Math.abs(rng.gaussian() * d.sigmaMs);
      return d.biasMs + sign * Math.min(3 * d.sigmaMs, magnitude);
    }
    default: return d.biasMs;
  }
}

/**
 * Build the key schedule for a chart.
 *
 * @param {object} config
 * @param {import('../chart/ChartParser.js').Note[]} config.notes
 * @param {string[][]} config.keyMap lane index → array of `KeyboardEvent.code`
 * @param {number} [config.rate] playback rate
 * @param {number} [config.startChartTime] chart time the anchor sits at
 * @param {number} [config.latencyMs] the game's `input.latency`, compensated for
 * @param {object} [config.distribution] timing profile (see validateDistribution)
 * @param {number|string} [config.seed]
 * @param {number} [config.tapHoldMs] how long a tap stays down, in chart ms
 * @param {number} [config.minHoldMs] floor for any hold, in real ms
 * @param {number} [config.endChartTime] stop generating after this chart time
 * @returns {{ events: Array<[number,string,0|1]>, stats: object, warnings: string[] }}
 */
export function buildInputSchedule(config = {}) {
  const notes = Array.isArray(config.notes) ? config.notes : null;
  if (!notes || !notes.length) {
    throw new AppError('There are no notes to schedule', { code: ErrorCode.PLAYBACK_NO_CHART });
  }
  const keyMap = Array.isArray(config.keyMap) ? config.keyMap : [];
  const rate = validateRate(config.rate ?? 1).value || 1;
  const startChartTime = num(config.startChartTime, 0);
  const latencyMs = num(config.latencyMs, 0);
  const distribution = validateDistribution(config.distribution);
  const rng = new SeededRandom(toSeed(config.seed ?? 1));
  const tapHoldMs = Math.max(0, num(config.tapHoldMs, 20));
  const minHoldMs = Math.max(MIN_HOLD_MS, num(config.minHoldMs, MIN_HOLD_MS));
  const endChartTime = Number.isFinite(num(config.endChartTime, Number.NaN)) ? num(config.endChartTime) : Infinity;

  const warnings = [];

  // Lanes with no key bound cannot be played; that is reported, never silently skipped.
  const unbound = [];
  const lanes = new Set(notes.map((n) => n.col));
  for (const lane of lanes) {
    const codes = keyMap[lane];
    if (!Array.isArray(codes) || !codes.length) unbound.push(lane);
  }
  if (unbound.length) {
    warnings.push(`Lane${unbound.length > 1 ? 's' : ''} ${unbound.map((l) => l + 1).join(', ')} ${unbound.length > 1 ? 'have' : 'has'} no key bound and will not be played`);
  }

  // Group by lane so a lane's transitions can be kept strictly alternating.
  const byLane = new Map();
  for (const note of notes) {
    if (note.time > endChartTime) continue;
    if (!byLane.has(note.col)) byLane.set(note.col, []);
    byLane.get(note.col).push(note);
  }

  /** @type {Array<[number, string, 0|1, number]>} delay, code, down, lane */
  const pending = [];
  const deviations = [];
  let skipped = 0;

  for (const [lane, laneNotes] of byLane) {
    const codes = keyMap[lane];
    if (!Array.isArray(codes) || !codes.length) { skipped += laneNotes.length; continue; }
    const code = codes[0];
    const sorted = [...laneNotes].sort((a, b) => a.time - b.time);
    let previousRelease = -Infinity;

    for (let i = 0; i < sorted.length; i++) {
      const note = sorted[i];
      const deviation = sampleDeviation(rng, distribution);
      deviations.push(deviation);
      const pressChart = note.time + deviation;

      // A press cannot land before the previous release in the same lane. Rather than
      // emitting input the game would reject as impossible, the note is dropped and counted.
      if (pressChart < previousRelease) { skipped++; continue; }

      let releaseChart = note.isLN ? note.end + deviation : pressChart + tapHoldMs;
      const next = sorted[i + 1];
      if (next) {
        // Never hold through the next note in the same lane.
        const latest = next.isLN ? next.time : next.time;
        if (releaseChart >= latest) releaseChart = pressChart + Math.max(0, (latest - pressChart) / 2);
      }

      const pressReal = chartDelayToRealMs(pressChart - startChartTime, rate, latencyMs);
      let releaseReal = chartDelayToRealMs(releaseChart - startChartTime, rate, latencyMs);
      if (releaseReal - pressReal < minHoldMs) releaseReal = pressReal + minHoldMs;
      if (releaseReal < pressReal) releaseReal = pressReal + minHoldMs;

      pending.push([pressReal, code, 1, lane]);
      pending.push([releaseReal, code, 0, lane]);
      previousRelease = releaseChart;
    }
  }

  // Sort by real time; a release must precede a later press of the same code at a tie.
  pending.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[3] - b[3]);

  const events = pending.map(([delay, code, down]) => [round3(delay), code, down]);
  const negative = events.filter((e) => e[0] < 0).length;
  if (negative > 0) {
    warnings.push(`${negative} event(s) fall before the anchor because the start time is after their note; the adapter plays them immediately`);
  }
  if (skipped > 0) {
    warnings.push(`${skipped} note(s) could not be scheduled (no key bound, or a press that would overlap the previous release in the same lane)`);
  }

  return {
    events,
    warnings,
    stats: {
      seed: rng.seed,
      noteCount: notes.length,
      scheduledNotes: notes.length - skipped,
      skippedNotes: skipped,
      eventCount: events.length,
      presses: events.filter((e) => e[2] === 1).length,
      releases: events.filter((e) => e[2] === 0).length,
      lanes: lanes.size,
      unboundLanes: unbound,
      rate,
      startChartTime,
      latencyMs,
      minHoldMs,
      tapHoldMs,
      distribution: { kind: distribution.kind, sigmaMs: distribution.sigmaMs, rangeMs: distribution.rangeMs, biasMs: distribution.biasMs },
      firstEventMs: events.length ? events[0][0] : null,
      lastEventMs: events.length ? events[events.length - 1][0] : null,
      realDurationMs: events.length ? events[events.length - 1][0] - events[0][0] : 0,
      timing: summarise(deviations),
    },
  };
}

/**
 * The hit errors a timing profile produces, without building a schedule.
 * This is what the Timing Lab plots, and what makes the "would this be flagged?" answer
 * concrete rather than a claim.
 */
export function simulateTimingErrors({ count = 500, distribution, seed = 1 } = {}) {
  const d = validateDistribution(distribution);
  const rng = new SeededRandom(toSeed(seed));
  const total = Math.max(1, Math.min(100000, Math.round(num(count, 500))));
  const errors = new Array(total);
  for (let i = 0; i < total; i++) errors[i] = sampleDeviation(rng, d);
  const summary = summarise(errors);
  return {
    errors,
    seed: rng.seed,
    distribution: { kind: d.kind, sigmaMs: d.sigmaMs, rangeMs: d.rangeMs, biasMs: d.biasMs, splitRatio: d.splitRatio },
    ...summary,
    // osu!'s unstable rate is ten times the standard deviation of hit errors.
    unstableRate: summary.stdDev * 10,
    wouldBeFlagged: summary.stdDev * 10 < BOT_UNSTABLE_RATE && total >= BOT_MIN_NOTES,
  };
}

/** Mean, standard deviation, extremes and percentiles of a list of millisecond values. */
export function summarise(values) {
  const list = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  if (!list.length) {
    return { count: 0, mean: 0, stdDev: 0, min: 0, max: 0, median: 0, p5: 0, p95: 0 };
  }
  const sorted = [...list].sort((a, b) => a - b);
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const variance = list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length;
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return {
    count: list.length,
    mean: round3(mean),
    stdDev: round3(Math.sqrt(variance)),
    min: round3(sorted[0]),
    max: round3(sorted[sorted.length - 1]),
    median: round3(at(0.5)),
    p5: round3(at(0.05)),
    p95: round3(at(0.95)),
  };
}

/** A histogram of millisecond errors, for the Timing Lab's distribution plot. */
export function histogram(values, { bins = 41, range } = {}) {
  const list = Array.isArray(values) ? values.filter(Number.isFinite) : [];
  const count = Math.max(3, Math.min(201, Math.round(num(bins, 41))));
  if (!list.length) return { bins: new Array(count).fill(0), edges: [], binWidth: 0, min: 0, max: 0 };
  const lo = Number.isFinite(num(range?.[0], Number.NaN)) ? num(range[0]) : Math.min(...list);
  const hi = Number.isFinite(num(range?.[1], Number.NaN)) ? num(range[1]) : Math.max(...list);
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const width = (max - min) / count || 1;
  const out = new Array(count).fill(0);
  for (const value of list) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((value - min) / width)));
    out[index]++;
  }
  const edges = Array.from({ length: count }, (_, i) => round3(min + i * width));
  return { bins: out, edges, binWidth: round3(width), min: round3(min), max: round3(max) };
}

/**
 * Validate a schedule before it is handed to an adapter. The runner validates again on the
 * other side of the wire; checking here too means a bad schedule is refused before anything
 * is armed, not halfway through pressing keys.
 */
export function validateSchedule(events, { keys } = {}) {
  const problems = [];
  if (!Array.isArray(events)) return { ok: false, problems: ['Schedule is not an array'] };
  if (!events.length) problems.push('The schedule is empty');
  if (events.length > 400000) problems.push('The schedule has more than 400 000 events');

  const held = new Set();
  let last = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!Array.isArray(event) || event.length !== 3) { problems.push(`Event ${i} is not [delayMs, code, down]`); break; }
    const [delay, code, down] = event;
    if (!Number.isFinite(delay)) { problems.push(`Event ${i} has a non-numeric delay`); break; }
    if (typeof code !== 'string' || !code) { problems.push(`Event ${i} has no key code`); break; }
    if (down !== 0 && down !== 1) { problems.push(`Event ${i} has a down flag that is not 0 or 1`); break; }
    if (delay < last - 0.001) { problems.push(`Event ${i} is out of time order`); break; }
    last = delay;
    if (down === 1) {
      if (held.has(code)) { problems.push(`${code} is pressed again before it is released (event ${i})`); break; }
      held.add(code);
    } else if (!held.delete(code)) {
      problems.push(`${code} is released without being pressed (event ${i})`);
      break;
    }
  }
  if (held.size) problems.push(`${[...held].join(', ')} still held at the end of the schedule`);
  if (keys && events.some((e) => typeof e[1] === 'string' && e[1].length > 32)) problems.push('A key code is implausibly long');

  return { ok: problems.length === 0, problems };
}

function round3(n) { return Math.round(num(n, 0) * 1000) / 1000; }

export const Simulation = {
  buildInputSchedule, simulateTimingErrors, sampleDeviation, summarise, histogram,
  validateSchedule, chartDelayToRealMs, MIN_HOLD_MS, BOT_UNSTABLE_RATE, BOT_MIN_NOTES,
};

export { LIMITS };
