/**
 * PreferencesStore — one schema, one source of truth.
 *
 * The schema below drives three things that must never disagree: the defaults, the
 * validation applied on read and write, and the controls the Settings page renders. Adding
 * a preference means adding one entry here; the UI, the clamping and the reset behaviour
 * all follow.
 *
 * Persistence is `localStorage`. It is synchronous, it survives reloads, and it needs no
 * server. Corrupt or unavailable storage is handled explicitly: the raw text is quarantined
 * under a separate key so nothing is lost silently, defaults are used, and the failure is
 * reported to the caller rather than swallowed.
 */

import { Emitter } from '../utils/emitter.js';
import { clampNumber, num, bool as toBool, oneOf, isPlainObject } from '../utils/validation.js';

export const STORAGE_KEY = 'maniaflow.preferences.v1';
export const QUARANTINE_KEY = 'maniaflow.preferences.corrupt';
export const SCHEMA_VERSION = 1;

export const ACCENTS = [
  { id: 'violet', label: 'Electric violet' },
  { id: 'ice', label: 'Icy blue' },
  { id: 'mint', label: 'Mint' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
  { id: 'slate', label: 'Slate' },
];

export const THEMES = [
  { id: 'dark', label: 'Charcoal' },
  { id: 'light', label: 'Light' },
];

export const DENSITIES = [
  { id: 'compact', label: 'Compact' },
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'cozy', label: 'Cozy' },
];

export const MOTION_MODES = [
  { id: 'auto', label: 'Follow system' },
  { id: 'full', label: 'Full' },
  { id: 'reduced', label: 'Reduced' },
];

export const DISTRIBUTIONS = [
  { id: 'none', label: 'None (perfect)' },
  { id: 'gaussian', label: 'Gaussian' },
  { id: 'uniform', label: 'Uniform' },
  { id: 'bimodal', label: 'Bimodal (early/late)' },
];

export const BACKENDS = [
  { id: 'synthetic', label: 'Synthetic DOM events (in-page bridge)' },
  { id: 'os', label: 'Operating-system key input' },
];

/**
 * One entry per preference.
 * `type` decides both how the value is validated and which control the Settings page draws.
 */
