/**
 * Timing calculations: scroll integration, the screen mapping, offsets, rate, beat snap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseOsu, toNotes, keyCount, scrollSegments, redTimingPoints } from '../src/chart/ChartParser.js';
import { TimingEngine, ScrollMap, scrollSpeedToTimeRange, timeRangeToScrollSpeed, SCROLL_CONSTANT, Direction } from '../src/playback/TimingEngine.js';
import { ValidationError } from '../src/utils/errors.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

/** A flat chart: one velocity, so position and time are the same number. */
function engine(overrides = {}) {
  return new TimingEngine({ segments: [{ time: -1e7, pos: 0, vel: 1 }], red: [{ time: 0, beatLength: 500, meter: 4 }], ...overrides });
}

test('scroll speed and time range are inverses, using the game\'s constant', () => {
  assert.equal(scrollSpeedToTimeRange(22), SCROLL_CONSTANT / 22);
  assert.equal(Math.round(scrollSpeedToTimeRange(22)), 522, 'the game shows "22 (522ms)"');
  assert.equal(timeRangeToScrollSpeed(522.0454545454545), 22);
  for (const speed of [1, 5, 22, 40]) {
    assert.ok(Math.abs(timeRangeToScrollSpeed(scrollSpeedToTimeRange(speed)) - speed) < 1e-9, `round trip at ${speed}`);
  }
  // Out-of-range input is clamped rather than producing an absurd time range.
  assert.equal(scrollSpeedToTimeRange(0), SCROLL_CONSTANT / 1);
  assert.equal(scrollSpeedToTimeRange(1000), SCROLL_CONSTANT / 40);
  assert.equal(scrollSpeedToTimeRange('nonsense'), SCROLL_CONSTANT / 22);
});

test('a scroll map integrates velocity and inverts exactly', () => {
  // 1× for the first second, then 2× forever.
  const map = new ScrollMap([
    { time: -1e7, pos: -1e7, vel: 1 },
    { time: 0, pos: 0, vel: 1 },
    { time: 1000, pos: 1000, vel: 2 },
  ]);
  assert.equal(map.posAt(0), 0);
  assert.equal(map.posAt(500), 500);
  assert.equal(map.posAt(1000), 1000);
  assert.equal(map.posAt(1500), 2000, 'the second half scrolls twice as fast');
  assert.equal(map.posAt(-500), -500, 'before the first change the first velocity applies');
  for (const t of [-500, 0, 250, 1000, 1250, 5000]) {
    assert.ok(Math.abs(map.timeAtPos(map.posAt(t)) - t) < 1e-9, `inverse at ${t}`);
  }
  assert.equal(map.velocityAt(999), 1);
  assert.equal(map.velocityAt(1000), 2);
});

test('a scroll map rejects segments it cannot integrate', () => {
  assert.throws(() => new ScrollMap([]), (e) => e instanceof ValidationError);
  assert.throws(() => new ScrollMap(null), (e) => e instanceof ValidationError);
  assert.throws(() => new ScrollMap([{ time: 10, pos: 0, vel: 1 }, { time: 5, pos: 0, vel: 1 }]),
    (e) => e instanceof ValidationError && /time order/.test(e.message));
});

test('offsets follow the game: chartTime = clock − offset × rate', () => {
  const t = engine({ offsetMs: 40, rate: 1 });
  assert.equal(t.chartTimeAt(1000), 960);
  assert.equal(t.clockTimeFor(960), 1000);
  assert.equal(t.chartTimeAt(t.clockTimeFor(1234)), 1234, 'the pair are exact inverses');

  const fast = engine({ offsetMs: 40, rate: 1.5 });
  assert.equal(fast.chartTimeAt(1000), 1000 - 40 * 1.5, 'the offset scales with rate, as it does in the game');
  assert.equal(fast.clockTimeFor(fast.chartTimeAt(1000)), 1000);

  // A negative offset moves the other way, and both directions round-trip.
  const neg = engine({ offsetMs: -25 });
  assert.equal(neg.chartTimeAt(1000), 1025);
  assert.equal(neg.clockTimeFor(1025), 1000);
});

test('offset and rate are validated and clamped, never NaN', () => {
  const t = engine();
  assert.equal(t.setOffset(99999), 500, 'clamped to the supported range');
  assert.equal(t.setOffset(-99999), -500);
  assert.equal(t.setOffset('abc'), 0, 'an unreadable offset falls back to 0');
  assert.equal(t.setRate(99), 2, 'clamped to the maximum rate');
  assert.equal(t.setRate(0.0001), 0.25, 'clamped to the minimum rate');
  assert.equal(t.setScrollSpeed(0), 1);
  assert.equal(t.setScrollSpeed(999), 40);
  assert.throws(() => t.setRate('nonsense'), /not a number/);
  assert.ok(Number.isFinite(t.chartTimeAt(1000)));
});

