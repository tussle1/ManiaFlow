/**
 * TimingEngine — the arithmetic of *when* and *where*.
 *
 * This module owns every conversion between chart time, scroll position and screen
 * distance. It never touches the DOM, never owns a clock and never schedules input, so it
 * can be driven by ManiaFlow's own playback, by the game's audio clock through a bridge,
 * or by a test.
 *
 * The scroll model is Ashtonk!mania's own, taken from its renderer:
 *
 *   timeRange = 11485 / scrollSpeed                       (ms of chart on screen)
 *   pxPerUnit = travelPx / (timeRange * rate)
 *   y         = receptorY − (posAt(noteTime) − posAt(now)) * pxPerUnit     (downscroll)
 *
 * `posAt` is the integral of the chart's scroll velocity, so a green SV line makes notes
 * travel faster or slower without moving when they are judged. Rate divides the pixel
 * scale rather than the position, which is why a slower rate shows more of the chart
 * without changing any note's time.
 *
 * Offsets follow the game too: `chartTime = clockTime − offset * rate`. Setting the same
 * offset in ManiaFlow and in Ashtonk!mania therefore shifts a note by the same amount.
 */

import { num, oneOf, clampNumber, validateOffset, validateRate, LIMITS } from '../utils/validation.js';
import { ValidationError } from '../utils/errors.js';

/** The constant in the game's `timeRange = 11485 / scrollSpeed`. */
export const SCROLL_CONSTANT = 11485;

export const Direction = Object.freeze({ DOWN: 'down', UP: 'up' });

/** Scroll speed (1–40, the game's slider) → milliseconds of chart visible. */
export function scrollSpeedToTimeRange(speed) {
  const v = clampNumber(speed, { min: 1, max: 40, fallback: 22 }).value;
  return SCROLL_CONSTANT / v;
}

/** The inverse: how fast must the scroll be to show `ms` of chart? */
export function timeRangeToScrollSpeed(ms) {
  const range = clampNumber(ms, { min: SCROLL_CONSTANT / 40, max: SCROLL_CONSTANT, fallback: 522 }).value;
  return SCROLL_CONSTANT / range;
}

/** Last index whose `time <= t`, or -1. Binary search; the list must be time-ordered. */
function searchLastAtOrBefore(list, time) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * Integrated scroll position over a chart's scroll segments.
 * Position is in milliseconds-at-1×: at SV 1.0 one unit is one millisecond, so the value
 * is comparable across charts with different velocities.
 */
export class ScrollMap {
  /** @param {Array<{time:number,pos:number,vel:number}>} segments */
  constructor(segments) {
    if (!Array.isArray(segments) || !segments.length) {
      throw new ValidationError('A scroll map needs at least one segment', { field: 'segments' });
    }
    this.segments = segments.map((s) => ({ time: num(s.time, 0), pos: num(s.pos, 0), vel: num(s.vel, 1) }));
    for (let i = 1; i < this.segments.length; i++) {
      if (this.segments[i].time < this.segments[i - 1].time) {
        throw new ValidationError('Scroll segments must be in time order', { field: 'segments' });
      }
    }
  }

  /** Scroll position at a chart time. */
  posAt(time) {
    const t = num(time, 0);
    const i = searchLastAtOrBefore(this.segments, t);
    if (i < 0) {
      // Before the first segment the first velocity already applies, as in the game.
      const first = this.segments[0];
      return first.pos + (t - first.time) * first.vel;
    }
    const segment = this.segments[i];
    return segment.pos + (t - segment.time) * segment.vel;
  }

  /** The chart time at a scroll position — the inverse of `posAt`. */
  timeAtPos(position) {
    const target = num(position, 0);
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].pos <= target) lo = mid; else hi = mid - 1;
    }
    const segment = this.segments[lo];
    if (!(segment.vel > 0)) return segment.time;
    return segment.time + (target - segment.pos) / segment.vel;
  }

  /** The velocity in force at a chart time. */
  velocityAt(time) {
    const i = searchLastAtOrBefore(this.segments, num(time, 0));
    return i < 0 ? this.segments[0].vel : this.segments[i].vel;
  }

  /** Positions of every segment change, for drawing an SV strip. */
  changes() {
    return this.segments.map((s) => ({ time: s.time, pos: s.pos, vel: s.vel }));
  }
}

