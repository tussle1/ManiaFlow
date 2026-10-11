/**
 * Chart parsing and validation.
 *
 * `tests/fixtures/expected.json` was produced by running Ashtonk!mania's own
 * `BeatmapParser` over these same files, so every assertion below compares ManiaFlow
 * against the game rather than against ManiaFlow's idea of itself. Where the two are
 * meant to differ — osu!standard conversion — the test says so explicitly instead of
 * quietly passing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseOsu, toNotes, keyCount, scrollSegments, barLines, redTimingPoints, dominantBeatLength } from '../src/chart/ChartParser.js';
import { validateChart, isPreviewable, primaryIssue } from '../src/chart/ChartValidator.js';
import { analyse, densityBins, noteIntervals, simultaneousGroups, countJacks, peakNotesPerSecond } from '../src/chart/ChartMetadata.js';
import { ChartError } from '../src/utils/errors.js';
import { ErrorCode } from '../src/utils/errors.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const EXPECTED = JSON.parse(fixture('expected.json'));

/** The charts whose notes ManiaFlow computes itself, mode 3 only. */
const MANIA_FIXTURES = ['basic-4k.osu', 'sv-changes.osu', 'chords-jacks.osu', 'spinners-8k.osu', 'sliders.osu', 'legacy-v3.osu', 'corrupt-lines.osu', 'empty-notes.osu'];

test('a mania chart parses to the metadata the game reads', () => {
  for (const name of Object.keys(EXPECTED)) {
    const want = EXPECTED[name];
    if (want.parseError) continue;
    const chart = parseOsu(fixture(name));
    assert.equal(chart.formatVersion, want.formatVersion, `${name}: format version`);
    assert.equal(chart.mode, want.mode, `${name}: mode`);
    assert.equal(chart.od, want.od, `${name}: OD`);
    assert.equal(chart.hp, want.hp, `${name}: HP`);
    assert.equal(chart.cs, want.cs, `${name}: CS`);
    assert.equal(chart.audioFilename, want.audioFilename, `${name}: audio filename`);
    assert.equal(chart.previewTime, want.previewTime, `${name}: preview time`);
    assert.equal(chart.version, want.version, `${name}: difficulty name`);
    assert.equal(chart.timingPoints.length, want.timingPointCount, `${name}: timing point count`);
    assert.equal(chart.hitObjects.length, want.hitObjectCount, `${name}: hit object count`);
    assert.deepEqual(chart.events.breaks, want.breaks, `${name}: breaks`);
    assert.equal(chart.events.background?.file ?? null, want.background, `${name}: background`);
    assert.equal(chart.events.storyboard, want.storyboard, `${name}: storyboard flag`);
  }
});

test('notes match the game note for note, lane for lane', () => {
  for (const name of MANIA_FIXTURES) {
    const want = EXPECTED[name].notes;
    const chart = parseOsu(fixture(name));
    const notes = toNotes(chart, keyCount(chart));
    assert.equal(notes.length, want.length, `${name}: note count`);
    notes.forEach((note, i) => {
      const [time, end, col, isLN] = want[i];
      assert.deepEqual(
        [note.time, note.end, note.col, note.isLN ? 1 : 0],
        [time, end, col, isLN],
        `${name}: note ${i}`,
      );
    });
  }
});

test('spinners land in the lanes lazer\'s seeded generator picks', () => {
  // The 8K spinner fixture exercises three separate paths: the finish-hitsound special
  // case (col 0), the >=100ms hold rule, and the seeded column search starting at 1.
  const chart = parseOsu(fixture('spinners-8k.osu'));
  const notes = toNotes(chart, keyCount(chart));
  const want = EXPECTED['spinners-8k.osu'].notes;
  assert.deepEqual(notes.map((n) => [n.time, n.end, n.col, n.isLN ? 1 : 0]), want);
  const holds = notes.filter((n) => n.isLN);
  assert.ok(holds.length > 0, 'spinners of at least 100ms become holds');
});

