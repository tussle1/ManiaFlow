/**
 * Validation.
 *
 * Every value that enters the application from outside — a parsed chart, a stored
 * preference, a message from the bridge, a number typed into a field — passes through
 * here. The functions never throw on bad data; they return a normalised value plus a
 * reason, so a caller can decide whether to fall back to a default or to complain.
 */

/** Coerce to a finite number inside [min, max]. */
export function clampNumber(value, { min = -Infinity, max = Infinity, fallback = 0, integer = false } = {}) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) return { ok: false, value: fallback, reason: 'not a finite number' };
  let out = Math.min(max, Math.max(min, n));
  if (integer) out = Math.round(out);
  const changed = out !== n;
  return { ok: true, value: out, clamped: changed, reason: changed ? `clamped to ${out}` : null };
}

/** A number, or the fallback. Never NaN. */
export function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export function int(value, fallback = 0) {
  return Math.round(num(value, fallback));
}

export function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One of a fixed set of strings. */
export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Validate a whole object against a spec of `{ field: validator }`.
 * Returns `{ value, errors }` where `value` always has every field filled in.
 */
export function validateShape(input, spec) {
  const source = isPlainObject(input) ? input : {};
  const value = {};
  const errors = [];
  for (const [field, validate] of Object.entries(spec)) {
    const result = validate(source[field], field);
    value[field] = result.value;
    if (result.reason) errors.push({ field, reason: result.reason, given: source[field] });
  }
  return { value, errors, valid: errors.length === 0 };
}

/* ── domain validators ─────────────────────────────────────────────────── */

export const LIMITS = Object.freeze({
  KEYS_MIN: 1,
  KEYS_MAX: 18,
  RATE_MIN: 0.25,
  RATE_MAX: 2,
  OFFSET_MIN: -500,
  OFFSET_MAX: 500,
  SPEED_MIN: 0.25,
  SPEED_MAX: 2,
  JITTER_MAX: 200,
  NOTE_TIME_MAX: 6 * 3600 * 1000, // the game's own MAX_MAP_TIME: 6 hours
});

/** Playback rate. The game's verifier accepts 0.5..2; ManiaFlow's preview allows 0.25..2. */
export function validateRate(value) {
  return clampNumber(value, { min: LIMITS.RATE_MIN, max: LIMITS.RATE_MAX, fallback: 1 });
}

/** Timing offset in milliseconds. */
export function validateOffset(value) {
  return clampNumber(value, { min: LIMITS.OFFSET_MIN, max: LIMITS.OFFSET_MAX, fallback: 0 });
}

/** A KeyboardEvent.code. Only the shapes a mania keybind can actually use. */
const CODE_PATTERN = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:1[0-9]|2[0-4]|[1-9])|Space|Semicolon|Quote|Comma|Period|Slash|Backslash|Minus|Equal|Backquote|BracketLeft|BracketRight|Tab|Enter|Escape|Backspace|Delete|Arrow(?:Left|Right|Up|Down)|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Meta(?:Left|Right)|CapsLock|IntlBackslash|Numpad(?:Add|Subtract|Multiply|Divide|Decimal|Enter))$/;

export function isValidKeyCode(code) {
  return typeof code === 'string' && CODE_PATTERN.test(code);
}

export function validateKeyCode(value) {
  if (isValidKeyCode(value)) return { ok: true, value, reason: null };
  return { ok: false, value: null, reason: `"${String(value).slice(0, 32)}" is not a recognised key code` };
}

/**
 * Wrap a field validator so that an absent field takes its default silently.
 * "Not supplied" and "supplied but wrong" are different things: only the second is
 * worth reporting, otherwise every partial configuration looks invalid.
 */
function optional(validate) {
  return (value, field) => (value === undefined ? validate(undefined, field, true) : validate(value, field, false));
}

/**
 * A distribution description for offline timing simulation.
 * Every field is bounded so a bad preference cannot produce an absurd schedule.
 */
export function validateDistribution(input) {
  const bounded = (limits, fallback) => (value, _field, absent) => {
    const result = clampNumber(value, { ...limits, fallback });
    return { value: result.value, reason: absent || !result.clamped ? null : result.reason };
  };
  const shape = validateShape(input, {
    kind: (v) => {
      const kind = oneOf(v, ['none', 'gaussian', 'uniform', 'bimodal'], 'none');
      return { value: kind, reason: v === undefined || kind === v ? null : `"${v}" is not a distribution` };
    },
    sigmaMs: optional(bounded({ min: 0, max: LIMITS.JITTER_MAX }, 0)),
    rangeMs: optional(bounded({ min: 0, max: LIMITS.JITTER_MAX }, 0)),
    biasMs: optional(bounded({ min: -LIMITS.JITTER_MAX, max: LIMITS.JITTER_MAX }, 0)),
    seed: optional(bounded({ min: 0, max: 2 ** 31 - 1, integer: true }, 1)),
    splitRatio: optional(bounded({ min: 0, max: 1 }, 0.5)),
  });
  return { ...shape.value, valid: shape.valid, errors: shape.errors };
}

/** A seek target inside a chart's own span. */
export function validateSeek(ms, duration) {
  const span = num(duration, 0);
  return clampNumber(ms, { min: 0, max: Math.max(0, span), fallback: 0 }).value;
}
