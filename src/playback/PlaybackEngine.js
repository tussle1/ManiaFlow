/**
 * PlaybackEngine — the clock and the state machine, and nothing else.
 *
 * It answers "where are we?" and never "what does that look like?". Rendering subscribes
 * to `onFrame` and draws; the engine does not know a canvas exists. That separation is why
 * the same engine can drive a preview, a Timing Lab scrub, or a schedule handed to the
 * keyboard adapter.
 *
 * Drift: position is always computed from an anchor
 * (`anchorSong + (now − anchorReal) × rate`) rather than accumulated frame by frame, so a
 * preview that runs for ten minutes is as accurate at the end as at the start. Re-anchoring
 * happens only on play, pause, seek, rate change and loop — each of which bumps `gen`, the
 * same signal the game's own clock uses to tell followers that a jump occurred.
 *
 * Clock source: an attached media element wins when it is playing, because it cannot drift
 * against the music. Otherwise the engine runs on `performance.now()` through an injectable
 * `clock()`, which is what makes it testable without waiting in real time.
 */

import { Emitter } from '../utils/emitter.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { num, validateRate, validateSeek, clampNumber } from '../utils/validation.js';

export const PlaybackState = Object.freeze({
  IDLE: 'idle',       // nothing loaded
  READY: 'ready',     // loaded, at the start, not running
  PLAYING: 'playing',
  PAUSED: 'paused',
  ENDED: 'ended',     // ran past the last note
  ERROR: 'error',
});

const TERMINAL = new Set([PlaybackState.IDLE, PlaybackState.ERROR]);

export class PlaybackEngine extends Emitter {
  /**
   * @param {object} config
   * @param {import('./TimingEngine.js').TimingEngine} config.timing
   * @param {number} config.durationMs chart time of the end
   * @param {() => number} [config.clock] monotonic millisecond clock (default performance.now)
   * @param {HTMLAudioElement} [config.audio] media element to treat as the master clock
   * @param {number} [config.frameRate] maximum frames per second to emit (default: uncapped)
   */
  constructor(config = {}) {
    super();
    if (!config.timing || typeof config.timing.chartTimeAt !== 'function') {
      throw new AppError('PlaybackEngine needs a TimingEngine', { code: ErrorCode.PLAYBACK_STATE });
    }
    this.timing = config.timing;
    this.clock = typeof config.clock === 'function' ? config.clock : () => performance.now();
    this.audio = config.audio || null;
    this.frameRate = clampNumber(config.frameRate, { min: 1, max: 240, fallback: 0 }).value;
    // Whether an attached media element keeps its pitch when the rate changes. The game
    // exposes the same choice as `audio.preservePitch`; a preview without audio ignores it.
    this.preservesPitch = config.preservesPitch !== false;

    this._duration = Math.max(0, num(config.durationMs, 0));
    this._state = PlaybackState.IDLE;
    this._songAnchor = 0;
    this._realAnchor = 0;
    this._pausedSong = 0;
    this._gen = 0;
    this._frame = 0;
    this._lastFrameAt = 0;
    this._frameListener = null;
    this._loopA = null;
    this._loopB = null;
    this._disposed = false;
    this._error = null;
    this._audioHandlers = null;
  }

  /* ── state ─────────────────────────────────────────────────────────── */

  get state() { return this._state; }
  get isRunning() { return this._state === PlaybackState.PLAYING; }
  get canPlay() { return !TERMINAL.has(this._state) && this._state !== PlaybackState.PLAYING; }
  get error() { return this._error; }
  /** Bumped on every jump, so a smoothed follower knows to restart. */
  get gen() { return this._gen; }
  get durationMs() { return this._duration; }
  get rate() { return this.timing.rate; }
  get offsetMs() { return this.timing.offsetMs; }
  get loop() { return { a: this._loopA, b: this._loopB }; }

  /** Song position in clock milliseconds — what the media element would report. */
  get songPosition() {
    if (this._state === PlaybackState.IDLE) return 0;
    if (this._state !== PlaybackState.PLAYING) return this._pausedSong;
    if (this._audioMasterActive) return this.audio.currentTime * 1000;
    return this._songAnchor + (this.clock() - this._realAnchor) * this.timing.rate;
  }