test('slider holds use lazer\'s control-point stack', () => {
  const chart = parseOsu(fixture('sliders.osu'));
  const notes = toNotes(chart, keyCount(chart));
  assert.deepEqual(notes.map((n) => [n.time, n.end, n.col, n.isLN ? 1 : 0]), EXPECTED['sliders.osu'].notes);
  // A zero-length slider is a tap, not a hold.
  const zeroLength = notes.find((n) => n.time === 14000);
  assert.ok(zeroLength && !zeroLength.isLN, 'a slider with no length is a tap');
});

test('a pre-v5 file has every time shifted 24ms later, as osu! does', () => {
  const chart = parseOsu(fixture('legacy-v3.osu'));
  assert.equal(chart.formatVersion, 3);
  // The game's own expected notes already carry the shift, so the times are compared as-is.
  assert.deepEqual(chart.hitObjects.map((o) => o.time), EXPECTED['legacy-v3.osu'].notes.map((n) => n[0]));
  assert.deepEqual(chart.hitObjects.map((o) => o.time), [1024, 2024, 9024], 'each source time moved 24ms later');
  assert.equal(chart.events.breaks[0].start, 9000 + 24);
  assert.equal(chart.previewTime, -1);
});

test('unreadable lines are skipped and counted, never fatal', () => {
  const chart = parseOsu(fixture('corrupt-lines.osu'));
  assert.equal(chart.hitObjects.length, EXPECTED['corrupt-lines.osu'].hitObjectCount);
  assert.equal(chart.timingPoints.length, EXPECTED['corrupt-lines.osu'].timingPointCount);
  assert.ok(chart.skipped.hitObjects > 0, 'bad hit object lines are reported, not dropped silently');
  assert.ok(chart.skipped.timingPoints > 0, 'bad timing point lines are reported, not dropped silently');
  const result = validateChart(chart);
  assert.ok(result.warnings.some((w) => /skipped/.test(w)), 'the skip count reaches the user as a warning');
});

test('an LN that overlaps the next note in its lane is dropped, as the game drops it', () => {
  const chart = parseOsu(fixture('corrupt-lines.osu'));
  const notes = toNotes(chart, keyCount(chart));
  assert.equal(notes.length, EXPECTED['corrupt-lines.osu'].notes.length);
  // Nothing may start at or before the previous note's end in the same lane.
  const lastEnd = new Map();
  for (const note of notes) {
    const previous = lastEnd.get(note.col);
    assert.ok(previous === undefined || note.time > previous, `lane ${note.col} overlap at ${note.time}`);
    lastEnd.set(note.col, note.isLN ? note.end : note.time);
  }
});

test('notes are sorted by time, then lane', () => {
  for (const name of MANIA_FIXTURES) {
    const notes = toNotes(parseOsu(fixture(name)), keyCount(parseOsu(fixture(name))));
    for (let i = 1; i < notes.length; i++) {
      const a = notes[i - 1];
      const b = notes[i];
      assert.ok(a.time < b.time || (a.time === b.time && a.col <= b.col), `${name}: order at ${i}`);
    }
  }
});

test('notes are indexed by lane for rendering and scheduling', () => {
  const chart = parseOsu(fixture('chords-jacks.osu'));
  const notes = toNotes(chart, keyCount(chart));
  assert.equal(notes.byColumn.length, notes.keys);
  const total = notes.byColumn.reduce((sum, column) => sum + column.length, 0);
  assert.equal(total, notes.length, 'every note appears in exactly one lane');
  for (const [index, column] of notes.byColumn.entries()) {
    for (const note of column) assert.equal(note.col, index);
  }
});