export const PREFERENCES_SCHEMA = [
  // ── Appearance
  { key: 'appearance.accent', section: 'Appearance', group: 'Colour', label: 'Accent colour', type: 'select', default: 'violet', options: ACCENTS },
  { key: 'appearance.theme', section: 'Appearance', group: 'Colour', label: 'Theme', type: 'select', default: 'dark', options: THEMES },
  { key: 'appearance.contrast', section: 'Appearance', group: 'Colour', label: 'High contrast text', type: 'bool', default: false },
  { key: 'appearance.density', section: 'Appearance', group: 'Layout', label: 'Interface density', type: 'select', default: 'comfortable', options: DENSITIES },
  { key: 'appearance.motion', section: 'Appearance', group: 'Layout', label: 'Animation', type: 'select', default: 'auto', options: MOTION_MODES,
    hint: '“Follow system” honours your operating system’s reduce-motion setting.' },
  { key: 'appearance.unicodeMetadata', section: 'Appearance', group: 'Layout', label: 'Prefer metadata in the original language', type: 'bool', default: false },

  // ── Practice
  { key: 'practice.defaultRate', section: 'Practice', group: 'Playback', label: 'Default playback speed', type: 'range', default: 1, min: 0.25, max: 2, step: 0.05, format: 'percent' },
  { key: 'practice.scrollSpeed', section: 'Practice', group: 'Playback', label: 'Scroll speed', type: 'range', default: 22, min: 1, max: 40, step: 1,
    format: 'scrollSpeed', hint: 'The same 1–40 scale Ashtonk!mania uses, so a value read from the game means the same thing here.' },
  { key: 'practice.scrollDirection', section: 'Practice', group: 'Playback', label: 'Scroll direction', type: 'select', default: 'down',
    options: [{ id: 'down', label: 'Down' }, { id: 'up', label: 'Up' }] },
  { key: 'practice.offsetMs', section: 'Practice', group: 'Playback', label: 'Timing offset', type: 'range', default: 0, min: -300, max: 300, step: 1, format: 'ms' },
  { key: 'practice.preservePitch', section: 'Practice', group: 'Playback', label: 'Preserve pitch when changing speed', type: 'bool', default: true },
  { key: 'practice.autoplayPreview', section: 'Practice', group: 'Playback', label: 'Start the preview playing when a chart opens', type: 'bool', default: false },

  { key: 'practice.showBarlines', section: 'Practice', group: 'Preview', label: 'Bar lines', type: 'bool', default: true },
  { key: 'practice.showLaneGuides', section: 'Practice', group: 'Preview', label: 'Lane guides', type: 'bool', default: true },
  { key: 'practice.showSnapColours', section: 'Practice', group: 'Preview', label: 'Beat-snap note colours', type: 'bool', default: false,
    hint: 'osu!’s timing colours: 1/1 white, 1/2 red, 1/4 blue, 1/8 yellow, 1/16 purple.' },
  { key: 'practice.showKeyLabels', section: 'Practice', group: 'Preview', label: 'Key labels on the receptors', type: 'bool', default: true },
  { key: 'practice.markSimultaneous', section: 'Practice', group: 'Preview', label: 'Highlight simultaneous notes', type: 'bool', default: true },
  { key: 'practice.visibleNotes', section: 'Practice', group: 'Preview', label: 'Only draw notes near the receptor', type: 'bool', default: true,
    hint: 'Culling keeps a long chart smooth. Turn it off to draw every note every frame.' },

  // ── Timing analysis
  { key: 'timing.jackWindowMs', section: 'Timing', group: 'Analysis', label: 'Jack window', type: 'range', default: 220, min: 40, max: 600, step: 10, format: 'ms',
    hint: 'How close two notes in the same lane must be to count as a jack.' },
  { key: 'timing.densityWindowMs', section: 'Timing', group: 'Analysis', label: 'Peak density window', type: 'range', default: 1000, min: 250, max: 4000, step: 250, format: 'ms' },
  { key: 'timing.chordToleranceMs', section: 'Timing', group: 'Analysis', label: 'Simultaneous-note tolerance', type: 'range', default: 0, min: 0, max: 10, step: 1, format: 'ms',
    hint: '0 ms matches Ashtonk!mania exactly: only notes at the same instant are a chord.' },

  // ── Simulation
  { key: 'simulation.distribution', section: 'Simulation', group: 'Timing profile', label: 'Distribution', type: 'select', default: 'none', options: DISTRIBUTIONS },
  { key: 'simulation.sigmaMs', section: 'Simulation', group: 'Timing profile', label: 'Sigma', type: 'range', default: 0, min: 0, max: 200, step: 1, format: 'ms' },
  { key: 'simulation.rangeMs', section: 'Simulation', group: 'Timing profile', label: 'Uniform range', type: 'range', default: 0, min: 0, max: 200, step: 1, format: 'ms' },
  { key: 'simulation.biasMs', section: 'Simulation', group: 'Timing profile', label: 'Bias', type: 'range', default: 0, min: -200, max: 200, step: 1, format: 'ms' },
  { key: 'simulation.splitRatio', section: 'Simulation', group: 'Timing profile', label: 'Early / late split', type: 'range', default: 0.5, min: 0, max: 1, step: 0.05, format: 'ratio' },
  { key: 'simulation.seed', section: 'Simulation', group: 'Timing profile', label: 'Seed', type: 'int', default: 1, min: 1, max: 2147483647,
    hint: 'The same seed and profile always produce the same run, so two experiments can be compared.' },
  { key: 'simulation.tapHoldMs', section: 'Simulation', group: 'Schedule', label: 'Tap hold', type: 'range', default: 20, min: 5, max: 120, step: 1, format: 'ms' },
  { key: 'simulation.minHoldMs', section: 'Simulation', group: 'Schedule', label: 'Minimum hold', type: 'range', default: 5, min: 5, max: 40, step: 1, format: 'ms',
    hint: 'Ashtonk!mania’s verifier rejects a hold under 5 ms as impossible input, so this cannot go lower.' },
  { key: 'simulation.leadMs', section: 'Simulation', group: 'Schedule', label: 'Lead-in before the first key', type: 'range', default: 250, min: 50, max: 5000, step: 50, format: 'ms' },

  // ── Integration
  { key: 'integration.enabled', section: 'Integration', group: 'Bridge', label: 'Connect to the bridge', type: 'bool', default: true },
  { key: 'integration.autoRequestLibrary', section: 'Integration', group: 'Bridge', label: 'Read the chart library when the bridge connects', type: 'bool', default: true },
  { key: 'integration.pollHz', section: 'Integration', group: 'Bridge', label: 'State poll rate', type: 'range', default: 12, min: 0, max: 30, step: 1, format: 'hz',
    hint: '0 stops polling; the UI then updates only on events.' },
  { key: 'integration.requestTimeoutMs', section: 'Integration', group: 'Bridge', label: 'Request timeout', type: 'range', default: 8000, min: 1000, max: 60000, step: 500, format: 'ms' },

  // ── Input
  { key: 'input.backend', section: 'Input', group: 'Backend', label: 'Input backend', type: 'select', default: 'synthetic', options: BACKENDS },
  { key: 'input.osBackendId', section: 'Input', group: 'Backend', label: 'OS helper', type: 'text', default: '',
    hint: 'Filled in from the helpers detected in Settings → Integration.' },
  { key: 'input.requirePractice', section: 'Input', group: 'Safety', label: 'Refuse to arm outside the game’s practice mode', type: 'bool', default: true,
    hint: 'Leave this on. A scored play is re-judged server-side and perfect-timing input is rejected as inhuman.' },
  { key: 'input.releaseOnBlur', section: 'Input', group: 'Safety', label: 'Release all keys if ManiaFlow loses focus', type: 'bool', default: true },
  { key: 'input.compensateLatency', section: 'Input', group: 'Timing', label: 'Compensate for the game’s input latency setting', type: 'bool', default: true },

  // ── Performance
  { key: 'performance.pixelRatioCap', section: 'Performance', group: 'Rendering', label: 'Canvas resolution cap', type: 'range', default: 2, min: 1, max: 3, step: 0.25, format: 'ratio',
    hint: 'Lower on a high-DPI display if the preview is not smooth.' },
  { key: 'performance.frameRate', section: 'Performance', group: 'Rendering', label: 'Frame rate cap', type: 'range', default: 0, min: 0, max: 144, step: 6, format: 'fps',
    hint: '0 leaves the preview uncapped at the display’s refresh rate.' },
  { key: 'performance.sessionHistoryLimit', section: 'Performance', group: 'Data', label: 'Sessions kept', type: 'range', default: 200, min: 20, max: 2000, step: 20, format: 'count' },
];