  /** Chart time: the song position with the timing offset applied. */
  get position() {
    return this.timing.chartTimeAt(this.songPosition);
  }

  /** 0…1 through the chart, clamped. */
  get progress() {
    if (this._duration <= 0) return 0;
    return Math.min(1, Math.max(0, this.position / this._duration));
  }

  get _audioMasterActive() {
    return !!this.audio && this._state === PlaybackState.PLAYING && !this.audio.paused && Number.isFinite(this.audio.currentTime);
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /**
   * Load a chart length. Any running playback stops; the engine goes to READY at `startAt`.
   */
  load({ durationMs, startAt = 0 } = {}) {
    const duration = num(durationMs, 0);
    if (!(duration > 0)) {
      throw new AppError('A chart needs a positive duration before it can be played', {
        code: ErrorCode.PLAYBACK_NO_CHART, detail: { durationMs: duration },
      });
    }
    this.stopFrameLoop();
    this._duration = duration;
    this._loopA = null;
    this._loopB = null;
    this._error = null;
    this._setSongPosition(clampNumber(startAt, { min: 0, max: duration, fallback: 0 }).value);
    this._setState(PlaybackState.READY);
    this.emit('load', { durationMs: this._duration });
    return this;
  }

  /** Attach (or detach) the media element that acts as the master clock. */
  attachAudio(audio) {
    this._detachAudio();
    this.audio = audio || null;
    if (!this.audio) return this;
    const onEnded = () => { if (this._state === PlaybackState.PLAYING) this._finish(); };
    const onPause = () => { if (this._state === PlaybackState.PLAYING && this.audio?.paused) this.pause(); };
    this.audio.addEventListener('ended', onEnded);
    this.audio.addEventListener('pause', onPause);
    this._audioHandlers = { onEnded, onPause };
    return this;
  }

  _detachAudio() {
    if (this.audio && this._audioHandlers) {
      this.audio.removeEventListener('ended', this._audioHandlers.onEnded);
      this.audio.removeEventListener('pause', this._audioHandlers.onPause);
    }
    this._audioHandlers = null;
  }

  /** Start from the current position. A no-op if already playing. */
  async play() {
    this._assertLoaded('play');
    if (this._disposed) throw new AppError('This engine has been disposed', { code: ErrorCode.PLAYBACK_STATE });
    if (this._state === PlaybackState.PLAYING) return this;
    if (this._state === PlaybackState.ENDED) this._setSongPosition(this._loopA ?? 0);

    const startSong = this._pausedSong;
    this._songAnchor = startSong;
    this._realAnchor = this.clock();
    this._gen++;

    if (this.audio) {
      // The media element takes over as the clock; keep its rate in step with ours.
      this.audio.playbackRate = this.timing.rate;
      if ('preservesPitch' in this.audio) this.audio.preservesPitch = this.preservesPitch;
      const target = Math.max(0, startSong) / 1000;
      if (Number.isFinite(this.audio.duration) && Math.abs(this.audio.currentTime - target) > 0.05) {
        try { this.audio.currentTime = target; } catch { /* not seekable yet; the anchor still holds */ }
      }
      try {
        await this.audio.play();
      } catch (err) {
        // Autoplay policy or a decode failure: fall back to the internal clock and say so,
        // rather than silently pretending the audio is driving.
        this._setState(PlaybackState.PLAYING);
        this.startFrameLoop();
        this.emit('warning', {
          message: `Audio could not start (${err.name}: ${err.message}). The preview is running on ManiaFlow's own clock, silently.`,
          code: 'audio-unavailable',
        });
        return this;
      }
      this._songAnchor = this.audio.currentTime * 1000;
      this._realAnchor = this.clock();
    }

    this._setState(PlaybackState.PLAYING);
    this.startFrameLoop();
    this.emit('play', { songPosition: startSong, rate: this.timing.rate });
    return this;
  }

  /** Hold at the current position. */
  pause() {
    if (this._state !== PlaybackState.PLAYING) return this;
    const at = this.songPosition;
    if (this.audio && !this.audio.paused) this.audio.pause();
    this.stopFrameLoop();
    this._pausedSong = at;
    this._gen++;
    this._setState(PlaybackState.PAUSED);
    this.emit('pause', { songPosition: at });
    return this;
  }

  /** Pause or play, whichever is not happening. */
  async toggle() {
    if (this._state === PlaybackState.PLAYING) return this.pause();
    return this.play();
  }

  /** Return to the start (or the loop start) and stop. */
  stop() {
    if (this._state === PlaybackState.IDLE) return this;
    if (this.audio && !this.audio.paused) this.audio.pause();
    this.stopFrameLoop();
    this._setSongPosition(this._loopA ?? 0);
    this._setState(PlaybackState.READY);
    this.emit('stop', { songPosition: this._pausedSong });
    return this;
  }

  /** Stop, then play from the beginning (or the loop start). */
  async restart() {
    this._assertLoaded('restart');
    this.stop();
    return this.play();
  }

  /**
   * Move to a chart time. Legal in every state except IDLE, and it keeps playing if it was.
   * @param {number} chartMs chart time, not song time
   */
  async seek(chartMs) {
    this._assertLoaded('seek');
    const chartTime = validateSeek(num(chartMs, 0), this._duration);
    const wasPlaying = this._state === PlaybackState.PLAYING;
    if (wasPlaying && this.audio && !this.audio.paused) this.audio.pause();
    this._setSongPosition(this.timing.clockTimeFor(chartTime));
    this._gen++;
    this.emit('seek', { chartTime, songPosition: this._pausedSong });
    if (wasPlaying) return this.play();
    if (this._state === PlaybackState.ENDED && chartTime < this._duration) this._setState(PlaybackState.PAUSED);
    return this;
  }

  /** Nudge by a chart-time delta. */
  seekBy(deltaMs) { return this.seek(this.position + num(deltaMs, 0)); }

  /** Change the playback rate without moving. */
  setRate(rate) {
    this._assertLoaded('setRate');
    const result = validateRate(rate);
    if (!Number.isFinite(num(rate, Number.NaN))) {
      throw new AppError(`Playback rate "${rate}" is not a number`, { code: ErrorCode.CONFIG_INVALID, detail: { rate } });
    }
    const next = result.value;
    if (Math.abs(next - this.timing.rate) < 1e-4) return this;
    // Re-anchor so the position does not jump when the slope changes.
    const at = this.songPosition;
    this.timing.setRate(next);
    this._songAnchor = at;
    this._realAnchor = this.clock();
    this._pausedSong = at;
    if (this.audio) {
      this.audio.playbackRate = next;
      if ('preservesPitch' in this.audio) this.audio.preservesPitch = this.preservesPitch;
    }
    this._gen++;
    this.emit('rate', { rate: next });
    return this;
  }

  /** Change the timing offset without moving the clock. */
  setOffset(offsetMs) {
    const next = this.timing.setOffset(offsetMs);
    this._gen++;
    this.emit('offset', { offsetMs: next });
    return this;
  }

  /**
   * Set an A–B loop in chart time. `null` clears one end, matching the game's practice bar.
   */
  setLoop(which, chartMs) {
    const value = chartMs == null ? null : validateSeek(num(chartMs, 0), this._duration);
    if (which === 'a') {
      this._loopA = value;
      if (this._loopB != null && value != null && this._loopB <= value) this._loopB = null;
    } else if (which === 'b') {
      this._loopB = value;
      if (this._loopA != null && value != null && this._loopA >= value) this._loopA = null;
    } else if (which === 'clear') {
      this._loopA = null;
      this._loopB = null;
    } else {
      throw new AppError(`Unknown loop point "${which}" — expected "a", "b" or "clear"`, { code: ErrorCode.PLAYBACK_STATE });
    }
    this.emit('loop', { a: this._loopA, b: this._loopB });
    return this;
  }

  /* ── frames ────────────────────────────────────────────────────────── */

  /**
   * Register the render callback. Exactly one is kept: a second registration replaces the
   * first, which is what stops two views from both driving the same engine.
   * @param {(frame: {chartTime:number, songPosition:number, progress:number, state:string, rate:number}) => void} listener
   */
  onFrame(listener) {
    if (typeof listener !== 'function') throw new TypeError('onFrame needs a function');
    this._frameListener = listener;
    return () => { if (this._frameListener === listener) this._frameListener = null; };
  }

  startFrameLoop() {
    this.stopFrameLoop();
    const step = () => {
      if (this._state !== PlaybackState.PLAYING) { this._frame = 0; return; }
      this._frame = requestAnimationFrame(step);
      const now = this.clock();
      if (this.frameRate > 0 && now - this._lastFrameAt < 1000 / this.frameRate - 1) return;
      this._lastFrameAt = now;
      this._tick();
    };
    this._frame = requestAnimationFrame(step);
  }

  stopFrameLoop() {
    if (this._frame) { cancelAnimationFrame(this._frame); this._frame = 0; }
  }

  /** Advance one step: handle the loop and the end, then notify the renderer. */
  _tick() {
    const chartTime = this.position;

    if (this._loopB != null && chartTime >= this._loopB) {
      const target = this._loopA ?? 0;
      this._setSongPosition(this.timing.clockTimeFor(target));
      this._gen++;
      this.emit('looped', { to: target });
    } else if (chartTime >= this._duration) {
      if (this._loopA != null && this._loopB == null) {
        this._setSongPosition(this.timing.clockTimeFor(this._loopA));
        this._gen++;
        this.emit('looped', { to: this._loopA });
      } else {
        this._finish();
        return;
      }
    }

    if (this._frameListener) {
      try {
        this._frameListener({
          chartTime: this.position,
          songPosition: this.songPosition,
          progress: this.progress,
          state: this._state,
          rate: this.timing.rate,
        });
      } catch (err) {
        console.error('[ManiaFlow] frame listener threw', err);
      }
    }
  }

  _finish() {
    const at = Math.min(this.songPosition, this.timing.clockTimeFor(this._duration));
    if (this.audio && !this.audio.paused) this.audio.pause();
    this.stopFrameLoop();
    this._pausedSong = at;
    this._gen++;
    this._setState(PlaybackState.ENDED);
    this.emit('end', { songPosition: at });
  }

  /** Put the engine into ERROR with a reason the UI can show. */
  fail(err) {
    const error = err instanceof AppError ? err : new AppError(err?.message || String(err), { code: ErrorCode.PLAYBACK_STATE, cause: err });
    this.stopFrameLoop();
    if (this.audio && !this.audio.paused) this.audio.pause();
    this._error = error;
    this._setState(PlaybackState.ERROR);
    this.emit('error', error);
    return this;
  }

  _setState(state) {
    if (this._state === state) return;
    const previous = this._state;
    this._state = state;
    this.emit('state', { state, previous });
  }

  _setSongPosition(songMs) {
    const clamped = Math.max(0, Math.min(this.timing.clockTimeFor(this._duration), num(songMs, 0)));
    this._pausedSong = clamped;
    this._songAnchor = clamped;
    this._realAnchor = this.clock();
  }

  _assertLoaded(action) {
    if (this._state === PlaybackState.IDLE) {
      throw new AppError(`Cannot ${action}: no chart is loaded`, { code: ErrorCode.PLAYBACK_NO_CHART });
    }
  }

  /** A snapshot for the status bar and for session records. */
  describe() {
    return {
      state: this._state,
      position: this._state === PlaybackState.IDLE ? 0 : this.position,
      songPosition: this.songPosition,
      progress: this.progress,
      rate: this.timing.rate,
      offsetMs: this.timing.offsetMs,
      durationMs: this._duration,
      loop: { a: this._loopA, b: this._loopB },
      gen: this._gen,
      clockSource: this._audioMasterActive ? 'audio' : 'internal',
      error: this._error ? this._error.message : null,
    };
  }

  /** Release everything: frames, listeners, audio handlers. The engine cannot restart. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.stopFrameLoop();
    // Stopping the media element matters as much as cancelling the frame: detaching the
    // listeners alone would leave the song playing with nothing tracking its position.
    if (this.audio && !this.audio.paused) {
      try { this.audio.pause(); } catch { /* already stopped */ }
    }
    this._detachAudio();
    this.audio = null;
    this._frameListener = null;
    this.removeAll();
  }
}
