/**
 * Schedule generation, seeded timing variation, and the safety properties of both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInputSchedule, simulateTimingErrors, sampleDeviation, summarise, histogram,
  validateSchedule, chartDelayToRealMs, MIN_HOLD_MS, BOT_UNSTABLE_RATE,
} from '../src/playback/Simulation.js';
import { SeededRandom, toSeed } from '../src/utils/rng.js';
import { validateDistribution } from '../src/utils/validation.js';
import { AppError } from '../src/utils/errors.js';
import { parseOsu, toNotes, keyCount } from '../src/chart/ChartParser.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const KEYMAP_4K = [['KeyD'], ['KeyF'], ['KeyJ'], ['KeyK']];

function notesFrom(name) {
  const chart = parseOsu(fixture(name));
  return toNotes(chart, keyCount(chart));
}

/* ── determinism ─────────────────────────────────────────────────────── */

test('the same seed produces a byte-identical schedule', () => {
  const notes = notesFrom('chords-jacks.osu');
  const a = buildInputSchedule({ notes, keyMap: KEYMAP_4K, seed: 42, distribution: { kind: 'gaussian', sigmaMs: 12 } });
  const b = buildInputSchedule({ notes, keyMap: KEYMAP_4K, seed: 42, distribution: { kind: 'gaussian', sigmaMs: 12 } });
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.stats.timing, b.stats.timing);
  assert.equal(a.stats.seed, toSeed(42));
});

test('a different seed produces a different schedule', () => {
  const notes = notesFrom('chords-jacks.osu');
  const config = { notes, keyMap: KEYMAP_4K, distribution: { kind: 'gaussian', sigmaMs: 12 } };
  const a = buildInputSchedule({ ...config, seed: 1 });
  const b = buildInputSchedule({ ...config, seed: 2 });
  assert.notDeepEqual(a.events, b.events);
  assert.equal(a.events.length, b.events.length, 'the note count does not change, only the timing');
});

test('the seeded RNG is reproducible and independent of call order elsewhere', () => {
  const a = new SeededRandom('same-seed');
  const b = new SeededRandom('same-seed');
  const va = Array.from({ length: 20 }, () => a.gaussian());
  const vb = Array.from({ length: 20 }, () => b.gaussian());
  assert.deepEqual(va, vb);
  a.reset();
  assert.deepEqual(Array.from({ length: 20 }, () => a.gaussian()), va, 'reset returns to the seed');
  assert.notEqual(toSeed('a'), toSeed('b'));
  assert.equal(toSeed(7), toSeed(7));
});

/* ── rate and offset arithmetic ──────────────────────────────────────── */

test('delay scales inversely with rate, as a faster chart arrives sooner', () => {
  assert.equal(chartDelayToRealMs(1000, 1), 1000);
  assert.equal(chartDelayToRealMs(1000, 2), 500, 'at 2× a second of chart takes half a second');
  assert.equal(chartDelayToRealMs(1000, 0.5), 2000);
  assert.equal(chartDelayToRealMs(1000, 1, 25), 1025, 'input latency is added in real milliseconds');
  assert.equal(chartDelayToRealMs(0, 1.5), 0, 'the anchor note has no delay');
});

test('a whole schedule compresses by the rate, keeping the order', () => {
  const notes = notesFrom('basic-4k.osu');
  const config = { notes, keyMap: KEYMAP_4K, startChartTime: 0, distribution: { kind: 'none' } };
  const normal = buildInputSchedule({ ...config, rate: 1 });
  const double = buildInputSchedule({ ...config, rate: 2 });
  assert.deepEqual(
    double.events.map((e) => [Math.round(e[0] * 2 * 1000) / 1000, e[1], e[2]]),
    normal.events.map((e) => [e[0], e[1], e[2]]),
    'halving every delay reproduces the 1× schedule',
  );
});