test('BPM is the beat length covering the longest span between the first and last note', () => {
  for (const name of MANIA_FIXTURES) {
    const chart = parseOsu(fixture(name));
    const timing = EXPECTED[name].timing;
    assert.equal(dominantBeatLength(chart), timing.dominantBeatLength, `${name}: dominant beat length`);
    const red = redTimingPoints(chart);
    const bpms = red.map((tp) => 60000 / tp.beatLength);
    assert.equal(60000 / dominantBeatLength(chart), timing.bpm, `${name}: bpm`);
    assert.equal(Math.min(...bpms), timing.bpmMin, `${name}: bpm min`);
    assert.equal(Math.max(...bpms), timing.bpmMax, `${name}: bpm max`);
    assert.equal(red.length, timing.redCount, `${name}: red line count`);
  }
});

test('scroll segments integrate red and green lines the way the game does', () => {
  for (const name of MANIA_FIXTURES) {
    const want = EXPECTED[name].segments;
    if (!Array.isArray(want)) continue;
    const chart = parseOsu(fixture(name));
    const got = scrollSegments(chart, {});
    assert.equal(got.length, want.length, `${name}: segment count`);
    got.forEach((segment, i) => {
      const [time, pos, vel] = want[i];
      assert.ok(Math.abs(segment.time - time) < 1e-6, `${name}: segment ${i} time`);
      assert.ok(Math.abs(segment.pos - pos) < 1e-6, `${name}: segment ${i} pos`);
      assert.ok(Math.abs(segment.vel - vel) < 1e-9, `${name}: segment ${i} vel`);
    });
  }
});

test('constant scrolling ignores SV, and SV-only ignores BPM', () => {
  const chart = parseOsu(fixture('sv-changes.osu'));
  const constant = scrollSegments(chart, { useSV: false, useBPM: false });
  assert.ok(constant.every((segment) => segment.vel === 1), 'constant mode has one speed throughout');
  const svOnly = scrollSegments(chart, { useSV: true, useBPM: false });
  const full = scrollSegments(chart, {});
  assert.notDeepEqual(svOnly.map((s) => s.vel), full.map((s) => s.vel), 'SV-only differs from SV+BPM on a BPM-changing chart');
});

test('bar lines follow the time signature and the omit-first-bar effect', () => {
  const chart = parseOsu(fixture('basic-4k.osu'));
  const notes = toNotes(chart, keyCount(chart));
  const endTime = Math.max(...notes.map((n) => n.end));
  const bars = barLines(redTimingPoints(chart), endTime);
  assert.ok(bars.length > 0, 'a chart with a red line has bar lines');
  assert.equal(bars[0].time, 0);
  assert.equal(bars[0].major, true, 'the first bar line of a 4/4 chart is major');
  assert.equal(bars[1].time, 2000, 'a 500ms beat in 4/4 puts the next bar at 2000ms');
  assert.equal(bars[1].major, false);
  for (let i = 1; i < bars.length; i++) assert.ok(bars[i].time > bars[i - 1].time, 'bar lines ascend');

  // The omit-first-bar-line effect is bit 3 of `effects`.
  const omitting = parseOsu(fixture('basic-4k.osu').replace('0,500,4,2,0,70,1,0', '0,500,4,2,0,70,1,8'));
  const omitBars = barLines(redTimingPoints(omitting), endTime);
  assert.equal(omitBars[0].time, 2000, 'an omitting timing point starts a bar later');
});

test('analysis reports what a chart actually contains', () => {
  const chart = parseOsu(fixture('basic-4k.osu'));
  const notes = toNotes(chart, keyCount(chart));
  const a = analyse(chart, notes);
  assert.equal(a.keys, 4);
  assert.equal(a.objectCount, notes.length);
  assert.equal(a.noteCount + a.lnCount, a.objectCount);
  assert.ok(a.lnCount > 0, 'the fixture has holds');
  assert.ok(a.lnRatio > 0 && a.lnRatio < 1);
  assert.equal(a.firstNote, notes[0].time);
  assert.equal(a.length, Math.max(...notes.map((n) => n.end)));
  // The fixture has a 2000ms break; drain length must exclude it.
  assert.equal(a.breakMs, 2000);
  assert.equal(a.drainLength, a.length - a.firstNote - a.breakMs);
  assert.equal(a.bpm, 120);
  assert.equal(a.stars, null, 'ManiaFlow does not invent a star rating');
  assert.equal(a.perColumn.length, 4);
  assert.equal(a.perColumn.reduce((sum, c) => sum + c.count, 0), a.objectCount);
});