/** osu!'s beat-snap colours, in the order the game tests them. */
const SNAP_DIVISORS = [
  [1, '#ffffff'], [2, '#ed1121'], [4, '#66ccff'], [3, '#aa88ff'],
  [8, '#ffcc22'], [6, '#ff9a3c'], [12, '#cc6600'], [16, '#6644cc'],
];
const SNAP_UNSNAPPED = '#a0a0a0';

export class TimingEngine {
  /**
   * @param {object} config
   * @param {Array<{time:number,pos:number,vel:number}>} config.segments scroll segments
   * @param {Array<{time:number,beatLength:number,meter:number,effects?:number}>} [config.red] uninherited timing points
   * @param {number} [config.rate] playback rate, 0.25–2
   * @param {number} [config.offsetMs] timing offset, −500…500
   * @param {number} [config.scrollSpeed] 1–40, the game's slider value
   * @param {'down'|'up'} [config.direction]
   */
  constructor(config = {}) {
    if (!config.segments) throw new ValidationError('TimingEngine needs scroll segments', { field: 'segments' });
    this.scroll = new ScrollMap(config.segments);
    this.red = Array.isArray(config.red) && config.red.length
      ? config.red.map((tp) => ({ time: num(tp.time, 0), beatLength: num(tp.beatLength, 500), meter: num(tp.meter, 4), effects: num(tp.effects, 0) }))
      : [{ time: 0, beatLength: 500, meter: 4, effects: 0 }];

    this._rate = validateRate(config.rate ?? 1).value;
    this._offset = validateOffset(config.offsetMs ?? 0).value;
    this._scrollSpeed = clampNumber(config.scrollSpeed ?? 22, { min: 1, max: 40, fallback: 22 }).value;
    this._direction = oneOf(config.direction, [Direction.DOWN, Direction.UP], Direction.DOWN);
  }

  get rate() { return this._rate; }
  get offsetMs() { return this._offset; }
  get scrollSpeed() { return this._scrollSpeed; }
  get direction() { return this._direction; }

  /** Milliseconds of chart that fit between the receptor and the top of the stage. */
  get timeRange() { return SCROLL_CONSTANT / this._scrollSpeed; }

  setRate(rate) {
    const result = validateRate(rate);
    if (result.reason && !Number.isFinite(num(rate, Number.NaN))) {
      throw new ValidationError(`Playback rate "${rate}" is not a number`, { field: 'rate', value: rate });
    }
    this._rate = result.value;
    return this._rate;
  }

  setOffset(offsetMs) {
    this._offset = validateOffset(offsetMs).value;
    return this._offset;
  }

  setScrollSpeed(speed) {
    this._scrollSpeed = clampNumber(speed, { min: 1, max: 40, fallback: 22 }).value;
    return this._scrollSpeed;
  }

  /**
   * An unrecognised direction keeps the current one rather than flipping the whole
   * preview: a bad value from storage or a bridge should not turn the stage upside down.
   */
  setDirection(direction) {
    this._direction = oneOf(direction, [Direction.DOWN, Direction.UP], this._direction);
    return this._direction;
  }

  /* ── time ↔ clock ─────────────────────────────────────────────────── */

  /** The chart time judged at a clock time, exactly as the game does it. */
  chartTimeAt(clockMs) { return num(clockMs, 0) - this._offset * this._rate; }

  /** The clock time at which a chart time is judged. Inverse of `chartTimeAt`. */
  clockTimeFor(chartMs) { return num(chartMs, 0) + this._offset * this._rate; }

  /* ── scrolling ────────────────────────────────────────────────────── */

  posAt(chartMs) { return this.scroll.posAt(chartMs); }
  timeAtPos(position) { return this.scroll.timeAtPos(position); }
  velocityAt(chartMs) { return this.scroll.velocityAt(chartMs); }

  /**
   * How far a note at `noteTime` sits from the receptor, in scroll units, when the chart
   * is at `nowTime`. Positive means the note has not arrived yet.
   */
  distanceFrom(noteTime, nowTime) {
    return this.scroll.posAt(noteTime) - this.scroll.posAt(nowTime);
  }

  /** 0 at the receptor, 1 at the top of the visible range. Negative once a note has passed. */
  progressFrom(noteTime, nowTime) {
    return this.distanceFrom(noteTime, nowTime) / this.timeRange;
  }