test('the start time shifts every event by the same amount', () => {
  const notes = notesFrom('basic-4k.osu');
  const base = buildInputSchedule({ notes, keyMap: KEYMAP_4K, startChartTime: 0, distribution: { kind: 'none' } });
  // Anchoring at 2000ms puts the first two notes (1000, 1500) before the anchor.
  const later = buildInputSchedule({ notes, keyMap: KEYMAP_4K, startChartTime: 2000, distribution: { kind: 'none' } });
  const deltas = later.events.map((e, i) => e[0] - base.events[i][0]);
  assert.ok(deltas.every((d) => Math.abs(d + 2000) < 1e-6), 'starting 2s later moves everything 2s earlier');
  // Each of those two notes contributes a press and a release, so four events are negative.
  const beforeAnchor = notes.filter((n) => n.time < 2000);
  assert.equal(beforeAnchor.length, 2, 'the fixture has two notes before the anchor');
  assert.equal(later.events.filter((e) => e[0] < 0).length, beforeAnchor.length * 2,
    'each contributes a press and a release before the anchor');
  assert.ok(later.warnings.some((w) => /before the anchor/.test(w)), 'and the user is told about them');
});

/* ── holds, chords and impossible input ──────────────────────────────── */

test('every press is followed by a release, and no key is ever doubled up', () => {
  for (const name of ['basic-4k.osu', 'chords-jacks.osu', 'sv-changes.osu', 'spinners-8k.osu', 'sliders.osu']) {
    const notes = notesFrom(name);
    const keys = notes.keys;
    const keyMap = Array.from({ length: keys }, (_, i) => [`Key${String.fromCharCode(65 + i)}`]);
    const schedule = buildInputSchedule({ notes, keyMap, seed: 7, distribution: { kind: 'gaussian', sigmaMs: 15 } });
    const check = validateSchedule(schedule.events);
    assert.ok(check.ok, `${name}: ${check.problems.join('; ')}`);
  }
});

test('a hold stays down for the length of the long note', () => {
  const notes = notesFrom('basic-4k.osu');
  const schedule = buildInputSchedule({ notes, keyMap: KEYMAP_4K, rate: 1, distribution: { kind: 'none', biasMs: 0 } });
  const hold = notes.find((n) => n.isLN);
  assert.ok(hold, 'the fixture has a hold');
  const code = KEYMAP_4K[hold.col][0];
  const down = schedule.events.find((e) => e[2] === 1 && Math.abs(e[0] - hold.time) < 1e-6);
  assert.ok(down, `the hold at ${hold.time} is pressed`);
  const up = schedule.events.find((e) => e[2] === 0 && e[0] > down[0] && e[1] === code);
  assert.ok(up, 'and released');
  assert.ok(Math.abs((up[0] - down[0]) - (hold.end - hold.time)) < 1e-6, 'the real hold equals the chart hold at 1×');
});

test('a hold is scaled by the rate just like a tap', () => {
  const notes = notesFrom('basic-4k.osu');
  const hold = notes.find((n) => n.isLN);
  const chartHold = hold.end - hold.time;
  // Delays are stored rounded to three decimals, so comparisons allow for that.
  const EPS = 0.002;
  for (const rate of [0.5, 1, 1.5, 2]) {
    const schedule = buildInputSchedule({ notes, keyMap: KEYMAP_4K, rate, distribution: { kind: 'none' } });
    const code = KEYMAP_4K[hold.col][0];
    const down = schedule.events.find((e) => e[2] === 1 && e[1] === code && Math.abs(e[0] - hold.time / rate) < EPS);
    assert.ok(down, `rate ${rate}: the hold is pressed at ${hold.time / rate}ms`);
    const up = schedule.events.find((e) => e[2] === 0 && e[1] === code && e[0] > down[0]);
    assert.ok(up, `rate ${rate}: the hold is released`);
    assert.ok(Math.abs((up[0] - down[0]) - chartHold / rate) < EPS, `rate ${rate}: the hold lasts ${chartHold / rate}ms`);
  }
});

test('no release is shorter than the game\'s own MIN_HOLD', () => {
  // A press and release closer than 5ms is what Ashtonk!mania's verifier rejects as
  // "impossible input", so the schedule must never contain one.
  const notes = notesFrom('chords-jacks.osu');
  for (const kind of ['none', 'uniform', 'gaussian', 'bimodal']) {
    const schedule = buildInputSchedule({
      notes, keyMap: KEYMAP_4K, seed: 3, tapHoldMs: 0,
      distribution: { kind, sigmaMs: 40, rangeMs: 40 },
    });
    const downs = new Map();
    for (const [delay, code, down] of schedule.events) {
      if (down === 1) downs.set(code, delay);
      else {
        const held = delay - downs.get(code);
        assert.ok(held >= MIN_HOLD_MS - 1e-9, `${kind}: a ${held.toFixed(3)}ms hold is below ${MIN_HOLD_MS}ms`);
      }
    }
    assert.equal(schedule.stats.minHoldMs, MIN_HOLD_MS);
  }
});