test('chords, intervals and jacks are measured, not guessed', () => {
  const chart = parseOsu(fixture('chords-jacks.osu'));
  const notes = toNotes(chart, keyCount(chart));
  const groups = simultaneousGroups(notes);
  const widest = Math.max(...groups.map((g) => g.length));
  assert.ok(widest >= 3, 'the fixture opens with a four-note chord (minus the dropped duplicate)');
  const intervals = noteIntervals(notes);
  assert.equal(intervals.count, new Set(notes.map((n) => n.time)).size - 1, 'a chord counts as one instant, not several');
  assert.ok(intervals.min > 0);
  assert.ok(intervals.min <= intervals.median && intervals.median <= intervals.max);
  const jacks = countJacks(notes, 220);
  assert.ok(jacks.count > 0, 'the fixture has same-lane repeats inside 220ms');
  assert.ok(jacks.maxStreak >= 2);
  assert.ok(peakNotesPerSecond(notes, 1000) >= notes.length / Math.max(1, (notes[notes.length - 1].time - notes[0].time) / 1000));
});

test('density bins cover the chart and normalise to the busiest bin', () => {
  const chart = parseOsu(fixture('basic-4k.osu'));
  const notes = toNotes(chart, keyCount(chart));
  const end = Math.max(...notes.map((n) => n.end));
  const { bins, max, binMs } = densityBins(notes, end, 64);
  assert.equal(bins.length, 64);
  assert.equal(bins.reduce((a, b) => a + b, 0), notes.length, 'every note falls in exactly one bin');
  assert.equal(Math.max(...bins), max);
  assert.ok(Math.abs(binMs - end / 64) < 1e-9);
  assert.deepEqual(densityBins([], 0, 64).bins, new Array(64).fill(0), 'an empty chart bins to nothing');
});

test('a non-mania mode is refused with a reason a person can act on', () => {
  for (const [name, mode] of [['mode-taiko.osu', 1], ['mode-catch.osu', 2]]) {
    const chart = parseOsu(fixture(name));
    assert.equal(chart.mode, mode);
    const result = validateChart(chart);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => /taiko|catch/i.test(p)), `${name}: the mode is named in the problem`);
    assert.equal(isPreviewable(chart), false);
    assert.throws(() => toNotes(chart), (err) => err instanceof ChartError && err.code === ErrorCode.CHART_UNSUPPORTED);
    assert.equal(primaryIssue(chart), ErrorCode.CHART_UNSUPPORTED);
  }
});

test('osu!standard is reported honestly rather than approximated', () => {
  // The game converts mode 0 with lazer's own generators (EXPECTED has 2 notes here).
  // ManiaFlow deliberately does not reimplement that: an approximate conversion would put
  // notes in lanes the game disagrees with, which is worse than saying it cannot.
  const chart = parseOsu(fixture('mode-standard.osu'));
  assert.equal(chart.mode, 0);
  assert.ok(Array.isArray(EXPECTED['mode-standard.osu'].notes), 'the game does convert it');
  const result = validateChart(chart);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /bridge/i.test(p)), 'the problem tells the user how to get the real notes');
  assert.equal(isPreviewable(chart), false);
  assert.throws(() => keyCount(chart), (err) => err.code === ErrorCode.CHART_UNSUPPORTED);
});

