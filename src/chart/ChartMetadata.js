/**
 * ChartMetadata — everything ManiaFlow can honestly derive from a chart on its own.
 *
 * What is *not* here: a star rating. Ashtonk!mania computes its stars with lazer's mania
 * strain model over its own normalised notes; reimplementing that would produce a number
 * that looks like the game's but is not. When a chart arrives from the bridge or from the
 * game's library, its `stars` field is carried through untouched. For a locally imported
 * file `stars` stays `null` and the UI says where the number would come from.
 *
 * The density, interval and chord figures below are ManiaFlow's own, are labelled as such
 * wherever they appear, and are the inputs the Timing Lab works on.
 */

import { num } from '../utils/validation.js';
import { dominantBeatLength, redTimingPoints } from './ChartParser.js';

/**
 * Analyse a parsed chart and its normalised notes.
 *
 * @param {import('./ChartParser.js').ParsedChart} chart
 * @param {import('./ChartParser.js').Note[] & {byColumn?: Array<Array>, keys?: number}} notes
 * @returns {ChartAnalysis}
 */
export function analyse(chart, notes) {
  const list = Array.isArray(notes) ? notes : [];
  const keys = notes?.keys ?? 0;
  const byColumn = notes?.byColumn ?? [];

  const lnCount = list.filter((n) => n.isLN).length;
  const tapCount = list.length - lnCount;
  const firstNote = list.length ? list[0].time : 0;
  const lastNote = list.length ? list.slice(-Math.max(1, keys * 4)).reduce((max, n) => Math.max(max, n.end), 0) : 0;

  const breaks = Array.isArray(chart?.events?.breaks) ? chart.events.breaks : [];
  const breakMs = breaks.reduce((total, b) => total + Math.max(0, b.end - b.start), 0);

  const red = redTimingPoints(chart ?? { timingPoints: [], hitObjects: [] });
  const dominant = dominantBeatLength(chart ?? { timingPoints: [], hitObjects: [] }, red);
  const bpms = red.map((tp) => 60000 / tp.beatLength).filter(Number.isFinite);

  const span = Math.max(0, lastNote - firstNote);
  const drainLength = Math.max(0, lastNote - firstNote - breakMs);

  const intervals = noteIntervals(list);
  const chords = simultaneousGroups(list);
  const lns = list.filter((n) => n.isLN);
  const lnTotalMs = lns.reduce((total, n) => total + Math.max(0, n.end - n.time), 0);

  const greenCount = (chart?.timingPoints ?? []).filter((tp) => !tp.uninherited && tp.beatLength < 0).length;

  return {
    keys,
    objectCount: list.length,
    noteCount: tapCount,
    lnCount,
    lnRatio: list.length ? lnCount / list.length : 0,
    lnTotalMs,
    longestLnMs: lns.length ? Math.max(...lns.map((n) => Math.max(0, n.end - n.time))) : 0,

    firstNote,
    lastNote,
    length: lastNote,
    drainLength,
    breakMs,
    breaks,

    bpm: dominant > 0 ? 60000 / dominant : 0,
    bpmMin: bpms.length ? Math.min(...bpms) : 0,
    bpmMax: bpms.length ? Math.max(...bpms) : 0,
    dominantBeatLength: dominant,
    timingChangeCount: Math.max(0, red.length - 1),
    svChangeCount: greenCount,

    nps: span > 0 ? (list.length / span) * 1000 : 0,
    peakNps: peakNotesPerSecond(list, 1000),

    intervals,
    chords: {
      groups: chords.length,
      maxChord: chords.length ? Math.max(...chords.map((g) => g.length)) : 0,
      ratio: list.length ? chords.filter((g) => g.length > 1).length / Math.max(1, chords.length) : 0,
    },

    jacks: countJacks(list, 220),
    minIntervalMs: intervals.min,
    medianIntervalMs: intervals.median,
    meanIntervalMs: intervals.mean,

    perColumn: byColumn.map((column, index) => ({
      col: index,
      count: column.length,
      lnCount: column.filter((n) => n.isLN).length,
      load: list.length ? column.length / list.length : 0,
    })),

    // Carried through untouched when the chart came from the game; null otherwise.
    stars: Number.isFinite(num(chart?.stars, Number.NaN)) ? num(chart.stars) : null,

    metadata: {
      title: chart?.title ?? '',
      titleUnicode: chart?.titleUnicode ?? chart?.title ?? '',
      artist: chart?.artist ?? '',
      artistUnicode: chart?.artistUnicode ?? chart?.artist ?? '',
      creator: chart?.creator ?? '',
      version: chart?.version ?? '',
      source: chart?.source ?? '',
      tags: chart?.tags ?? [],
      beatmapId: chart?.beatmapId ?? -1,
      beatmapSetId: chart?.beatmapSetId ?? -1,
      audioFilename: chart?.audioFilename ?? '',
      previewTime: chart?.previewTime ?? -1,
      od: chart?.od ?? 5,
      hp: chart?.hp ?? 5,
      cs: chart?.cs ?? 4,
      formatVersion: chart?.formatVersion ?? 14,
      mode: chart?.mode ?? 3,
    },
  };
}

