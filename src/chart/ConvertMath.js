/**
 * ConvertMath — the pieces of osu!lazer's legacy conversion that a *native* osu!mania
 * chart still depends on.
 *
 * A mode-3 chart is not free of conversion logic. Ashtonk!mania routes two things through
 * lazer's generators even for a native mania map:
 *
 *   • a **spinner** becomes a hold whose column is chosen by lazer's seeded
 *     `LegacyRandom`, not by the object's x position
 *   • a **slider** becomes a hold whose length comes from lazer's control-point stack
 *     (SV clamped to 0.1–10, beat length clamped to 6 ms–60 s)
 *
 * Getting either wrong puts notes in the wrong lane, which for a practice tool is worse
 * than refusing the chart. So this module ports exactly those two paths, and
 * tests/chart-parser.test.js cross-checks the result against the game's own parser on
 * real beatmaps.
 *
 * Deliberately *not* ported: the full osu!standard → mania conversion (circles, sliders,
 * pattern generators, column count). That is several hundred lines of lazer-specific
 * behaviour, and a chart converted by an approximation would silently disagree with the
 * game. ManiaFlow reports a mode-0 chart as unsupported locally and reads the game's own
 * converted notes when a bridge is connected.
 */

const f32 = Math.fround;

/** C#'s `Math.Round`: a value exactly halfway rounds to the even neighbour. */
export function roundEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * osu!stable's xorshift generator, as lazer's `LegacyRandom`.
 * Seeded from the difficulty settings, so a spinner lands in the same column for everyone.
 */
export class LegacyRandom {
  constructor(seed) {
    this.x = seed >>> 0;
    this.y = 842502087;
    this.z = 3579807591;
    this.w = 273326509;
  }

  nextUInt() {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return this.w;
  }

  next() { return this.nextUInt() & 0x7fffffff; }
  nextDouble() { return this.next() / 2147483648; }
  nextRange(lo, hi) { return Math.trunc(lo + this.nextDouble() * (hi - lo)); }
}

function parseDifficultyNumber(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)); }

/**
 * The difficulty settings exactly as osu! reads them: single precision, each within osu!'s
 * own range, and approach rate falling back to accuracy when absent.
 */
export function difficultySettings(chart) {
  const d = (chart && chart.difficulty) || {};
  const od = f32(parseDifficultyNumber(d.OverallDifficulty, 5));
  const cs = f32(parseDifficultyNumber(d.CircleSize, 5));
  const hp = f32(parseDifficultyNumber(d.HPDrainRate, 5));
  const ar = f32(parseDifficultyNumber(d.ApproachRate, od));
  return {
    od: clamp(od, 0, 10),
    cs: chart?.mode === 3 ? clamp(cs, 1, 18) : clamp(cs, 0, 10),
    hp: clamp(hp, 0, 10),
    ar: clamp(ar, 0, 10),
    sliderMultiplier: clamp(parseDifficultyNumber(d.SliderMultiplier, 1.4), 0.4, 3.6),
  };
}

/** The random numbers' seed: drain rate, circle size, accuracy and approach rate. */
export function seedOf(D) {
  return roundEven(f32(D.hp + D.cs)) * 20 + Math.trunc(D.od * 41.2) + roundEven(D.ar);
}

/** Last index whose `time <= t`, or -1. The list must be time-ordered. */
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
 * lazer's control-point view of a chart's timing: beat length and scroll velocity at any
 * instant, with osu!'s own clamps. A red line resets SV to 1; a green line at the same
 * instant wins over it.
 */
export function controlPoints(chart) {
  const points = (chart && chart.timingPoints) || [];
  const red = points.filter((tp) => tp.uninherited);

  const sv = [];
  for (const tp of points) {
    const value = tp.uninherited ? 1 : clamp(tp.beatLength < 0 ? 100 / -tp.beatLength : 1, 0.1, 10);
    const last = sv[sv.length - 1];
    if (last && last.time === tp.time) { if (!tp.uninherited) last.sv = value; }
    else sv.push({ time: tp.time, sv: value });
  }

  return {
    beatLength(time) {
      if (!red.length) return 1000;
      const i = searchLastAtOrBefore(red, time);
      return clamp(red[i < 0 ? 0 : i].beatLength, 6, 60000);
    },
    sv(time) {
      const i = searchLastAtOrBefore(sv, time);
      return i < 0 ? 1 : sv[i].sv;
    },
  };
}

/**
 * How long a slider in a mania chart lasts (lazer's `ConvertSlider`): its length over its
 * velocity, once per span. Zero for a slider with no length.
 */
export function sliderDuration(chart, hitObject) {
  const slider = hitObject?.slider;
  const length = slider && slider.length > 0 ? slider.length : 0;
  if (!length) return 0;
  const spans = Math.max(1, slider ? slider.slides : 1);
  const D = difficultySettings(chart);
  const cp = controlPoints(chart);
  const velocity = (100 * D.sliderMultiplier * cp.sv(hitObject.time)) / cp.beatLength(hitObject.time);
  if (!(velocity > 0)) return 0;
  return (spans * length) / velocity;
}

/**
 * A per-chart spinner placer. Created once and called for each spinner in hit-object
 * order, because the generator's random state advances from one spinner to the next.
 *
 * @returns {(hitObject: object) => { col: number, time: number, end: number, isLN: boolean }}
 */
export function spinnerPlacer(chart, keys) {
  const D = difficultySettings(chart);
  const rnd = new LegacyRandom(seedOf(D));
  // lazer's generators start their random column search at 1 on an 8-column stage.
  const randomStart = keys === 8 ? 1 : 0;

  return function place(hitObject) {
    const time = hitObject.time;
    // osu! reads a position from a file as whole numbers.
    const end = Math.trunc(Math.max(time, hitObject.endTime || time));
    const hold = end - time >= 100;

    let col;
    const finishHitsound = (hitObject.hitsound & 4) !== 0;
    if (keys === 8 && finishHitsound && end - time < 1000) {
      col = 0;
    } else {
      const lower = keys === 8 ? randomStart : 0;
      // lazer then walks to a column the previous pattern does not occupy. For a mania
      // spinner the previous pattern is always the empty one, so the walk never moves;
      // the structure is kept so the port stays honest if that ever changes.
      col = findAvailable(rnd.nextRange(lower, keys), {
        lower, upper: keys, taken: () => false,
        next: () => rnd.nextRange(lower, keys),
      });
    }
    return { col, time, end: hold ? end : time, isLN: hold };
  };
}

/** lazer's `findAvailable`: return `initial` if free, else re-roll until one is. */
function findAvailable(initial, { lower, upper, taken, next }) {
  const valid = (c) => !taken(c);
  if (valid(initial)) return initial;
  let any = false;
  for (let i = lower; i < upper; i++) if (valid(i)) { any = true; break; }
  if (!any) return initial;
  let candidate = initial;
  // Bounded: `next` re-rolls from a finite range, and at least one column is valid.
  for (let guard = 0; guard < 1000 && !valid(candidate); guard++) candidate = next(candidate);
  return candidate;
}

export const ConvertMath = { LegacyRandom, difficultySettings, seedOf, controlPoints, sliderDuration, spinnerPlacer, roundEven };
