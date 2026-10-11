/**
 * Playback state transitions, speed, seeking, looping, drift and teardown.
 *
 * The clock and `requestAnimationFrame` are injected, so these tests do not wait in real
 * time and cannot flake on a slow machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PlaybackEngine, PlaybackState } from '../src/playback/PlaybackEngine.js';
import { TimingEngine } from '../src/playback/TimingEngine.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';

/** A controllable monotonic clock and a manual rAF queue. */
function harness(overrides = {}) {
  let now = 1000;
  const frames = [];
  let frameId = 1;
  const timing = new TimingEngine({
    segments: [{ time: -1e7, pos: -1e7, vel: 1 }],
    red: [{ time: 0, beatLength: 500, meter: 4 }],
    ...overrides.timing,
  });
  const engine = new PlaybackEngine({
    timing,
    durationMs: 60000,
    clock: () => now,
    ...overrides,
    timing,
  });
  return {
    engine,
    timing,
    advance(ms) { now += ms; },
    get now() { return now; },
    /** Run every queued frame once, as a browser would between two vsyncs. */
    runFrames(times = 1) {
      for (let i = 0; i < times; i++) {
        const batch = frames.splice(0, frames.length);
        for (const callback of batch) callback(now);
      }
    },
    frames,
  };
}

// rAF is a browser API; these tests run in Node, so provide the minimum the engine uses.
globalThis.requestAnimationFrame = (callback) => {
  const id = globalThis.__mfFrameId = (globalThis.__mfFrameId || 0) + 1;
  globalThis.__mfFrames = globalThis.__mfFrames || new Map();
  globalThis.__mfFrames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => { globalThis.__mfFrames?.delete(id); };

/** Replace the harness frame runner with one that drives the real (stubbed) rAF queue. */
function withFrames(h) {
  h.runFrames = (times = 1) => {
    for (let i = 0; i < times; i++) {
      const queue = globalThis.__mfFrames;
      if (!queue || !queue.size) return;
      const entries = [...queue.entries()];
      queue.clear();
      for (const [, callback] of entries) callback(h.now);
    }
  };
  return h;
}

test('a new engine has nothing loaded and refuses to play', async () => {
  const { engine } = harness();
  assert.equal(engine.state, PlaybackState.IDLE);
  assert.equal(engine.position, 0);
  assert.equal(engine.canPlay, false);
  // play/seek/restart are async (an attached media element may need awaiting), so a misuse
  // surfaces as a rejection rather than a synchronous throw.
  const noChart = (e) => e instanceof AppError && e.code === ErrorCode.PLAYBACK_NO_CHART;
  await assert.rejects(() => engine.play(), noChart);
  await assert.rejects(() => engine.seek(1000), noChart);
  await assert.rejects(() => engine.restart(), noChart);
  assert.throws(() => engine.setRate(1.5), noChart);
});

test('loading a chart requires a positive duration', () => {
  const { engine } = harness();
  assert.throws(() => engine.load({ durationMs: 0 }), (e) => e.code === ErrorCode.PLAYBACK_NO_CHART);
  assert.throws(() => engine.load({ durationMs: -5 }), (e) => e.code === ErrorCode.PLAYBACK_NO_CHART);
  assert.throws(() => engine.load({ durationMs: 'long' }), (e) => e.code === ErrorCode.PLAYBACK_NO_CHART);
  engine.load({ durationMs: 30000 });
  assert.equal(engine.state, PlaybackState.READY);
  assert.equal(engine.durationMs, 30000);
  assert.equal(engine.position, 0);
});

test('play → pause → play holds and resumes at the same place', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  const states = [];
  engine.on('state', ({ state }) => states.push(state));
  engine.load({ durationMs: 60000 });

  await engine.play();
  assert.equal(engine.state, PlaybackState.PLAYING);
  h.advance(5000);
  assert.equal(engine.position, 5000, 'position follows the clock');
  const at = engine.songPosition;

  engine.pause();
  assert.equal(engine.state, PlaybackState.PAUSED);
  h.advance(20000);
  assert.equal(engine.songPosition, at, 'a paused engine does not move while real time passes');
  assert.equal(engine.position, 5000);

  await engine.play();
  assert.equal(engine.state, PlaybackState.PLAYING);
  h.advance(1000);
  assert.equal(engine.songPosition, at + 1000, 'resuming continues from where it stopped');

  assert.deepEqual(states, [PlaybackState.READY, PlaybackState.PLAYING, PlaybackState.PAUSED, PlaybackState.PLAYING]);
});

