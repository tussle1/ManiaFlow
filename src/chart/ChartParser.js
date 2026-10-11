/**
 * ChartParser — reads the osu! beatmap text format that Ashtonk!mania imports.
 *
 * The semantics here are not guessed. They are the semantics of the game's own
 * `BeatmapParser` (verified against its source, see docs/INTEGRATION-RESEARCH.md §3), so a
 * chart parsed by ManiaFlow has the same notes at the same times as the chart the game
 * plays:
 *
 *   • files older than format v5 have every time shifted +24 ms
 *   • a negative beat length is always an inherited (SV) line, whatever the flag says
 *   • column = clamp(floor(x * keys / 512), 0, keys - 1), keys = clamp(round(CircleSize), 1, 18)
 *   • times beyond six hours are corrupt data and the line is skipped
 *   • per-column duplicates and LN overlaps are dropped
 *   • BPM is the beat length covering the longest span *between the first and last note*
 *
 * One deliberate omission: osu!standard (mode 0) difficulties are converted to mania by
 * lazer-specific logic inside the game. ManiaFlow parses their metadata but does not
 * reimplement that conversion — pretending to would mean inventing notes. When a bridge is
 * connected, the converted notes are read from the game itself instead.
 */

import { ChartError, ErrorCode } from '../utils/errors.js';
import { clampNumber, num, LIMITS } from '../utils/validation.js';
import { sliderDuration, spinnerPlacer } from './ConvertMath.js';

/** The game's own guard: a time further out than six hours is corrupt data. */
const MAX_MAP_TIME = LIMITS.NOTE_TIME_MAX;

/** Hit-object type bits, as osu! defines them. */
export const HitType = Object.freeze({
  CIRCLE: 1,
  SLIDER: 2,
  NEW_COMBO: 4,
  SPINNER: 8,
  COLOUR_HOLDER: 16,
  MANIA_HOLD: 128,
});

const SECTIONS = new Set(['general', 'editor', 'metadata', 'difficulty', 'colours', 'events', 'timingpoints', 'hitobjects']);

/**
 * Parse `.osu` text.
 * @param {string} text
 * @returns {ParsedChart}
 * @throws {ChartError} when the file is not a beatmap at all
 */
export function parseOsu(text) {
  if (typeof text !== 'string') {
    throw new ChartError('A chart must be provided as text', { code: ErrorCode.CHART_INVALID });
  }
  const source = text.replace(/^\uFEFF/, '');
  if (!source.trim()) {
    throw new ChartError('The file is empty', { code: ErrorCode.CHART_EMPTY });
  }

  const lines = source.split(/\r?\n/);
  const firstMeaningful = lines.find((line) => line.trim());
  const versionMatch = firstMeaningful ? /osu file format v(\d+)/i.exec(firstMeaningful) : null;

  if (!versionMatch && !/\[HitObjects\]/i.test(source)) {
    throw new ChartError(
      'Not an osu! beatmap: no "osu file format" header and no [HitObjects] section',
      { code: ErrorCode.CHART_UNSUPPORTED },
    );
  }

  const formatVersion = versionMatch ? Number.parseInt(versionMatch[1], 10) : 14;
  // osu! moves everything in a pre-v5 file 24 ms later; the game does the same.
  const legacyShift = Number.isFinite(formatVersion) && formatVersion < 5 ? 24 : 0;

  /** @type {ParsedChart} */
  const chart = {
    formatVersion: Number.isFinite(formatVersion) ? formatVersion : 14,
    general: {}, editor: {}, metadata: {}, difficulty: {}, colours: {},
    events: { background: null, video: null, breaks: [], storyboard: false },
    timingPoints: [],
    hitObjects: [],
    skipped: { timingPoints: 0, hitObjects: 0 },
    mode: 0,
    audioFilename: '',
    audioLeadIn: 0,
    previewTime: -1,
    od: 5, hp: 5, cs: 4, ar: 5, sliderMultiplier: 1.4, sliderTickRate: 1,
    epilepsyWarning: false,
    letterboxInBreaks: false,
    specialStyle: false,
    tags: [],
  };

  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line[0] === '[' && line.endsWith(']')) {
      const name = line.slice(1, -1).toLowerCase();
      section = SECTIONS.has(name) ? name : '';
      continue;
    }

    switch (section) {
      case 'general': case 'editor': case 'metadata': case 'difficulty': case 'colours': {
        const colon = line.indexOf(':');
        if (colon < 0) break;
        chart[section][line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        break;
      }
      case 'events':
        parseEvent(chart, raw);
        break;
      case 'timingpoints': {
        const point = parseTimingPoint(line, legacyShift);
        if (point) chart.timingPoints.push(point);
        else chart.skipped.timingPoints++;
        break;
      }
      case 'hitobjects': {
        const object = parseHitObject(line, legacyShift);
        if (object) chart.hitObjects.push(object);
        else chart.skipped.hitObjects++;
        break;
      }
      default:
        break;
    }
  }

  finishChart(chart, legacyShift);
  return chart;
}

