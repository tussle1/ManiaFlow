/**
 * Deterministic random numbers.
 *
 * Every "random" thing ManiaFlow does — simulated timing jitter, a shuffled practice
 * order, a jitter experiment — is reproducible from a seed, so the same experiment can be
 * run twice and compared, and so a session record can state the seed that produced it.
 * Nothing here is used for anything that needs cryptographic strength.
 */

/** Hash a string or number into a 32-bit unsigned integer seed. */
export function toSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(Math.trunc(value)) >>> 0;
  }
  const text = String(value ?? '');
  // FNV-1a: short, well distributed, and identical on every run.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32 — a small, fast, well-tested 32-bit PRNG.
 * Returns a function producing floats in [0, 1).
 */
export function mulberry32(seed) {
  let state = toSeed(seed) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random source with the distributions the Timing Lab offers.
 * Constructed from a seed, so two instances with the same seed produce identical streams.
 */
export class SeededRandom {
  constructor(seed = 1) {
    this.seed = toSeed(seed);
    this._next = mulberry32(this.seed);
    this._spare = null;
    this.draws = 0;
  }

  /** Uniform in [0, 1). */
  float() { this.draws++; return this._next(); }

  /** Uniform integer in [min, max] inclusive. */
  int(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    if (hi < lo) return lo;
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** Uniform in [min, max). */
  range(min, max) { return min + this.float() * (max - min); }

  /** Standard normal, via Box–Muller with the second value cached. */
  gaussian() {
    if (this._spare != null) {
      const spare = this._spare;
      this._spare = null;
      return spare;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.float() * 2 - 1;
      v = this.float() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * factor;
    this.draws++;
    return u * factor;
  }

  pick(list) {
    if (!Array.isArray(list) || !list.length) return undefined;
    return list[Math.min(list.length - 1, Math.floor(this.float() * list.length))];
  }

  /** A new array in random order; the input is not modified. */
  shuffle(list) {
    const out = Array.isArray(list) ? [...list] : [];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Reset to the seed, so a repeated experiment starts from the same state. */
  reset(seed = this.seed) {
    this.seed = toSeed(seed);
    this._next = mulberry32(this.seed);
    this._spare = null;
    this.draws = 0;
    return this;
  }
}