test('a tap hold is configurable and defaults to something playable', () => {
  const notes = notesFrom('basic-4k.osu');
  const tap = notes.find((n) => !n.isLN);
  const code = KEYMAP_4K[tap.col][0];
  const held = (tapHoldMs) => {
    const schedule = buildInputSchedule({ notes, keyMap: KEYMAP_4K, tapHoldMs, distribution: { kind: 'none' } });
    const down = schedule.events.find((e) => e[2] === 1 && e[1] === code && Math.abs(e[0] - tap.time) < 1e-6);
    const up = schedule.events.find((e) => e[2] === 0 && e[1] === code && e[0] > down[0]);
    return up[0] - down[0];
  };
  assert.ok(Math.abs(held(20) - 20) < 1e-6);
  assert.ok(Math.abs(held(60) - 60) < 1e-6);
  assert.ok(held(0) >= MIN_HOLD_MS, 'a zero tap hold is lifted to the legal minimum');
});

test('a chord presses every lane at the same instant, on different keys', () => {
  const notes = notesFrom('chords-jacks.osu');
  const chordTime = notes[0].time;
  const chord = notes.filter((n) => n.time === chordTime);
  assert.ok(chord.length >= 3, 'the fixture opens with a chord');
  const schedule = buildInputSchedule({ notes, keyMap: KEYMAP_4K, distribution: { kind: 'none' } });
  const presses = schedule.events.filter((e) => e[2] === 1 && Math.abs(e[0] - chordTime) < 1e-6);
  assert.equal(presses.length, chord.length, 'one press per note in the chord');
  assert.equal(new Set(presses.map((p) => p[1])).size, chord.length, 'each on its own key');
});

test('a note that cannot be scheduled is counted, never dropped silently', () => {
  const notes = notesFrom('basic-4k.osu');
  const keyMap = [null, ['KeyF'], ['KeyJ'], ['KeyK']];
  const schedule = buildInputSchedule({ notes, keyMap, distribution: { kind: 'none' } });
  const unplayable = notes.filter((n) => n.col === 0).length;
  assert.equal(schedule.stats.skippedNotes, unplayable);
  assert.deepEqual(schedule.stats.unboundLanes, [0]);
  assert.ok(schedule.warnings.some((w) => /Lane 1 has no key bound/.test(w)));
  assert.equal(schedule.stats.scheduledNotes + schedule.stats.skippedNotes, schedule.stats.noteCount);
  assert.ok(!schedule.events.some((e) => e[1] == null));
});

test('an empty note list is an error, not an empty schedule', () => {
  assert.throws(() => buildInputSchedule({ notes: [], keyMap: KEYMAP_4K }), (e) => e instanceof AppError);
  assert.throws(() => buildInputSchedule({ notes: null, keyMap: KEYMAP_4K }), (e) => e instanceof AppError);
});

test('a schedule can be limited to part of a chart', () => {
  const notes = notesFrom('basic-4k.osu');
  const full = buildInputSchedule({ notes, keyMap: KEYMAP_4K, distribution: { kind: 'none' } });
  const partial = buildInputSchedule({ notes, keyMap: KEYMAP_4K, endChartTime: 5000, distribution: { kind: 'none' } });
  assert.ok(partial.events.length < full.events.length);
  // A hold that starts before the cut-off still finishes after it, so the last event is the
  // end of the last included note rather than the cut-off itself.
  const included = notes.filter((n) => n.time <= 5000);
  const expectedLast = Math.max(...included.map((n) => (n.isLN ? n.end : n.time + partial.stats.tapHoldMs)));
  assert.ok(Math.abs(partial.stats.lastEventMs - expectedLast) < 0.002, `last event ${partial.stats.lastEventMs} vs ${expectedLast}`);
  assert.ok(included.length < notes.length, 'the fixture really does continue past the cut-off');
});

/* ── distributions ───────────────────────────────────────────────────── */