const BY_KEY = new Map(PREFERENCES_SCHEMA.map((entry) => [entry.key, entry]));

/** The default value of every preference, as a plain object. */
export function defaultPreferences() {
  const out = {};
  for (const entry of PREFERENCES_SCHEMA) out[entry.key] = structuredCloneSafe(entry.default);
  return out;
}

function structuredCloneSafe(value) {
  return typeof value === 'object' && value !== null ? JSON.parse(JSON.stringify(value)) : value;
}

/** Validate one value against its schema entry. Unknown keys are rejected. */
export function validatePreference(key, value) {
  const entry = BY_KEY.get(key);
  if (!entry) return { ok: false, value: undefined, reason: `Unknown preference "${key}"` };
  switch (entry.type) {
    case 'bool': {
      const accepted = typeof value === 'boolean' || value === 'true' || value === 'false';
      const next = toBool(value, entry.default);
      // A value that was not a boolean still ends up usable, but replacing it is a repair
      // and the health report counts repairs. Hiding one would understate what was fixed.
      return { ok: accepted, value: next, reason: accepted ? null : `"${value}" is not a boolean; using ${next}` };
    }
    case 'select': {
      const allowed = entry.options.map((o) => o.id);
      const next = oneOf(value, allowed, entry.default);
      return { ok: next === value, value: next, reason: next === value ? null : `"${value}" is not one of ${allowed.join(', ')}` };
    }
    case 'range':
    case 'int': {
      const result = clampNumber(value, {
        min: num(entry.min, -Infinity), max: num(entry.max, Infinity),
        fallback: entry.default, integer: entry.type === 'int' || Number.isInteger(entry.step),
      });
      if (!Number.isFinite(num(value, Number.NaN))) {
        return { ok: false, value: result.value, reason: `"${value}" is not a number` };
      }
      return { ok: !result.clamped, value: result.value, reason: result.reason };
    }
    case 'text':
      return { ok: typeof value === 'string', value: typeof value === 'string' ? value.slice(0, 512) : String(entry.default ?? '') };
    default:
      return { ok: false, value: entry.default, reason: `Preference "${key}" has an unsupported type` };
  }
}