test('playing twice is a no-op, and pause while stopped is a no-op', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  await engine.play();
  const gen = engine.gen;
  await engine.play();
  assert.equal(engine.gen, gen, 'a second play did not re-anchor');
  h.advance(2000);
  assert.equal(engine.position, 2000);
  engine.stop();
  const pausedGen = engine.gen;
  engine.pause();
  assert.equal(engine.gen, pausedGen, 'pausing a stopped engine changes nothing');
  assert.equal(engine.state, PlaybackState.READY);
});

test('stop returns to the start; restart plays from there', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  await engine.play();
  h.advance(12000);
  engine.stop();
  assert.equal(engine.state, PlaybackState.READY);
  assert.equal(engine.position, 0);
  await engine.restart();
  assert.equal(engine.state, PlaybackState.PLAYING);
  h.advance(500);
  assert.equal(engine.position, 500);
});

test('seeking works while playing and while paused, and clamps to the chart', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });

  await engine.seek(30000);
  assert.equal(engine.state, PlaybackState.READY);
  assert.equal(engine.position, 30000);

  await engine.play();
  await engine.seek(45000);
  assert.equal(engine.state, PlaybackState.PLAYING, 'seeking while playing keeps playing');
  h.advance(1000);
  assert.equal(engine.position, 46000);

  await engine.seek(-99999);
  assert.equal(engine.position, 0, 'a seek below the start clamps to 0');
  await engine.seek(1e9);
  assert.equal(engine.position, 60000, 'a seek past the end clamps to the duration');
  await engine.seek('not a number');
  assert.equal(engine.position, 0, 'an unreadable seek falls back rather than becoming NaN');

  await engine.seekBy(5000);
  assert.equal(engine.position, 5000);
  await engine.seekBy(-2000);
  assert.equal(engine.position, 3000);
});

test('seeking bumps the generation so followers restart instead of smoothing over a jump', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  const before = engine.gen;
  await engine.seek(10000);
  assert.ok(engine.gen > before, 'a seek is a jump');
  const afterSeek = engine.gen;
  h.advance(500);
  assert.equal(engine.gen, afterSeek, 'ordinary elapsed time is not a jump');
  engine.setRate(1.5);
  assert.ok(engine.gen > afterSeek, 'a rate change re-anchors, so it is a jump too');
});

test('rate changes scale elapsed time without moving the current position', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  await engine.play();
  h.advance(10000);
  assert.equal(engine.position, 10000);

  engine.setRate(2);
  assert.equal(engine.position, 10000, 'the position does not jump when the slope changes');
  assert.equal(engine.rate, 2);
  h.advance(1000);
  assert.equal(engine.position, 12000, 'two seconds of chart per second of real time');

  engine.setRate(0.5);
  assert.equal(engine.position, 12000);
  h.advance(1000);
  assert.equal(engine.position, 12500);

  engine.setRate(1);
  assert.throws(() => engine.setRate('fast'), /not a number/);
  engine.setRate(99);
  assert.equal(engine.rate, 2, 'clamped to the maximum');
  engine.setRate(0);
  assert.equal(engine.rate, 0.25, 'clamped to the minimum');
  // Setting the same rate again is a no-op and does not re-anchor.
  const gen = engine.gen;
  engine.setRate(0.25);
  assert.equal(engine.gen, gen);
});