test('every distribution is bounded and centred where it claims to be', () => {
  const rng = new SeededRandom(99);
  for (const kind of ['none', 'uniform', 'gaussian', 'bimodal']) {
    const d = validateDistribution({ kind, sigmaMs: 20, rangeMs: 30, biasMs: 5, splitRatio: 0.5 });
    const samples = Array.from({ length: 20000 }, () => sampleDeviation(rng, d));
    const s = summarise(samples);
    assert.ok(s.count === 20000);
    assert.ok(Number.isFinite(s.mean) && Number.isFinite(s.stdDev), `${kind}: finite statistics`);
    if (kind === 'none') {
      assert.equal(s.stdDev, 0, 'no variation means no variation');
      assert.equal(s.mean, 5, 'and the bias is applied exactly');
    }
    if (kind === 'uniform') {
      assert.ok(s.min >= 5 - 30 - 1e-9 && s.max <= 5 + 30 + 1e-9, `${kind}: inside ±range`);
      assert.ok(Math.abs(s.mean - 5) < 1, `${kind}: centred on the bias`);
    }
    if (kind === 'gaussian') {
      assert.ok(s.min >= 5 - 60 - 1e-9 && s.max <= 5 + 60 + 1e-9, 'truncated at three sigma');
      assert.ok(Math.abs(s.mean - 5) < 1.5, `${kind}: centred on the bias`);
      assert.ok(Math.abs(s.stdDev - 20) < 2, `${kind}: sigma is honoured`);
    }
    if (kind === 'bimodal') {
      assert.ok(s.min <= 0 && s.max >= 10, `${kind}: spread to both sides of the bias`);
      assert.ok(Math.abs(s.mean - 5) < 2, `${kind}: roughly centred`);
    }
  }
});

test('a distribution is validated, so a bad preference cannot produce an absurd schedule', () => {
  const d = validateDistribution({ kind: 'nonsense', sigmaMs: 1e9, rangeMs: -5, biasMs: 'x', seed: -3 });
  assert.equal(d.kind, 'none', 'an unknown kind falls back to no variation');
  assert.equal(d.sigmaMs, 200, 'sigma is clamped to the supported maximum');
  assert.equal(d.rangeMs, 0, 'a negative range is clamped to zero');
  assert.equal(d.biasMs, 0, 'an unreadable bias falls back');
  assert.equal(d.seed, 0, 'a negative seed clamps into range rather than falling back');
  assert.ok(d.errors.length > 0, 'and the clamping is reported');
  assert.ok(!d.errors.some((e) => e.field === 'splitRatio'), 'a field left out is not an error');

  const clean = validateDistribution({ kind: 'gaussian', sigmaMs: 10 });
  assert.equal(clean.kind, 'gaussian');
  assert.equal(clean.sigmaMs, 10);
  assert.deepEqual(clean.errors, [], 'a partial but valid configuration reports nothing');
  assert.equal(clean.seed, 1, 'omitted fields still take their defaults');
  assert.equal(clean.splitRatio, 0.5);
  assert.deepEqual(validateDistribution(undefined).errors, [], 'no configuration at all is simply the defaults');
});

test('a split ratio moves a bimodal distribution from early to late', () => {
  const rng = new SeededRandom(5);
  const early = validateDistribution({ kind: 'bimodal', sigmaMs: 20, splitRatio: 1 });
  const late = validateDistribution({ kind: 'bimodal', sigmaMs: 20, splitRatio: 0 });
  const meanOf = (d) => summarise(Array.from({ length: 20000 }, () => sampleDeviation(rng, d))).mean;
  assert.ok(meanOf(early) < 0, 'splitRatio 1 is entirely early');
  assert.ok(meanOf(late) > 0, 'splitRatio 0 is entirely late');
});

/* ── timing-error study ──────────────────────────────────────────────── */

test('simulated timing errors are reproducible and honestly labelled', () => {
  const a = simulateTimingErrors({ count: 1000, seed: 11, distribution: { kind: 'gaussian', sigmaMs: 20 } });
  const b = simulateTimingErrors({ count: 1000, seed: 11, distribution: { kind: 'gaussian', sigmaMs: 20 } });
  assert.deepEqual(a.errors, b.errors);
  assert.equal(a.errors.length, 1000);
  assert.ok(Math.abs(a.unstableRate - a.stdDev * 10) < 1e-9, 'UR is ten times the standard deviation');
  assert.ok(a.unstableRate > 100, 'a 20ms sigma is far above the game\'s bot threshold');
  assert.equal(a.wouldBeFlagged, false);
});