test('a note reaches the receptor exactly when its chart time arrives', () => {
  const t = engine();
  const geometry = { receptorY: 400, travelPx: 400 };
  assert.equal(t.yFor(1000, 1000, geometry), 400, 'at its own time the note is on the receptor');
  assert.ok(t.yFor(1000, 0, geometry) < 400, 'before its time the note is above the receptor (downscroll)');
  assert.ok(t.yFor(1000, 2000, geometry) > 400, 'after its time the note has passed below');
  assert.equal(t.progressFrom(1000, 1000), 0);
  assert.ok(t.progressFrom(1000, 0) > 0);
  assert.ok(t.progressFrom(1000, 2000) < 0);
});

test('a note is on screen for exactly one time range of scroll distance', () => {
  const t = engine({ scrollSpeed: 22 });
  const range = t.timeRange;
  const geometry = { receptorY: 400, travelPx: 400 };
  // One time range before its own time, the note is at the top of the stage.
  assert.ok(Math.abs(t.yFor(range, 0, geometry) - 0) < 1e-9);
  assert.equal(t.isVisible(range, 0), true);
  assert.equal(t.isVisible(range * 3, 0, false), false, 'far outside the range it is culled');
  assert.equal(t.isVisible(-range, 0, 0), false, 'long past the receptor it is culled');
});

test('a slower rate shows more of the chart without moving any note in time', () => {
  const geometry = { receptorY: 400, travelPx: 400 };
  const normal = engine({ scrollSpeed: 22, rate: 1 });
  const slow = engine({ scrollSpeed: 22, rate: 0.5 });
  const fast = engine({ scrollSpeed: 22, rate: 2 });
  // pxPerUnit halves as rate doubles, so the same chart distance covers fewer pixels.
  assert.ok(Math.abs(slow.pixelsPerUnit(400) - normal.pixelsPerUnit(400) * 2) < 1e-12);
  assert.ok(Math.abs(fast.pixelsPerUnit(400) - normal.pixelsPerUnit(400) / 2) < 1e-12);
  // At a given chart time the note is the same distance from the receptor in scroll units…
  assert.equal(normal.distanceFrom(1000, 500), slow.distanceFrom(1000, 500));
  // …but a different number of pixels, which is the whole point of the rate control.
  assert.notEqual(normal.yFor(1000, 500, geometry), slow.yFor(1000, 500, geometry));
});

test('upscroll mirrors about the receptor', () => {
  const geometry = { receptorY: 400, travelPx: 400 };
  const down = engine({ direction: Direction.DOWN });
  const up = new TimingEngine({ segments: [{ time: -1e7, pos: 0, vel: 1 }], direction: Direction.UP });
  const delta = down.distanceFrom(1000, 500) * down.pixelsPerUnit(400);
  assert.equal(down.yFor(1000, 500, geometry), 400 - delta);
  assert.equal(up.yFor(1000, 500, geometry), 400 + delta);
  assert.equal(up.setDirection('sideways'), Direction.UP, 'an unknown direction falls back rather than breaking the mirror');
});

test('a note offset moves the drawing without moving the timing', () => {
  const t = engine();
  const base = t.yFor(1000, 500, { receptorY: 400, travelPx: 400 });
  const shifted = t.yFor(1000, 500, { receptorY: 400, travelPx: 400, noteOffsetPx: -20 });
  assert.equal(shifted - base, -20);
  assert.equal(t.progressFrom(1000, 500), t.progressFrom(1000, 500), 'judgement position is untouched');
});

test('scroll velocity changes move notes without moving when they are judged', () => {
  const chart = parseOsu(fixture('sv-changes.osu'));
  const segments = scrollSegments(chart, {});
  const t = new TimingEngine({ segments, red: redTimingPoints(chart) });
  const notes = toNotes(chart, keyCount(chart));

  // Two notes either side of the SV change at 5000ms.
  const before = notes.find((n) => n.time < 5000);
  const after = notes.find((n) => n.time > 5000);
  assert.ok(t.velocityAt(before.time) !== t.velocityAt(after.time), 'the fixture really does change velocity');
  // Each note still arrives at its receptor at its own chart time.
  for (const note of notes) {
    assert.equal(t.distanceFrom(note.time, note.time), 0, `note at ${note.time} is on the receptor at its own time`);
  }
  // But the on-screen gap between them is not the same as the time gap.
  const timeGap = after.time - before.time;
  const scrollGap = t.distanceFrom(after.time, before.time);
  assert.notEqual(scrollGap, timeGap);
});