test('a file that is not a beatmap fails loudly', () => {
  assert.throws(() => parseOsu(fixture('not-a-beatmap.osu')), (err) => {
    assert.ok(err instanceof ChartError);
    assert.equal(err.code, ErrorCode.CHART_UNSUPPORTED);
    assert.match(err.message, /osu file format/);
    return true;
  });
  assert.throws(() => parseOsu(''), (err) => err.code === ErrorCode.CHART_EMPTY);
  assert.throws(() => parseOsu(null), (err) => err.code === ErrorCode.CHART_INVALID);
  assert.throws(() => parseOsu('   \n\n  '), (err) => err.code === ErrorCode.CHART_EMPTY);
});

test('a chart with no notes parses but reports the emptiness', () => {
  const chart = parseOsu(fixture('empty-notes.osu'));
  assert.equal(chart.hitObjects.length, 0);
  const result = validateChart(chart);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /no hit objects/i.test(p)));
  assert.equal(isPreviewable(chart), false);
  assert.equal(primaryIssue(chart), ErrorCode.CHART_EMPTY);
  assert.equal(toNotes(chart, 4).length, 0);
});

test('lane count follows CircleSize and is clamped to the game\'s 1..18', () => {
  assert.equal(keyCount(parseOsu(fixture('spinners-8k.osu'))), 8);
  assert.equal(keyCount(parseOsu(fixture('sv-changes.osu'))), 7);
  assert.equal(keyCount(parseOsu(fixture('sliders.osu'))), 5);
  // A fractional CircleSize rounds, and the rounding is surfaced as a warning.
  const fractional = parseOsu(fixture('basic-4k.osu').replace('CircleSize:4', 'CircleSize:4.4'));
  assert.equal(keyCount(fractional), 4);
  assert.ok(validateChart(fractional).warnings.some((w) => /not a whole number/.test(w)));
  // Out of range is a problem, not a silent clamp.
  const tooMany = parseOsu(fixture('basic-4k.osu').replace('CircleSize:4', 'CircleSize:22'));
  assert.ok(validateChart(tooMany).problems.some((p) => /1–18/.test(p)));
});

test('difficulty values are clamped so a broken file cannot yield NaN', () => {
  const broken = parseOsu(fixture('basic-4k.osu')
    .replace('OverallDifficulty:5', 'OverallDifficulty:not-a-number')
    .replace('HPDrainRate:5', 'HPDrainRate:99'));
  assert.equal(broken.od, 5, 'an unreadable OD falls back to 5');
  assert.equal(broken.hp, 10, 'an out-of-range HP is clamped');
  const analysis = analyse(broken, toNotes(broken, keyCount(broken)));
  assert.ok(Number.isFinite(analysis.metadata.od));
  assert.ok(Number.isFinite(analysis.metadata.hp));
});

test('a missing audio file is a problem; a missing background is only a warning', () => {
  const chart = parseOsu(fixture('basic-4k.osu'));
  const withFiles = new Set(['bg.jpg']);
  const result = validateChart(chart, { availableFiles: withFiles });
  assert.ok(result.problems.some((p) => /Missing audio/.test(p)));
  assert.ok(!result.warnings.some((w) => /Missing background/.test(w)), 'the background is present');
  assert.equal(result.ok, false);

  const complete = validateChart(chart, { availableFiles: new Set(['audio.mp3', 'bg.jpg']) });
  assert.equal(complete.ok, true);
  assert.equal(complete.severity, null);
});

test('a chart with no timing point at all still has a usable reference', () => {
  const text = fixture('basic-4k.osu').replace(/\[TimingPoints\][\s\S]*?\n\n/, '[TimingPoints]\n\n');
  const chart = parseOsu(text);
  assert.equal(chart.timingPoints.length, 0);
  const red = redTimingPoints(chart);
  assert.equal(red.length, 1, 'a 500ms fallback is supplied');
  assert.equal(red[0].beatLength, 500);
  assert.ok(validateChart(chart).problems.some((p) => /timing point/i.test(p)), 'the missing timing is reported as a problem');
});