test('offsets shift judgement without shifting the clock', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  await engine.play();
  h.advance(10000);
  const song = engine.songPosition;
  engine.setOffset(40);
  assert.equal(engine.songPosition, song, 'the clock itself did not move');
  assert.equal(engine.position, song - 40, 'the chart time did');
  assert.equal(engine.offsetMs, 40);
});

test('no drift: position is derived from an anchor, not accumulated', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 600000 });
  await engine.play();
  // Simulate a long run with very uneven frame delivery. A frame-by-frame accumulator would
  // drift here; an anchored calculation cannot.
  for (const step of [16, 17, 15, 33, 8, 120, 16, 400, 17, 900]) {
    h.advance(step);
    h.runFrames(1);
  }
  const elapsed = [16, 17, 15, 33, 8, 120, 16, 400, 17, 900].reduce((a, b) => a + b, 0);
  assert.equal(engine.position, elapsed, 'position equals total elapsed time exactly');
  // And after many pauses and resumes.
  for (let i = 0; i < 50; i++) {
    engine.pause();
    h.advance(37);
    await engine.play();
    h.advance(13);
  }
  assert.equal(engine.position, elapsed + 50 * 13, 'fifty pause/resume cycles add exactly the played time');
});

test('a chart end moves to ENDED and stops the frame loop', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 10000 });
  let ended = 0;
  engine.on('end', () => ended++);
  await engine.play();
  h.advance(5000);
  h.runFrames(1);
  assert.equal(engine.state, PlaybackState.PLAYING);
  h.advance(6000);
  h.runFrames(1);
  assert.equal(engine.state, PlaybackState.ENDED);
  assert.equal(ended, 1);
  assert.equal(engine.progress, 1);
  const at = engine.songPosition;
  h.advance(5000);
  h.runFrames(1);
  assert.equal(engine.songPosition, at, 'an ended engine does not keep running');
  assert.equal(ended, 1, 'end fires once');
  // Playing again after the end restarts from the top.
  await engine.play();
  assert.equal(engine.state, PlaybackState.PLAYING);
  assert.ok(engine.position < 1000, 'replaying starts near the beginning');
});

test('an A–B loop wraps, and clearing it lets the chart end', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  engine.setLoop('a', 10000);
  engine.setLoop('b', 20000);
  assert.deepEqual(engine.loop, { a: 10000, b: 20000 });
  let loops = 0;
  engine.on('looped', () => loops++);

  await engine.play();
  await engine.seek(19500);
  h.advance(1000);
  h.runFrames(1);
  assert.equal(loops, 1);
  assert.ok(engine.position >= 10000 && engine.position < 11000, 'the loop wrapped to A');

  // As in the game's practice bar, moving one end past the other clears the *other* end
  // rather than leaving an impossible range behind.
  engine.setLoop('b', 5000);
  assert.equal(engine.loop.b, 5000, 'B is set to what was asked for');
  assert.equal(engine.loop.a, null, 'and the A that was after it is cleared');
  engine.setLoop('a', 30000);
  assert.equal(engine.loop.a, 30000);
  engine.setLoop('b', 25000);
  assert.equal(engine.loop.a, null, 'an A after B clears A');

  engine.setLoop('clear');
  assert.deepEqual(engine.loop, { a: null, b: null });
  assert.throws(() => engine.setLoop('middle', 1000), /Unknown loop point/);
});

test('an A-only loop repeats to the end of the chart', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 10000 });
  engine.setLoop('a', 2000);
  await engine.play();
  h.advance(11000);
  h.runFrames(1);
  assert.equal(engine.state, PlaybackState.PLAYING, 'an A loop never reaches ENDED');
  assert.ok(engine.position >= 2000 && engine.position < 3000, 'it wrapped back to the loop start');
});

test('loop points are clamped and validated', () => {
  const { engine } = harness();
  engine.load({ durationMs: 30000 });
  engine.setLoop('a', 999999);
  assert.equal(engine.loop.a, 30000, 'clamped to the duration');
  engine.setLoop('b', -50);
  assert.equal(engine.loop.b, 0, 'clamped to zero');
  engine.setLoop('a', null);
  assert.equal(engine.loop.a, null);
});