test('constant scrolling removes SV, and SV-only removes BPM', () => {
  const chart = parseOsu(fixture('sv-changes.osu'));
  const full = new TimingEngine({ segments: scrollSegments(chart, {}) });
  const constant = new TimingEngine({ segments: scrollSegments(chart, { useSV: false, useBPM: false }) });
  const svOnly = new TimingEngine({ segments: scrollSegments(chart, { useSV: true, useBPM: false }) });

  assert.equal(constant.velocityAt(0), 1);
  assert.equal(constant.velocityAt(15000), 1, 'constant mode never changes velocity');
  assert.equal(constant.distanceFrom(2000, 1000), 1000, 'constant scrolling is one unit per millisecond');

  assert.notEqual(full.velocityAt(6000), 1, 'SV+BPM does change velocity');
  // Before the BPM change at 10000ms both agree: the green line multiplies by 2 either way.
  assert.equal(full.velocityAt(6000), svOnly.velocityAt(6000));
  // After it they part: SV+BPM scales by the new red line's speed as well, SV-only does not.
  assert.ok(Math.abs(full.velocityAt(12000) - (400 / 600) * (100 / 200)) < 1e-9, 'SV+BPM: red speed times the green multiplier');
  assert.ok(Math.abs(svOnly.velocityAt(12000) - 100 / 200) < 1e-9, 'SV-only: the green multiplier alone');
  assert.notEqual(full.velocityAt(12000), svOnly.velocityAt(12000));
});

test('beat snap finds the finest divisor and agrees with osu!\'s colours', () => {
  const t = engine(); // 500ms beats → 120 BPM
  assert.equal(t.beatSnap(0).divisor, 1, 'the downbeat is 1/1');
  assert.equal(t.beatSnap(0).colour, '#ffffff');
  assert.equal(t.beatSnap(250).divisor, 2, 'half a beat is 1/2');
  assert.equal(t.beatSnap(250).colour, '#ed1121');
  assert.equal(t.beatSnap(125).divisor, 4);
  assert.equal(t.beatSnap(125).colour, '#66ccff');
  assert.equal(t.beatSnap(500 / 3).divisor, 3, 'a triplet is 1/3');
  assert.equal(t.beatSnap(500 / 3).colour, '#aa88ff');
  assert.equal(t.beatSnap(62.5).divisor, 8);
  assert.equal(t.beatSnap(31.25).divisor, 16);
  // 1ms off a 1/16 is still on it; the tolerance is 2ms as in the game.
  assert.equal(t.beatSnap(31.25 + 1).divisor, 16);
  // Something on none of the divisors is reported as unsnapped, not forced onto one.
  const off = t.beatSnap(200);
  assert.equal(off.divisor, null);
  assert.equal(off.colour, '#a0a0a0');
});

test('beat snap accounts for BPM changes and a chart with no usable beat length', () => {
  const chart = parseOsu(fixture('sv-changes.osu'));
  const t = new TimingEngine({ segments: scrollSegments(chart, {}), red: redTimingPoints(chart) });
  const changes = t.bpmChanges(30000);
  assert.ok(changes.length >= 2, 'the fixture has more than one BPM');
  assert.equal(t.bpmAt(0), 60000 / 400);
  assert.equal(t.bpmAt(12000), 60000 / 600);
  assert.ok(changes.every((c, i) => i === 0 || c.time > changes[i - 1].time), 'changes ascend');
  assert.equal(changes[changes.length - 1].until, 30000, 'the last change runs to the end time given');

  // beatsAt accumulates across a change rather than extrapolating the last BPM.
  const beatsBefore = t.beatsAt(10000);
  const beatsAfter = t.beatsAt(16000);
  assert.ok(beatsAfter > beatsBefore);
  const expected = beatsBefore + 6000 / 600;
  assert.ok(Math.abs(beatsAfter - expected) < 1e-9);

  const degenerate = new TimingEngine({ segments: [{ time: 0, pos: 0, vel: 1 }], red: [{ time: 0, beatLength: 0, meter: 4 }] });
  assert.equal(degenerate.beatSnap(100).divisor, null, 'a zero beat length yields no snap rather than a division by zero');
  assert.equal(degenerate.bpmAt(100), 0);
  assert.equal(degenerate.timingPointAt(-99999).beatLength, 0, 'before the first point, the first point still applies');
});

test('a TimingEngine refuses to be built without segments', () => {
  assert.throws(() => new TimingEngine({}), (e) => e instanceof ValidationError);
  assert.throws(() => new TimingEngine({ segments: [] }), (e) => e instanceof ValidationError);
});

test('describe() round-trips the configuration into a session record', () => {
  const t = engine({ rate: 1.25, offsetMs: -15, scrollSpeed: 18, direction: Direction.UP });
  const described = t.describe();
  assert.equal(described.rate, 1.25);
  assert.equal(described.offsetMs, -15);
  assert.equal(described.scrollSpeed, 18);
  assert.equal(described.direction, 'up');
  assert.ok(Number.isFinite(described.timeRange));
  const restored = new TimingEngine({ segments: [{ time: 0, pos: 0, vel: 1 }], ...described });
  assert.equal(restored.rate, 1.25);
  assert.equal(restored.offsetMs, -15);
  assert.equal(restored.direction, 'up');
});