export class PreferencesStore extends Emitter {
  /**
   * @param {{ storage?: Storage, key?: string }} [options] `storage` is injectable so tests
   *        can exercise the corrupt and unavailable paths without touching localStorage.
   */
  constructor(options = {}) {
    super();
    this.storage = options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.key = options.key || STORAGE_KEY;
    this.quarantineKey = QUARANTINE_KEY;
    this.values = defaultPreferences();
    this.overrides = new Map();   // lane key-map overrides and other structured state
    /** @type {{ available: boolean, recovered: boolean, quarantined: string|null, reason: string|null }} */
    this.health = { available: !!this.storage, recovered: false, quarantined: null, reason: null };
  }

  /** Read from storage, repairing anything invalid. Call once at start-up. */
  load() {
    if (!this.storage) {
      this.health = { available: false, recovered: false, quarantined: null, reason: 'This browser offers no localStorage, so preferences last for this session only.' };
      this.emit('health', this.health);
      return this.values;
    }
    let raw = null;
    try {
      raw = this.storage.getItem(this.key);
    } catch (err) {
      this.health = { available: false, recovered: false, quarantined: null, reason: `Preferences could not be read: ${err.message}` };
      this.emit('health', this.health);
      return this.values;
    }
    if (raw == null) {
      this.health = { available: true, recovered: false, quarantined: null, reason: null };
      return this.values;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this._quarantine(raw, `Stored preferences were not valid JSON (${err.message})`);
      return this.values;
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.values)) {
      this._quarantine(raw, 'Stored preferences had an unexpected shape');
      return this.values;
    }