test('frames are delivered with everything a renderer needs, and only while playing', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  const seen = [];
  engine.onFrame((frame) => seen.push(frame));

  h.advance(100);
  h.runFrames(3);
  assert.equal(seen.length, 0, 'nothing is drawn before play');

  await engine.play();
  h.advance(1000);
  h.runFrames(2);
  assert.ok(seen.length > 0);
  const frame = seen[seen.length - 1];
  for (const key of ['chartTime', 'songPosition', 'progress', 'state', 'rate']) {
    assert.ok(key in frame, `a frame carries ${key}`);
  }
  assert.equal(frame.state, PlaybackState.PLAYING);
  assert.ok(Number.isFinite(frame.chartTime));

  engine.pause();
  const count = seen.length;
  h.advance(5000);
  h.runFrames(5);
  assert.equal(seen.length, count, 'no frames while paused');
});

test('a second frame listener replaces the first instead of doubling the work', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  let a = 0;
  let b = 0;
  engine.onFrame(() => { a++; });
  engine.onFrame(() => { b++; });
  await engine.play();
  h.advance(100);
  h.runFrames(4);
  assert.equal(a, 0, 'the first listener was replaced');
  assert.ok(b > 0);
  assert.throws(() => engine.onFrame('not a function'), TypeError);
});

test('a throwing frame listener is contained', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  let after = 0;
  engine.onFrame(() => { throw new Error('renderer exploded'); });
  await engine.play();
  h.advance(100);
  h.runFrames(2);
  assert.equal(engine.state, PlaybackState.PLAYING, 'the engine survives a bad renderer');
  engine.onFrame(() => { after++; });
  h.runFrames(2);
  assert.ok(after > 0);
});

test('frameRate caps emission without changing the clock', async () => {
  const h = withFrames(harness({ frameRate: 10 }));
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  let frames = 0;
  engine.onFrame(() => frames++);
  await engine.play();
  // 60 rAF callbacks 2ms apart: far more than 10 per second, so most are skipped.
  for (let i = 0; i < 60; i++) { h.advance(2); h.runFrames(1); }
  assert.ok(frames < 20, `capped to roughly 10/s, saw ${frames}`);
  assert.equal(engine.position, 120, 'the clock is unaffected by the cap');
});

test('a media element becomes the master clock when it plays', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  const listeners = new Map();
  const audio = {
    currentTime: 0, duration: 60, paused: true, playbackRate: 1, preservesPitch: true,
    play: async () => { audio.paused = false; },
    pause: () => { audio.paused = true; },
    addEventListener: (type, fn) => { listeners.set(type, fn); },
    removeEventListener: (type) => { listeners.delete(type); },
  };
  engine.attachAudio(audio);
  engine.load({ durationMs: 60000 });

  await engine.play();
  assert.equal(audio.paused, false);
  assert.equal(engine.describe().clockSource, 'audio');
  audio.currentTime = 12.5;
  assert.equal(engine.songPosition, 12500, 'the media element decides the position');
  h.advance(1000);
  assert.equal(engine.songPosition, 12500, 'the internal clock is not also advancing it');

  audio.pause();
  listeners.get('pause')();
  assert.equal(engine.state, PlaybackState.PAUSED, 'a media pause pauses the engine');

  await engine.play();
  audio.currentTime = 60;
  listeners.get('ended')();
  assert.equal(engine.state, PlaybackState.ENDED);
});

