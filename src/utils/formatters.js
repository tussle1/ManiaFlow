/**
 * Formatting. Every user-visible number in the application is produced here, so
 * "1:23.4" means the same thing on the dashboard, in the library and in a session report.
 *
 * Chart *names* are not here: `displayName` and `displayFullName` live beside the record
 * they describe, in `src/chart/ChartRecord.js`.
 */

/** Milliseconds → `m:ss` or `m:ss.t`. */
export function formatDuration(ms, { tenths = false } = {}) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const base = `${minutes}:${String(seconds).padStart(2, '0')}`;
  if (!tenths) return base;
  return `${base}.${Math.floor((total % 1000) / 100)}`;
}

/** Milliseconds → `1h 04m` / `12m 30s` / `45s`, for session lengths. */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A signed millisecond value, e.g. `+12.4 ms`. */
export function formatMs(ms, { digits = 1, sign = true } = {}) {
  if (!Number.isFinite(ms)) return '—';
  const fixed = ms.toFixed(digits);
  const prefix = sign && ms > 0 ? '+' : '';
  return `${prefix}${fixed} ms`;
}

/** 1234.5 → `1,234.5`. */
export function formatCount(value) {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** 0.9732 → `97.32%`. */
export function formatPercent(ratio, digits = 1) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Playback rate → `100%`. */
export function formatRate(rate) {
  if (!Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** BPM, hiding the meaningless `0` a chart with no red lines produces. */
export function formatBpm(bpm, min, max) {
  if (!Number.isFinite(bpm) || bpm <= 0) return '—';
  const rounded = Math.round(bpm * 100) / 100;
  const hasSpread = Number.isFinite(min) && Number.isFinite(max) && Math.abs(max - min) > 0.01;
  return hasSpread ? `${rounded} (${Math.round(min)}–${Math.round(max)})` : String(rounded);
}

/** Star rating → `5.23★`. */
export function formatStars(stars) {
  if (!Number.isFinite(stars) || stars <= 0) return '—';
  return `${stars.toFixed(2)}★`;
}

/** A timestamp → the local, compact form used in lists. */
export function formatDateTime(timestamp) {
  const date = toDate(timestamp);
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

/** A timestamp → "4 minutes ago", which is how recents read best. */
export function formatRelative(timestamp, now = Date.now()) {
  const date = toDate(timestamp);
  if (!date) return '—';
  const delta = now - date.getTime();
  if (delta < 0) return formatDateTime(timestamp);
  const units = [
    ['year', 31536000000], ['month', 2592000000], ['day', 86400000],
    ['hour', 3600000], ['minute', 60000],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, msPerUnit] of units) {
    if (Math.abs(delta) >= msPerUnit) return rtf.format(-Math.round(delta / msPerUnit), unit);
  }
  return rtf.format(-Math.round(delta / 1000), 'second');
}

function toDate(timestamp) {
  if (timestamp instanceof Date) return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const d = new Date(timestamp);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof timestamp === 'string') {
    const d = new Date(timestamp);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Bytes → `1.4 MB`. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** The human label for a `KeyboardEvent.code`, matching the game's own `keyLabel`. */
export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /^Numpad[0-9]$/.test(code)) return `Num${code.slice(6)}`;
  return ({
    Space: 'Space', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
    Backquote: '`', ShiftLeft: 'LShift', ShiftRight: 'RShift', ControlLeft: 'LCtrl',
    ControlRight: 'RCtrl', AltLeft: 'LAlt', AltRight: 'RAlt', CapsLock: 'Caps',
    Tab: 'Tab', Enter: 'Enter', Escape: 'Esc', Backspace: '⌫', Delete: 'Del',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    MetaLeft: 'LMeta', MetaRight: 'RMeta', IntlBackslash: '\\',
    NumpadAdd: 'Num+', NumpadSubtract: 'Num−', NumpadMultiply: 'Num×',
    NumpadDivide: 'Num÷', NumpadDecimal: 'Num.', NumpadEnter: 'NumEnter',
  })[code] || code;
}

/** A chart's display title: unicode first when the preference says so. */
/** Truncate in the middle, keeping a filename's extension visible. */
export function ellipsizeMiddle(text, max = 44) {
  if (typeof text !== 'string' || text.length <= max) return text ?? '';
  const keep = Math.floor((max - 1) / 2);
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}

/** A stable, short identifier for logs and exports. */
export function shortId(value, length = 8) {
  const text = String(value ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).padStart(length, '0').slice(0, length);
}
