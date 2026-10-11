/**
 * ChartCanvas — draws a mania stage.
 *
 * One canvas, one 2D context, and a fixed set of reusable objects. Nothing is allocated per
 * note per frame: the note list is indexed once when a chart loads, a binary search finds
 * the first visible note, and drawing walks forward from there. A 10 000-note chart costs
 * the same per frame as a 100-note one, because only the notes inside the visible time
 * range are touched.
 *
 * The renderer is driven from outside. It owns no clock and no animation loop of its own —
 * `draw(chartTime)` paints one frame and returns, which is what keeps timing and rendering
 * separate and lets the page stop drawing entirely when nothing is moving.
 */

import { sizeCanvas, pixelRatio } from '../utils/dom.js';
import { num } from '../utils/validation.js';
import { cssVar } from './primitives.js';
import { Direction } from '../playback/TimingEngine.js';

/** Find the first index whose note time is >= `time`. */
function lowerBound(list, time) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class StageRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} config
   * @param {import('../playback/TimingEngine.js').TimingEngine} config.timing
   * @param {{ label: string, style: object }} [config.theme] resolved colours, for a canvas
   *        that cannot read CSS variables at draw time without a style lookup per note
   */
  constructor(canvas, config = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('StageRenderer needs a canvas');
    if (!config.timing || typeof config.timing.yFor !== 'function') throw new TypeError('StageRenderer needs a TimingEngine');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.timing = config.timing;

    this.notes = [];
    this.keys = 0;
    this.barlines = [];
    this.chordTimes = new Set();
    this.held = [];
    this.judged = new Map();     // note → 'hit' | 'missed', set by a caller that knows
    this.playheadTime = null;

    this.options = {
      showBarlines: true,
      showLaneGuides: true,
      showSnapColours: false,
      showKeyLabels: true,
      markSimultaneous: true,
      cull: true,
      receptorMargin: 0.16,      // fraction of the height below the receptor (downscroll)
      stageMaxWidth: 560,
      noteHeight: 12,
      holdCapRadius: 3,
      keyLabels: null,
    };
    this.theme = null;
    this._needsTheme = true;
    this._width = 0;
    this._height = 0;
    this._ratio = 1;
    this._geometry = null;
    this.setOptions(config.options || {});
  }

  setOptions(options = {}) {
    Object.assign(this.options, options);
    this._geometry = null;   // lane guides and receptor position depend on the options
    return this;
  }

  /**
   * Load a chart. The notes are indexed by lane once here, so drawing never has to filter.
   * @param {{ notes: Array, keys: number, barlines?: Array }} chart
   */
  setChart({ notes, keys, barlines = [] }) {
    this.notes = Array.isArray(notes) ? notes : [];
    this.keys = Math.max(1, Math.round(num(keys, this.notes.keys || 4)));
    this.barlines = Array.isArray(barlines) ? barlines : [];
    this.byLane = Array.from({ length: this.keys }, (_, lane) => this.notes.filter((note) => note.col === lane));
    // A chord is any instant with more than one note; marking them is a set lookup at draw.
    this.chordTimes = new Set();
    if (this.options.markSimultaneous) {
      const counts = new Map();
      for (const note of this.notes) counts.set(note.time, (counts.get(note.time) || 0) + 1);
      for (const [time, count] of counts) if (count > 1) this.chordTimes.add(time);
    }
    this.judged.clear();
    this._geometry = null;
    return this;
  }

  setHeld(held) {
    this.held = Array.isArray(held) ? held : [];
    return this;
  }

  /** Colour palette, resolved once per theme change rather than per draw call. */
  resolveTheme() {
    this.theme = {
      background: cssVar('--bg-sunken', '#0b0c0f'),
      lane: cssVar('--grid', 'rgba(255,255,255,0.045)'),
      laneMajor: cssVar('--grid-major', 'rgba(255,255,255,0.09)'),
      receptor: cssVar('--receptor', 'rgba(255,255,255,0.24)'),
      note: cssVar('--accent', '#7c5cff'),
      noteBright: cssVar('--accent-bright', '#a48bff'),
      noteHold: cssVar('--note-hold', '#6a48e0'),
      notePast: cssVar('--note-past', '#3a4048'),
      chord: cssVar('--note-sim', '#d9a441'),
      text: cssVar('--fg-dim', '#a4abb7'),
      faint: cssVar('--fg-faint', '#565d69'),
      ok: cssVar('--ok', '#5ecf92'),
      danger: cssVar('--danger', '#e97373'),
      held: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    };
    this._needsTheme = false;
    return this.theme;
  }

  invalidateTheme() { this._needsTheme = true; }

  /** Lane geometry, recomputed only when the canvas or the options change. */
  geometry() {
    const W = this._width;
    const H = this._height;
    const stageWidth = Math.min(this.options.stageMaxWidth, Math.max(80, W * 0.86));
    const stageX = Math.round((W - stageWidth) / 2);
    const laneWidth = stageWidth / this.keys;
    const up = this.timing.direction === Direction.UP;
    const margin = Math.round(H * this.options.receptorMargin);
    const receptorY = up ? margin : H - margin;
    const travelPx = up ? H - margin * 2 : H - margin * 2;
    return { W, H, stageX, stageWidth, laneWidth, receptorY, travelPx, up };
  }

  /**
   * Paint one frame.
   * @param {number} chartTime the chart time the stage is showing
   */
  draw(chartTime) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this._needsTheme || !this.theme) this.resolveTheme();
    if (sizeCanvas(this.canvas)) {
      this._ratio = pixelRatio(2);
      this._width = this.canvas.clientWidth;
      this._height = this.canvas.clientHeight;
      this._geometry = null;
    } else if (!this._geometry) {
      this._width = this.canvas.clientWidth;
      this._height = this.canvas.clientHeight;
    }
    const W = this._width;
    const H = this._height;
    if (W < 2 || H < 2) return;
    ctx.setTransform(this._ratio, 0, 0, this._ratio, 0, 0);

    const g = this._geometry || (this._geometry = this.geometry());
    const now = num(chartTime, 0);

    // ── background and lanes ──
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, W, H);

    if (this.options.showLaneGuides) {
      ctx.strokeStyle = this.theme.lane;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let lane = 0; lane <= this.keys; lane++) {
        const x = Math.round(g.stageX + lane * g.laneWidth) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      ctx.stroke();
    }

    // ── bar lines ──
    if (this.options.showBarlines && this.barlines.length) {
      const first = this._firstVisibleBar(now);
      ctx.lineWidth = 1;
      for (let i = first; i < this.barlines.length; i++) {
        const bar = this.barlines[i];
        const y = this.timing.yFor(bar.time, now, { receptorY: g.receptorY, travelPx: g.travelPx });
        if (g.up ? y > H : y < 0) break;
        if (y < -2 || y > H + 2) continue;
        ctx.strokeStyle = bar.major ? this.theme.laneMajor : this.theme.lane;
        ctx.beginPath();
        ctx.moveTo(g.stageX, Math.round(y) + 0.5);
        ctx.lineTo(g.stageX + g.stageWidth, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }

    // ── held lane glow ──
    if (this.held.length) {
      ctx.fillStyle = this.theme.held;
      for (let lane = 0; lane < this.keys; lane++) {
        if (!this.held[lane]) continue;
        ctx.fillRect(g.stageX + lane * g.laneWidth, 0, g.laneWidth, H);
      }
    }

    // ── notes ──
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    const noteHeight = Math.max(4, Math.min(28, this.options.noteHeight));
    const inset = Math.max(1, Math.min(4, g.laneWidth * 0.09));
    const timeRange = this.timing.timeRange;
    const firstTime = this.options.cull ? now - timeRange * 0.25 : -Infinity;
    const lastTime = this.options.cull ? now + timeRange * 1.25 : Infinity;

    for (let lane = 0; lane < this.keys; lane++) {
      const list = this.byLane[lane];
      if (!list || !list.length) continue;
      const x = g.stageX + lane * g.laneWidth + inset;
      const w = g.laneWidth - inset * 2;
      const start = this.options.cull ? lowerBound(list, firstTime) : 0;

      for (let i = start; i < list.length; i++) {
        const note = list[i];
        if (note.time > lastTime) break;

        const yHead = this.timing.yFor(note.time, now, { receptorY: g.receptorY, travelPx: g.travelPx });
        const yTail = note.isLN
          ? this.timing.yFor(note.end, now, { receptorY: g.receptorY, travelPx: g.travelPx })
          : yHead;
        const top = Math.min(yHead, yTail);
        const bottom = Math.max(yHead, yTail);
        if (bottom < -noteHeight || top > H + noteHeight) continue;

        const passed = note.time < now;
        const verdict = this.judged.get(note);

        if (note.isLN) {
          const bodyTop = g.up ? Math.max(yHead, yTail) : Math.min(yHead, yTail);
          const bodyBottom = g.up ? Math.min(yHead, yTail) : Math.max(yHead, yTail);
          const height = Math.max(2, bodyBottom - bodyTop);
          // The beam: drawn first so the caps sit on top of it.
          ctx.fillStyle = passed ? this.theme.notePast : this.theme.noteHold;
          ctx.globalAlpha = passed ? 0.55 : 0.42;
          ctx.fillRect(x + w * 0.18, bodyTop, w * 0.64, height);
          ctx.globalAlpha = 1;
          this._roundRect(ctx, x + w * 0.18, bodyTop, w * 0.64, height, Math.min(this.options.holdCapRadius, w * 0.2));
          ctx.fillStyle = passed ? this.theme.notePast : this.theme.noteHold;
          ctx.globalAlpha = 0.28;
          ctx.fill();
          ctx.globalAlpha = 1;
          // Head and tail caps.
          this._cap(ctx, x, yHead - noteHeight / 2, w, noteHeight, this._noteColour(note, passed, verdict), g.up);
          this._cap(ctx, x, yTail - noteHeight / 2, w, noteHeight * 0.72, passed ? this.theme.notePast : this.theme.noteHold, g.up);
        } else {
          this._cap(ctx, x, yHead - noteHeight / 2, w, noteHeight, this._noteColour(note, passed, verdict), false);
        }
      }
    }
    ctx.restore();

    // ── receptor ──
    ctx.strokeStyle = this.theme.receptor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(g.stageX, Math.round(g.receptorY) + 0.5);
    ctx.lineTo(g.stageX + g.stageWidth, Math.round(g.receptorY) + 0.5);
    ctx.stroke();

    for (let lane = 0; lane < this.keys; lane++) {
      const x = g.stageX + lane * g.laneWidth + inset;
      const w = g.laneWidth - inset * 2;
      const pressed = !!this.held[lane];
      ctx.globalAlpha = pressed ? 0.95 : 0.3;
      ctx.fillStyle = pressed ? this.theme.noteBright : this.theme.receptor;
      this._roundRect(ctx, x, g.receptorY - 3, w, 6, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ── key labels ──
    if (this.options.showKeyLabels && g.laneWidth >= 22) {
      ctx.font = `600 ${Math.max(9, Math.min(12, g.laneWidth * 0.28))}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = this.theme.faint;
      const labelY = g.up ? g.receptorY - 16 : g.receptorY + 16;
      for (let lane = 0; lane < this.keys; lane++) {
        const label = this.options.keyLabels?.[lane];
        if (!label) continue;
        ctx.fillText(String(label), g.stageX + lane * g.laneWidth + g.laneWidth / 2, labelY);
      }
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }

  _noteColour(note, passed, verdict) {
    if (verdict === 'missed') return this.theme.danger;
    if (verdict === 'hit') return this.theme.ok;
    if (this.options.showSnapColours) {
      const snap = this.timing.beatSnap(note.time);
      if (snap?.colour) return snap.colour;
    }
    if (passed) return this.theme.notePast;
    if (this.options.markSimultaneous && this.chordTimes.has(note.time)) return this.theme.chord;
    return this.theme.note;
  }

  _cap(ctx, x, y, w, h, colour, flipped) {
    const radius = Math.min(4, w * 0.22, h / 2);
    ctx.fillStyle = colour;
    this._roundRect(ctx, x, y, w, h, radius);
    ctx.fill();
    // A thin top edge reads as a lit surface without a gradient or a shadow.
    if (!flipped && h >= 8) {
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      this._roundRect(ctx, x, y, w, Math.max(1, h * 0.18), radius);
      ctx.fill();
    }
  }

  _roundRect(ctx, x, y, w, height, r) {
    const radius = Math.max(0, Math.min(r, w / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + height - radius);
    ctx.quadraticCurveTo(x + w, y + height, x + w - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  _firstVisibleBar(now) {
    const g = this._geometry || this.geometry();
    const horizon = g.up ? -1 : g.H + 1;
    let index = this._barIndex || 0;
    // Walking back to zero on every frame is O(n) for nothing; bars only move one way.
    if (index > 0) {
      const y = this.timing.yFor(this.barlines[index - 1].time, now, { receptorY: g.receptorY, travelPx: g.travelPx });
      if (g.up ? y <= horizon : y >= horizon) index = 0;   // a seek backwards
    }
    while (index < this.barlines.length) {
      const y = this.timing.yFor(this.barlines[index].time, now, { receptorY: g.receptorY, travelPx: g.travelPx });
      if (g.up ? y <= g.H : y >= -1) break;
      index++;
    }
    this._barIndex = index;
    return index;
  }

  /** Screen y → chart time, for click-to-seek on the stage. */
  chartTimeAtY(y) {
    const g = this._geometry || this.geometry();
    const ppm = this.timing.pixelsPerUnit(g.travelPx);
    if (!(ppm > 0)) return 0;
    const deltaPx = g.up ? y - g.receptorY : g.receptorY - y;
    return this.timing.timeAtPos(this.timing.posAt(0) + deltaPx / ppm);
  }

  /** Call after a resize, an option change or a theme change. */
  invalidate() {
    this._geometry = null;
    this._barIndex = 0;
    this._width = this.canvas.clientWidth;
    this._height = this.canvas.clientHeight;
    sizeCanvas(this.canvas);
    this._ratio = pixelRatio(2);
    return this;
  }

  dispose() {
    this.notes = [];
    this.byLane = [];
    this.barlines = [];
    this.chordTimes.clear();
    this.judged.clear();
    this.ctx = null;
  }
}

/**
 * The density strip under the stage: the whole chart in one line, with a playhead, a loop
 * region, and click/drag to seek. Drawn from `densityBins`, so a long chart costs the same
 * as a short one.
 */
export class TimelineStrip {
  /**
   * @param {HTMLElement} container the `.timeline` element
   * @param {{ bins: number[], endTime: number, breaks?: Array<{start:number,end:number}> }} chart
   */
  constructor(container, chart = {}) {
    this.container = container;
    this.canvas = container.querySelector('canvas') || null;
    this.playhead = container.querySelector('.timeline__playhead') || null;
    this.loopEl = container.querySelector('.timeline__loop') || null;
    this.bins = Array.isArray(chart.bins) ? chart.bins : [];
    this.endTime = num(chart.endTime, 0);
    this.breaks = Array.isArray(chart.breaks) ? chart.breaks : [];
    this._drawn = false;
    this._theme = null;
  }

  setChart({ bins, endTime, breaks }) {
    this.bins = Array.isArray(bins) ? bins : [];
    this.endTime = num(endTime, 0);
    this.breaks = Array.isArray(breaks) ? breaks : [];
    this._drawn = false;
    return this;
  }

  /** Paint the density curve. Cheap enough to redo on resize, so it is not cached per frame. */
  draw() {
    const canvas = this.canvas;
    if (!canvas) return;
    if (!sizeCanvas(canvas)) {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio(2)));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio(2)));
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ratio = pixelRatio(2);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    if (!this.theme) {
      this.theme = {
        bar: cssVar('--accent', '#7c5cff'),
        breakColour: cssVar('--bg-active', '#232830'),
        line: cssVar('--line-soft', 'rgba(255,255,255,0.085)'),
      };
    }
    if (!this.bins.length || !(this.endTime > 0)) return;

    for (const b of this.breaks) {
      const x = (b.start / this.endTime) * W;
      const w = Math.max(1, ((b.end - b.start) / this.endTime) * W);
      ctx.fillStyle = this.theme.breakColour;
      ctx.fillRect(x, 0, w, H);
    }

    const max = Math.max(1, ...this.bins);
    const barWidth = W / this.bins.length;
    ctx.fillStyle = this.theme.bar;
    for (let i = 0; i < this.bins.length; i++) {
      const value = this.bins[i];
      if (!value) continue;
      const height = Math.max(1, (value / max) * (H - 3));
      ctx.globalAlpha = 0.35 + 0.6 * (value / max);
      ctx.fillRect(i * barWidth, H - height, Math.max(1, barWidth - (barWidth > 2 ? 1 : 0)), height);
    }
    ctx.globalAlpha = 1;
    this._drawn = true;
  }

  /** Position the playhead. Only the transform changes, so this is a compositor-only update. */
  setPlayhead(chartTime) {
    if (!this.playhead || !(this.endTime > 0)) return;
    const ratio = Math.max(0, Math.min(1, num(chartTime, 0) / this.endTime));
    this.playhead.style.transform = `translateX(${(ratio * this.container.clientWidth).toFixed(2)}px)`;
  }

  setLoop(a, b) {
    if (!this.loopEl) return;
    if (a == null && b == null) { this.loopEl.style.display = 'none'; return; }
    const width = this.container.clientWidth || 1;
    const left = ((a ?? 0) / this.endTime) * width;
    const right = ((b ?? this.endTime) / this.endTime) * width;
    this.loopEl.style.display = '';
    this.loopEl.style.left = `${left.toFixed(2)}px`;
    this.loopEl.style.width = `${Math.max(2, right - left).toFixed(2)}px`;
  }

  /** Client x → chart time. */
  timeAtClientX(clientX) {
    const rect = this.container.getBoundingClientRect();
    if (!rect.width || !(this.endTime > 0)) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * this.endTime;
  }

  dispose() {
    this.bins = [];
    this.canvas = null;
    this.playhead = null;
    this.loopEl = null;
    this.theme = null;
  }
}
