/**
 * Error types.
 *
 * Every failure the user can see is one of these, and each carries a message written for
 * a person rather than a stack trace. `AppError.code` is what the UI branches on, so a
 * screen can react to "no bridge connected" without string-matching a message.
 */

export const ErrorCode = Object.freeze({
  // chart handling
  CHART_PARSE: 'chart-parse',
  CHART_UNSUPPORTED: 'chart-unsupported',
  CHART_INVALID: 'chart-invalid',
  CHART_EMPTY: 'chart-empty',

  // configuration
  CONFIG_INVALID: 'config-invalid',
  CONFIG_CORRUPT: 'config-corrupt',

  // storage
  STORAGE_UNAVAILABLE: 'storage-unavailable',
  STORAGE_QUOTA: 'storage-quota',
  STORAGE_READ: 'storage-read',
  STORAGE_WRITE: 'storage-write',

  // integration
  BRIDGE_UNAVAILABLE: 'bridge-unavailable',
  BRIDGE_TIMEOUT: 'bridge-timeout',
  BRIDGE_REFUSED: 'bridge-refused',
  GAME_UNAVAILABLE: 'game-unavailable',
  GAME_UNSUPPORTED: 'game-unsupported',

  // input
  INPUT_GATE_REFUSED: 'input-gate-refused',
  INPUT_BACKEND_UNAVAILABLE: 'input-backend-unavailable',
  INPUT_KEY_UNSUPPORTED: 'input-key-unsupported',
  INPUT_BUSY: 'input-busy',

  // playback
  PLAYBACK_STATE: 'playback-state',
  PLAYBACK_NO_CHART: 'playback-no-chart',

  // misc
  VALIDATION: 'validation',
  UNKNOWN: 'unknown',
});

export class AppError extends Error {
  /**
   * @param {string} message human-readable, safe to show
   * @param {{ code?: string, cause?: unknown, detail?: Record<string, unknown>, recoverable?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = options.code || ErrorCode.UNKNOWN;
    this.cause = options.cause;
    this.detail = options.detail || null;
    // A recoverable error is worth a toast; a fatal one is worth a dialog.
    this.recoverable = options.recoverable !== false;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      detail: this.detail,
      recoverable: this.recoverable,
    };
  }
}

export class ChartError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: ErrorCode.CHART_PARSE, ...options });
    this.name = 'ChartError';
  }
}

export class ValidationError extends AppError {
  /**
   * @param {string} message
   * @param {{ field?: string, value?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { code: ErrorCode.VALIDATION, ...options });
    this.name = 'ValidationError';
    if (options.field) this.field = options.field;
    if (options.value !== undefined) this.value = options.value;
  }
}

export class IntegrationError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: ErrorCode.BRIDGE_UNAVAILABLE, ...options });
    this.name = 'IntegrationError';
  }
}

export class InputError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: ErrorCode.INPUT_GATE_REFUSED, ...options });
    this.name = 'InputError';
  }
}

/** Wrap anything thrown into an AppError, keeping the original as `cause`. */
export function toAppError(err, fallbackMessage = 'Something went wrong') {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new AppError(err.message || fallbackMessage, { code: ErrorCode.UNKNOWN, cause: err });
  }
  return new AppError(String(err) || fallbackMessage, { code: ErrorCode.UNKNOWN, cause: err });
}

/** The message to show a user. Never leaks a stack. */
export function describeError(err) {
  if (!err) return 'Unknown error';
  if (err instanceof AppError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}