/**
 * Gaps between consecutive note heads, ignoring notes that start at the same instant
 * (those are a chord, not an interval).
 */
export function noteIntervals(notes) {
  if (!Array.isArray(notes) || notes.length < 2) {
    return { min: null, max: null, mean: null, median: null, count: 0, values: [] };
  }
  const times = [...new Set(notes.map((n) => n.time))].sort((a, b) => a - b);
  if (times.length < 2) return { min: null, max: null, mean: null, median: null, count: 0, values: [] };
  const values = [];
  for (let i = 1; i < times.length; i++) values.push(times[i] - times[i - 1]);
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / values.length,
    median: sorted[sorted.length >> 1],
    count: values.length,
    values,
  };
}

/** Group notes that share an instant — a chord. One group per distinct start time. */
export function simultaneousGroups(notes, toleranceMs = 0) {
  if (!Array.isArray(notes) || !notes.length) return [];
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.col - b.col);
  const groups = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time - current[0].time <= toleranceMs) current.push(sorted[i]);
    else { groups.push(current); current = [sorted[i]]; }
  }
  groups.push(current);
  return groups;
}

/**
 * Notes that repeat in the same column with a short gap — the pattern that makes a stream
 * hard. `windowMs` is the largest gap that still counts as a jack.
 */
export function countJacks(notes, windowMs = 220) {
  if (!Array.isArray(notes) || notes.length < 2) return { count: 0, maxStreak: 0 };
  const byColumn = new Map();
  for (const note of notes) {
    if (!byColumn.has(note.col)) byColumn.set(note.col, []);
    byColumn.get(note.col).push(note.time);
  }
  let count = 0;
  let maxStreak = 0;
  for (const times of byColumn.values()) {
    const sorted = [...times].sort((a, b) => a - b);
    let streak = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > 0 && gap <= windowMs) { count++; streak++; maxStreak = Math.max(maxStreak, streak); }
      else streak = 0;
    }
  }
  return { count, maxStreak };
}

/**
 * The busiest `windowMs` of the chart, in notes per second. A rolling count over sorted
 * note times — O(n), not O(n²).
 */
export function peakNotesPerSecond(notes, windowMs = 1000) {
  if (!Array.isArray(notes) || !notes.length) return 0;
  const times = notes.map((n) => n.time).sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return (best / windowMs) * 1000;
}

/**
 * Note density bucketed into `bins` columns — what the timeline strip draws.
 * Returns counts and, separately, the busiest bin so a caller can normalise.
 */
export function densityBins(notes, endTime, bins = 240) {
  const count = Math.max(8, Math.floor(bins));
  const out = new Array(count).fill(0);
  if (!Array.isArray(notes) || !notes.length || !(endTime > 0)) return { bins: out, max: 0, binMs: endTime / count };
  const binMs = endTime / count;
  for (const note of notes) {
    const index = Math.min(count - 1, Math.max(0, Math.floor(note.time / binMs)));
    out[index]++;
  }
  let max = 0;
  for (const value of out) if (value > max) max = value;
  return { bins: out, max, binMs };
}

/** A human summary line, used by the library and the dashboard. */
export function describe(analysis) {
  if (!analysis) return '';
  const parts = [];
  if (analysis.keys) parts.push(`${analysis.keys}K`);
  if (analysis.objectCount) parts.push(`${analysis.objectCount.toLocaleString('en-US')} notes`);
  if (analysis.lnCount) parts.push(`${analysis.lnCount} LN`);
  if (analysis.bpm) parts.push(`${Math.round(analysis.bpm * 100) / 100} BPM`);
  return parts.join(' · ');
}

/**
 * @typedef {object} ChartAnalysis
 * @property {number} keys
 * @property {number} objectCount
 * @property {number} noteCount
 * @property {number} lnCount
 * @property {number} lnRatio
 * @property {number} bpm
 * @property {number} bpmMin
 * @property {number} bpmMax
 * @property {number} nps
 * @property {number} peakNps
 * @property {number} length
 * @property {number} drainLength
 * @property {number|null} stars
 */

export const ChartMetadata = { analyse, noteIntervals, simultaneousGroups, countJacks, peakNotesPerSecond, densityBins, describe };