function parseTimingPoint(line, shift) {
  const parts = line.split(',');
  if (parts.length < 2) return null;
  const time = num(parts[0], Number.NaN) + shift;
  const beatLength = num(parts[1], Number.NaN);
  if (!Number.isFinite(time) || !Number.isFinite(beatLength)) return null;
  if (Math.abs(time) > MAX_MAP_TIME) return null;
  // A zero beat length is nonsense data, but the game keeps the line rather than dropping
  // it — it is simply inert downstream (redTimingPoints filters on beatLength > 0, and a
  // scroll velocity of dominant/0 is not finite so scrollSegments skips it). Keeping it
  // here too is what makes the parsed line count agree with the game's.
  const uninheritedFlag = parts[6] === undefined || parts[6].trim() !== '0';
  return {
    time,
    beatLength,
    meter: parts[2] ? Number.parseInt(parts[2], 10) || 4 : 4,
    sampleSet: parts[3] ? Number.parseInt(parts[3], 10) || 0 : 0,
    sampleIndex: parts[4] ? Number.parseInt(parts[4], 10) || 0 : 0,
    volume: parts[5] ? Number.parseInt(parts[5], 10) : 100,
    // As in the game: a negative beat length is a green line whatever the flag claims.
    uninherited: beatLength > 0 && uninheritedFlag,
    effects: parts[7] ? Number.parseInt(parts[7], 10) || 0 : 0,
  };
}

function parseHitObject(line, shift) {
  const parts = line.split(',');
  if (parts.length < 4) return null;
  const x = num(parts[0], Number.NaN);
  const y = num(parts[1], 0);
  const time = num(parts[2], Number.NaN) + shift;
  const type = num(parts[3], Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(time) || !Number.isFinite(type)) return null;
  if (Math.abs(time) > MAX_MAP_TIME) return null;

  const object = {
    x, y, time, type,
    hitsound: num(parts[4], 0),
    endTime: time,
    isHold: false,
    isSlider: false,
    isSpinner: false,
    slider: null,
    extras: null,
  };

  if (type & HitType.MANIA_HOLD) {
    // mania hold: `endTime:sampleSet:sampleIndex:volume:filename`
    const extra = String(parts[5] ?? '').split(':');
    const end = num(extra[0], Number.NaN) + shift;
    object.endTime = Number.isFinite(end) ? end : time;
    object.isHold = true;
    object.extras = extra.slice(1);
  } else if (type & HitType.SPINNER) {
    object.endTime = num(parts[5], time) + shift;
    object.isSpinner = true;
    object.extras = String(parts[6] ?? '').split(':');
  } else if (type & HitType.SLIDER) {
    object.isSlider = true;
    object.slider = {
      curveType: String(parts[5] ?? 'L').charAt(0),
      points: String(parts[5] ?? '').split('|').slice(1),
      slides: Math.max(1, num(parts[6], 1)),
      length: Math.max(0, num(parts[7], 0)),
    };
    object.extras = String(parts[10] ?? '').split(':');
  } else {
    object.extras = String(parts[5] ?? '').split(':');
  }

  if (!Number.isFinite(object.endTime) || Math.abs(object.endTime) > MAX_MAP_TIME) {
    object.endTime = time;
  }
  return object;
}