  /** Pixels per scroll unit for a stage whose notes travel `travelPx` across `timeRange`. */
  pixelsPerUnit(travelPx) {
    const travel = num(travelPx, 0);
    return travel / (this.timeRange * this._rate);
  }

  /**
   * The y coordinate of a note, in the same convention the game's renderer uses.
   * Downscroll: the receptor is at `receptorY` and notes arrive from above (smaller y).
   * Upscroll is mirrored about the receptor.
   *
   * @param {number} noteTime chart time of the note
   * @param {number} nowTime chart time the stage is showing
   * @param {{ receptorY: number, travelPx: number, noteOffsetPx?: number }} geometry
   */
  yFor(noteTime, nowTime, { receptorY, travelPx, noteOffsetPx = 0 }) {
    const ppm = this.pixelsPerUnit(travelPx);
    const delta = this.distanceFrom(noteTime, nowTime) * ppm;
    const base = num(receptorY, 0) + num(noteOffsetPx, 0);
    return this._direction === Direction.UP ? base + delta : base - delta;
  }

  /** Whether a note is inside the visible range — what the renderer culls on. */
  isVisible(noteTime, nowTime, padding = 0.15) {
    const progress = this.progressFrom(noteTime, nowTime);
    return progress <= 1 + padding && progress >= -padding;
  }

  /* ── musical position ─────────────────────────────────────────────── */

  /** The red timing point in force at a chart time. */
  timingPointAt(chartMs) {
    const i = searchLastAtOrBefore(this.red, num(chartMs, 0));
    return this.red[i < 0 ? 0 : i];
  }

  bpmAt(chartMs) {
    const beatLength = this.timingPointAt(chartMs).beatLength;
    return beatLength > 0 ? 60000 / beatLength : 0;
  }

  /** Absolute beat count from the chart's first timing point, accounting for BPM changes. */
  beatsAt(chartMs) {
    const t = num(chartMs, 0);
    let beats = 0;
    for (let i = 0; i < this.red.length; i++) {
      const current = this.red[i];
      const next = this.red[i + 1];
      if (current.time > t) break;
      const to = next ? Math.min(next.time, t) : t;
      if (current.beatLength > 0) beats += Math.max(0, to - current.time) / current.beatLength;
    }
    return beats;
  }

  /**
   * The finest beat snap (of 1/1 … 1/16) a chart time sits on, within 2 ms, and osu!'s
   * colour for it. Mirrors the game's `BeatmapParser.snapColour` so the Timing Lab and the
   * game agree on what a note is snapped to.
   */
  beatSnap(chartMs) {
    const t = num(chartMs, 0);
    const point = this.timingPointAt(t);
    const beatLength = point.beatLength;
    if (!(beatLength > 0)) return { divisor: null, deviationMs: null, colour: null, beats: 0 };
    const beats = (t - point.time) / beatLength;
    for (const [divisor, colour] of SNAP_DIVISORS) {
      const scaled = beats * divisor;
      const deviationMs = Math.abs(scaled - Math.round(scaled)) * (beatLength / divisor);
      if (deviationMs < 2) {
        return { divisor, deviationMs, colour, beats, snappedBeat: Math.round(scaled) / divisor };
      }
    }
    return { divisor: null, deviationMs: null, colour: SNAP_UNSNAPPED, beats };
  }

  /** Every BPM change in the chart, with the span each one covers. */
  bpmChanges(endTime) {
    const end = num(endTime, 0);
    const out = [];
    for (let i = 0; i < this.red.length; i++) {
      const current = this.red[i];
      const next = this.red[i + 1];
      if (current.time > end) break;
      out.push({
        time: current.time,
        bpm: current.beatLength > 0 ? 60000 / current.beatLength : 0,
        beatLength: current.beatLength,
        meter: current.meter,
        until: next ? next.time : end,
      });
    }
    return out;
  }

  /** A plain object, for storing alongside a session record. */
  describe() {
    return {
      rate: this._rate,
      offsetMs: this._offset,
      scrollSpeed: this._scrollSpeed,
      timeRange: this.timeRange,
      direction: this._direction,
      // Counts, not the arrays: a description is stored with a session record and must not
      // shadow the `segments` a TimingEngine is constructed from.
      segmentCount: this.scroll.segments.length,
      redPointCount: this.red.length,
    };
  }

  static get LIMITS() { return LIMITS; }
}