    const repaired = [];
    const next = defaultPreferences();
    for (const [key, value] of Object.entries(parsed.values)) {
      if (!BY_KEY.has(key)) { repaired.push({ key, reason: 'no longer a known preference' }); continue; }
      const result = validatePreference(key, value);
      next[key] = result.value;
      if (!result.ok) repaired.push({ key, reason: result.reason || 'replaced with the default' });
    }
    this.values = next;
    this.overrides = new Map(Object.entries(isPlainObject(parsed.overrides) ? parsed.overrides : {}));
    this.health = {
      available: true,
      recovered: repaired.length > 0,
      quarantined: null,
      reason: repaired.length ? `${repaired.length} stored value(s) were invalid and were reset: ${repaired.slice(0, 3).map((r) => `${r.key} (${r.reason})`).join('; ')}${repaired.length > 3 ? '; …' : ''}` : null,
      repaired,
      version: parsed.version ?? null,
    };
    this.emit('health', this.health);
    return this.values;
  }

  _quarantine(raw, reason) {
    // Keep the unreadable text: a preference file is small, and throwing away something the
    // user cannot see is how data gets lost without anybody knowing.
    try {
      this.storage.setItem(this.quarantineKey, JSON.stringify({ at: Date.now(), reason, raw: String(raw).slice(0, 200000) }));
    } catch { /* nowhere to put it */ }
    this.values = defaultPreferences();
    this.health = { available: true, recovered: true, quarantined: this.quarantineKey, reason };
    this.emit('health', this.health);
  }

  get(key) {
    if (this.overrides.has(key)) return this.overrides.get(key);
    if (key in this.values) return this.values[key];
    const entry = BY_KEY.get(key);
    return entry ? structuredCloneSafe(entry.default) : undefined;
  }

  /**
   * Set one preference. An invalid value is clamped to something legal rather than stored
   * as given, and the clamping is reported so the UI can say what happened.
   */
  set(key, value) {
    const result = validatePreference(key, value);
    if (result.value === undefined) {
      this.emit('invalid', { key, reason: result.reason });
      return { ok: false, key, reason: result.reason, value: this.get(key) };
    }
    const previous = this.get(key);
    this.values[key] = result.value;
    this._scheduleSave();
    this.emit('change', { key, value: result.value, previous, clamped: !result.ok, reason: result.reason });
    return { ok: true, key, value: result.value, clamped: !result.ok, reason: result.reason };
  }

  /** Structured values that are not in the schema — the per-chart lane overrides. */
  setOverride(key, value) {
    if (value == null) this.overrides.delete(key);
    else this.overrides.set(key, value);
    this._scheduleSave();
    this.emit('change', { key, value, override: true });
    return { ok: true, key, value };
  }

  reset(key) {
    if (key === undefined) return this.resetAll();
    const entry = BY_KEY.get(key);
    if (!entry) return { ok: false, reason: `Unknown preference "${key}"` };
    const previous = this.values[key];
    this.values[key] = structuredCloneSafe(entry.default);
    this._scheduleSave();
    this.emit('change', { key, value: this.values[key], previous, reset: true });
    return { ok: true, key, value: this.values[key] };
  }

  resetAll() {
    const previous = { ...this.values };
    this.values = defaultPreferences();
    this.overrides.clear();
    this._saveNow();
    this.emit('reset', { previous });
    return { ok: true };
  }

  /** The schema entries for one section, in declaration order. */
  section(name) {
    return PREFERENCES_SCHEMA.filter((entry) => entry.section === name);
  }

  get sections() {
    return [...new Set(PREFERENCES_SCHEMA.map((entry) => entry.section))];
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    // Debounced: a slider fires dozens of changes a second and storage is synchronous.
    this._saveTimer = setTimeout(() => this._saveNow(), 220);
  }

  _saveNow() {
    clearTimeout(this._saveTimer);
    if (!this.storage) return { ok: false, reason: 'No storage available' };
    try {
      this.storage.setItem(this.key, JSON.stringify({
        version: SCHEMA_VERSION,
        savedAt: Date.now(),
        values: this.values,
        overrides: Object.fromEntries(this.overrides),
      }));
      return { ok: true };
    } catch (err) {
      const quota = /quota|exceeded/i.test(err.name || err.message || '');
      this.health = { ...this.health, available: false, reason: quota ? 'Storage is full — preferences cannot be saved.' : `Preferences could not be saved: ${err.message}` };
      this.emit('health', this.health);
      return { ok: false, reason: this.health.reason, quota };
    }
  }

  /** Force the pending write, for a page that is about to be closed. */
  flush() { return this._saveNow(); }

  /** Everything, for the export button and for diagnostics. */
  export() {
    return {
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      values: { ...this.values },
      overrides: Object.fromEntries(this.overrides),
      health: { ...this.health },
    };
  }

  /** Import a previously exported object, validating every key. */
  import(data) {
    if (!isPlainObject(data) || !isPlainObject(data.values)) {
      return { ok: false, reason: 'That is not a ManiaFlow preferences export' };
    }
    const applied = [];
    const rejected = [];
    for (const [key, value] of Object.entries(data.values)) {
      if (!BY_KEY.has(key)) { rejected.push({ key, reason: 'unknown preference' }); continue; }
      const result = this.set(key, value);
      if (result.ok) applied.push(key);
      else rejected.push({ key, reason: result.reason });
    }
    if (isPlainObject(data.overrides)) {
      for (const [key, value] of Object.entries(data.overrides)) this.setOverride(key, value);
    }
    this._saveNow();
    return { ok: true, applied: applied.length, rejected };
  }

  dispose() {
    this.flush();
    this.removeAll();
  }
}

export { BY_KEY as PREFERENCE_ENTRIES };