function parseEvent(chart, raw) {
  const line = raw.trim();
  // An indented line or one starting with `_` belongs to a storyboard object.
  if (/^[ _]/.test(raw) || /^\s/.test(raw)) { chart.events.storyboard = true; return; }
  const parts = line.split(',');
  const kind = parts[0].trim();
  const file = (value) => {
    const name = String(value ?? '').trim().replace(/^"|"$/g, '');
    return name || null;
  };
  if (kind === '0' && parts.length >= 3) {
    chart.events.background = { file: file(parts[2]), xOffset: num(parts[3], 0), yOffset: num(parts[4], 0) };
  } else if ((kind === '1' || kind.toLowerCase() === 'video') && parts.length >= 3) {
    chart.events.video = { file: file(parts[2]), offset: num(parts[1], 0) };
  } else if ((kind === '2' || kind.toLowerCase() === 'break') && parts.length >= 3) {
    const start = num(parts[1], Number.NaN);
    const end = num(parts[2], Number.NaN);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) chart.events.breaks.push({ start, end });
  } else if (/^(Sprite|Animation|Sample|3|4|5|6)$/i.test(kind)) {
    chart.events.storyboard = true;
  }
}

/** Derive the numeric conveniences and put everything in the order the game expects. */
function finishChart(chart, shift) {
  const g = chart.general;
  const d = chart.difficulty;
  const m = chart.metadata;

  chart.mode = clampNumber(g.Mode, { min: 0, max: 3, fallback: 0, integer: true }).value;
  chart.audioFilename = normalisePath(g.AudioFilename || '');
  chart.audioLeadIn = num(g.AudioLeadIn, 0);
  chart.previewTime = num(g.PreviewTime, -1);
  chart.epilepsyWarning = g.EpilepsyWarning === '1';
  chart.letterboxInBreaks = g.LetterboxInBreaks === '1';
  chart.specialStyle = g.SpecialStyle === '1';
  chart.sampleSet = (g.SampleSet || 'Normal').toLowerCase();
  chart.countdown = num(g.Countdown, 0);

  // osu!'s editor keeps difficulty values in 0..10; a broken file must not produce NaN windows.
  const difficultyValue = (value, fallback) => clampNumber(value, { min: 0, max: 10, fallback }).value;
  chart.od = difficultyValue(d.OverallDifficulty, 5);
  chart.hp = difficultyValue(d.HPDrainRate, 5);
  chart.cs = num(d.CircleSize, 4);
  chart.ar = difficultyValue(d.ApproachRate, 5);
  chart.sliderMultiplier = num(d.SliderMultiplier, 1.4);
  chart.sliderTickRate = num(d.SliderTickRate, 1);

  chart.title = m.Title || '';
  chart.titleUnicode = m.TitleUnicode || m.Title || '';
  chart.artist = m.Artist || '';
  chart.artistUnicode = m.ArtistUnicode || m.Artist || '';
  chart.creator = m.Creator || '';
  chart.version = m.Version || '';
  chart.source = m.Source || '';
  chart.tags = String(m.Tags || '').split(/\s+/).filter(Boolean);
  chart.beatmapId = num(m.BeatmapID, -1);
  chart.beatmapSetId = num(m.BeatmapSetID, -1);

  if (shift && chart.previewTime > 0) chart.previewTime += shift;
  if (shift) for (const b of chart.events.breaks) { b.start += shift; b.end += shift; }

  chart.events.breaks.sort((a, b) => a.start - b.start);
  // The game sorts red lines before green ones at the same instant.
  chart.timingPoints.sort((a, b) => a.time - b.time || Number(b.uninherited) - Number(a.uninherited));
  chart.hitObjects.sort((a, b) => a.time - b.time);
}

function normalisePath(value) {
  return String(value || '').trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
}

/* ── key count and notes ─────────────────────────────────────────────── */

/**
 * Lane count for a native mania chart: `clamp(round(CircleSize), 1, 18)`.
 * @throws {ChartError} for a mode ManiaFlow cannot lay out.
 */