test('perfect timing is exactly what the game flags as inhuman', () => {
  // This is the honest core of the safety story: VERIFY.BOT_UR is 15 over BOT_NOTES 100.
  const perfect = simulateTimingErrors({ count: 500, seed: 1, distribution: { kind: 'none', biasMs: 0 } });
  assert.equal(perfect.stdDev, 0);
  assert.equal(perfect.unstableRate, 0);
  assert.equal(perfect.wouldBeFlagged, true, 'a zero-UR run over 100+ notes is what the verifier rejects');

  const human = simulateTimingErrors({ count: 500, seed: 1, distribution: { kind: 'gaussian', sigmaMs: 8 } });
  assert.ok(human.unstableRate > BOT_UNSTABLE_RATE);
  assert.equal(human.wouldBeFlagged, false);

  // Under the threshold but with too few notes is not flagged either.
  const short = simulateTimingErrors({ count: 50, seed: 1, distribution: { kind: 'none' } });
  assert.equal(short.wouldBeFlagged, false, 'the note count matters as much as the UR');
});

test('statistics survive empty, single and pathological inputs', () => {
  assert.equal(summarise([]).count, 0);
  assert.equal(summarise([]).stdDev, 0);
  assert.equal(summarise(null).count, 0);
  assert.equal(summarise([5]).count, 1);
  assert.equal(summarise([5]).stdDev, 0);
  assert.equal(summarise([5]).median, 5);
  const withJunk = summarise([1, NaN, 2, Infinity, 3, null, 4]);
  assert.equal(withJunk.count, 4, 'non-finite values are dropped rather than poisoning the mean');
  assert.equal(withJunk.mean, 2.5);
});

test('a histogram bins every value exactly once', () => {
  const values = Array.from({ length: 1000 }, (_, i) => (i % 100) - 50);
  const h = histogram(values, { bins: 21 });
  assert.equal(h.bins.length, 21);
  assert.equal(h.bins.reduce((a, b) => a + b, 0), values.length);
  assert.equal(h.edges.length, 21);
  assert.ok(h.binWidth > 0);
  assert.equal(h.min, -50);
  assert.equal(h.max, 49);
  assert.deepEqual(histogram([], { bins: 10 }).bins, new Array(10).fill(0));
  // A constant list has no width; the bin width must not become zero or NaN.
  const flat = histogram([3, 3, 3], { bins: 5 });
  assert.ok(flat.binWidth > 0);
  assert.equal(flat.bins.reduce((a, b) => a + b, 0), 3);
});

/* ── schedule validation ─────────────────────────────────────────────── */

test('validateSchedule catches the ways a schedule can be wrong', () => {
  assert.equal(validateSchedule([[0, 'KeyD', 1], [20, 'KeyD', 0]]).ok, true);
  assert.equal(validateSchedule([]).ok, false, 'an empty schedule is refused');
  assert.equal(validateSchedule(null).ok, false);
  assert.equal(validateSchedule([[0, 'KeyD', 1]]).ok, false, 'a key left down is refused');
  assert.equal(validateSchedule([[0, 'KeyD', 0]]).ok, false, 'a release with no press is refused');
  assert.equal(validateSchedule([[0, 'KeyD', 1], [10, 'KeyD', 1], [20, 'KeyD', 0]]).ok, false, 'a double press is refused');
  assert.equal(validateSchedule([[10, 'KeyD', 1], [5, 'KeyD', 0]]).ok, false, 'out of order is refused');
  assert.equal(validateSchedule([[0, 'KeyD', 'yes'], [10, 'KeyD', 0]]).ok, false, 'a non-binary flag is refused');
  assert.equal(validateSchedule([[0, '', 1], [10, '', 0]]).ok, false, 'an empty code is refused');
  assert.equal(validateSchedule([['soon', 'KeyD', 1]]).ok, false, 'a non-numeric delay is refused');
  assert.equal(validateSchedule([[0, 'KeyD']]).ok, false, 'a malformed event is refused');
  const problems = validateSchedule([[0, 'KeyD', 1]]).problems;
  assert.ok(problems.some((p) => /still held/.test(p)), 'the message names the stuck key');
});