test('rate changes reach the media element, and pitch preservation is passed through', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  const audio = {
    currentTime: 0, duration: 60, paused: false, playbackRate: 1, preservesPitch: true,
    play: async () => {}, pause: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  };
  engine.attachAudio(audio);
  engine.load({ durationMs: 60000 });
  engine.setRate(1.5);
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(audio.preservesPitch, true);
  const plain = new PlaybackEngine({ timing: new TimingEngine({ segments: [{ time: 0, pos: 0, vel: 1 }] }), durationMs: 1000, clock: () => 0, preservesPitch: false });
  plain.attachAudio(audio);
  plain.load({ durationMs: 60000 });
  plain.setRate(0.75);
  assert.equal(audio.preservesPitch, false, 'the preference is honoured, not assumed');
});

test('audio that cannot start falls back to the internal clock and says so', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  const warnings = [];
  engine.on('warning', (w) => warnings.push(w));
  const audio = {
    currentTime: 0, duration: 60, paused: true, playbackRate: 1,
    play: async () => { throw new DOMException('play() failed', 'NotAllowedError'); },
    pause: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  };
  globalThis.DOMException = globalThis.DOMException || class DOMException extends Error { constructor(m, n) { super(m); this.name = n; } };
  engine.attachAudio(audio);
  engine.load({ durationMs: 60000 });
  await engine.play();
  assert.equal(engine.state, PlaybackState.PLAYING, 'the preview still runs');
  assert.equal(engine.describe().clockSource, 'internal');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'audio-unavailable');
  assert.match(warnings[0].message, /silently/);
  h.advance(1000);
  assert.equal(engine.position, 1000, 'and it keeps time on its own clock');
});

test('progress is clamped and zero-length charts do not divide by zero', () => {
  const { engine } = harness();
  engine.load({ durationMs: 1 });
  assert.equal(engine.progress, 0);
  engine.load({ durationMs: 1000, startAt: 500 });
  assert.equal(engine.progress, 0.5);
  engine.load({ durationMs: 1000, startAt: 99999 });
  assert.equal(engine.progress, 1, 'a start beyond the end clamps');
});

test('describe() is a complete, serialisable snapshot', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000, startAt: 5000 });
  await engine.play();
  h.advance(1000);
  const snapshot = engine.describe();
  assert.equal(snapshot.state, PlaybackState.PLAYING);
  assert.equal(snapshot.position, 6000);
  assert.equal(snapshot.durationMs, 60000);
  assert.equal(snapshot.clockSource, 'internal');
  assert.equal(snapshot.error, null);
  assert.ok(JSON.stringify(snapshot), 'the snapshot serialises for a session record');
});

test('fail() surfaces an error rather than failing silently', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  engine.load({ durationMs: 60000 });
  await engine.play();
  const seen = [];
  engine.on('error', (e) => seen.push(e));
  engine.fail(new Error('the chart disappeared'));
  assert.equal(engine.state, PlaybackState.ERROR);
  assert.equal(engine.error.message, 'the chart disappeared');
  assert.equal(seen.length, 1);
  assert.equal(engine.describe().error, 'the chart disappeared');
  h.advance(1000);
  h.runFrames(3);
  assert.equal(engine.state, PlaybackState.ERROR, 'an errored engine does not resume by itself');
  // A non-AppError is wrapped so the UI always has a code to branch on.
  engine.fail('plain string');
  assert.ok(engine.error instanceof AppError);
});

test('dispose() cancels frames, detaches audio and stops emitting', async () => {
  const h = withFrames(harness());
  const { engine } = h;
  const audio = {
    currentTime: 0, duration: 60, paused: false, playbackRate: 1,
    play: async () => {}, pause: () => { audio.paused = true; },
    addEventListener: () => {}, removeEventListener: () => {},
  };
  engine.attachAudio(audio);
  engine.load({ durationMs: 60000 });
  await engine.play();
  let states = 0;
  engine.on('state', () => states++);
  engine.dispose();
  assert.equal(audio.paused, true, 'audio was stopped');
  assert.equal(engine.listenerCount('state'), 0, 'listeners were removed');
  h.advance(1000);
  h.runFrames(3);
  assert.equal(states, 0, 'nothing is emitted after disposal');
  engine.dispose();
  await assert.rejects(() => engine.play(), /disposed/);
});