export function keyCount(chart) {
  if (!chart || typeof chart !== 'object') throw new ChartError('No chart was provided');
  if (chart.mode === 3) {
    const keys = clampNumber(chart.cs, { min: LIMITS.KEYS_MIN, max: LIMITS.KEYS_MAX, fallback: 4, integer: true }).value;
    if (!Number.isFinite(keys)) throw new ChartError("The key count (CircleSize) isn't a number");
    return keys;
  }
  if (chart.mode === 0) {
    // Reported, never invented: the real conversion belongs to the game.
    throw new ChartError(
      'This is an osu!standard difficulty. Ashtonk!mania converts it to mania itself; connect the bridge to read the converted notes.',
      { code: ErrorCode.CHART_UNSUPPORTED },
    );
  }
  throw new ChartError(
    `Mode ${chart.mode} is not playable — Ashtonk!mania plays osu!mania (mode 3) and converted osu!standard (mode 0) only`,
    { code: ErrorCode.CHART_UNSUPPORTED },
  );
}

/**
 * Convert a mania chart to normalised notes: `{ col, time, end, isLN }`, sorted by time
 * then column, with per-column duplicates and LN overlaps dropped exactly as the game does.
 *
 * @param {ParsedChart} chart
 * @param {number} [keys] override the lane count
 * @returns {Note[]}
 */
export function toNotes(chart, keys = keyCount(chart)) {
  const laneCount = clampNumber(keys, { min: LIMITS.KEYS_MIN, max: LIMITS.KEYS_MAX, fallback: 4, integer: true }).value;
  const raw = [];

  // Created once and reused, because lazer's spinner generator advances its random state
  // from one spinner to the next — a fresh generator per spinner would pick different lanes.
  let placeSpinner = null;

  for (const object of chart.hitObjects) {
    let col = Math.min(laneCount - 1, Math.max(0, Math.floor((object.x * laneCount) / 512)));
    let end = object.time;
    let isLN = false;

    if (object.isSpinner) {
      // A spinner in a mania map is a hold in a column lazer's seeded random picks.
      placeSpinner = placeSpinner || spinnerPlacer(chart, laneCount);
      const placed = placeSpinner(object);
      col = placed.col;
      end = placed.end;
      isLN = placed.isLN;
    } else if (object.isHold) {
      end = object.endTime;
      isLN = end > object.time;
    } else if (object.isSlider) {
      // A slider in a mania map (old maps have them) plays as a hold of the slider's length.
      end = object.time + sliderDurationMs(chart, object);
      isLN = end > object.time;
    }

    raw.push({ col, time: object.time, end: isLN ? end : object.time, isLN });
  }

  raw.sort((a, b) => a.time - b.time || a.col - b.col);

  const lastEnd = new Array(laneCount).fill(-Infinity);
  const notes = [];
  let droppedOverlaps = 0;
  for (const note of raw) {
    if (note.time <= lastEnd[note.col]) { droppedOverlaps++; continue; }
    lastEnd[note.col] = note.isLN ? note.end : note.time;
    notes.push(note);
  }

  // Index by column once: rendering and scheduling both walk columns, not the flat list.
  const byColumn = Array.from({ length: laneCount }, () => []);
  for (const note of notes) byColumn[note.col].push(note);

  return Object.assign(notes, { byColumn, keys: laneCount, droppedOverlaps });
}

/**
 * A mania slider's length in milliseconds, using lazer's control-point stack:
 * `spans * length / (100 * sliderMultiplier * sv / beatLength)`, with SV clamped to
 * 0.1–10, beat length to 6 ms–60 s and slider multiplier to 0.4–3.6.
 */
export function sliderDurationMs(chart, object) {
  return sliderDuration(chart, object);
}

/** Uninherited timing points with a usable beat length, in time order. */
export function redTimingPoints(chart) {
  const red = chart.timingPoints.filter((tp) => tp.uninherited && tp.beatLength > 0);
  // A chart with no red line at all still needs a reference; the game assumes 500 ms (120 BPM).
  return red.length ? red : [{ time: 0, beatLength: 500, meter: 4, uninherited: true, effects: 0, volume: 100 }];
}

/**
 * The beat length covering the longest span between the first and last note —
 * the value both osu! and Ashtonk!mania report as the map's BPM.
 */
export function dominantBeatLength(chart, red = redTimingPoints(chart)) {
  const objects = chart.hitObjects;
  if (!objects.length) return red[0].beatLength;
  const sample = objects.slice(0, 50);
  const tail = objects.slice(-50);
  const startTime = Math.min(...sample.map((o) => o.time));
  const endTime = Math.max(...tail.map((o) => Math.max(o.time, o.endTime || 0)));

  const durations = new Map();
  for (let i = 0; i < red.length; i++) {
    const current = red[i];
    const next = red[i + 1];
    if (current.time > endTime) break;
    const from = Math.max(current.time, startTime);
    const to = next ? Math.min(next.time, endTime) : endTime;
    durations.set(current.beatLength, (durations.get(current.beatLength) || 0) + Math.max(0, to - from));
  }
  let best = 0;
  let longest = 0;
  for (const [beatLength, duration] of durations) {
    if (duration > longest) { best = beatLength; longest = duration; }
  }
  return best > 0 ? best : red[0].beatLength;
}

/**
 * Scroll segments `[{ time, pos, vel }]`, where `pos` is integrated scroll distance in
 * ms-at-1×. Red lines scroll at `dominant / beatLength`; green lines multiply the current
 * red speed by `100 / -beatLength`.
 */
export function scrollSegments(chart, { useSV = true, useBPM = true } = {}) {
  const red = redTimingPoints(chart);
  const dominant = dominantBeatLength(chart, red);
  const changes = [];
  let redSpeed = 1;

  for (const point of chart.timingPoints) {
    let velocity;
    if (point.uninherited) {
      redSpeed = useBPM ? dominant / point.beatLength : 1;
      velocity = redSpeed;
    } else {
      velocity = redSpeed * (useSV && point.beatLength < 0 ? 100 / -point.beatLength : 1);
    }
    if (!Number.isFinite(velocity) || velocity < 0) continue;
    const last = changes[changes.length - 1];
    if (last && last.time === point.time) last.vel = velocity;
    else changes.push({ time: point.time, vel: velocity });
  }

  // Before the first timing point, the first speed already applies.
  changes.unshift({ time: -1e7, vel: changes.length ? changes[0].vel : 1 });

  const segments = [];
  let position = 0;
  for (let i = 0; i < changes.length; i++) {
    if (i > 0) position += (changes[i].time - changes[i - 1].time) * changes[i - 1].vel;
    segments.push({ time: changes[i].time, pos: position, vel: changes[i].vel });
  }
  return segments;
}

/**
 * Bar lines from each red timing point to the next (or to the last note), one per bar,
 * every `meter`-th one major. A timing point with the "omit first bar line" effect (bit 3
 * of `effects`) starts a bar later.
 */
export function barLines(red, endTime) {
  const out = [];
  let beat = 0;
  for (let i = 0; i < red.length; i++) {
    const point = red[i];
    const meter = point.meter > 0 ? point.meter : 4;
    const bar = point.beatLength * meter;
    if (!(bar > 1)) continue;
    const until = i + 1 < red.length ? red[i + 1].time : endTime;
    let time = point.time + ((point.effects || 0) & 8 ? bar : 0);
    for (; until - time > 1 && out.length < 20000; time += bar, beat++) {
      out.push({ time, major: beat % meter === 0 });
    }
  }
  return out;
}

/**
 * @typedef {object} TimingPoint
 * @property {number} time
 * @property {number} beatLength
 * @property {number} meter
 * @property {boolean} uninherited
 * @property {number} effects
 *
 * @typedef {object} Note
 * @property {number} col   zero-based lane index
 * @property {number} time  head, in chart milliseconds
 * @property {number} end   tail, equal to `time` for a tap
 * @property {boolean} isLN
 *
 * @typedef {object} ParsedChart
 * @property {number} formatVersion
 * @property {number} mode
 * @property {object} metadata
 * @property {TimingPoint[]} timingPoints
 * @property {object[]} hitObjects
 * @property {{ background: object|null, video: object|null, breaks: Array<{start:number,end:number}>, storyboard: boolean }} events
 */

export const ChartParser = { parseOsu, toNotes, keyCount, scrollSegments, barLines, redTimingPoints, dominantBeatLength, sliderDurationMs };
