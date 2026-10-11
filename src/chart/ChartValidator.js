/**
 * ChartValidator — says what is wrong with a chart instead of failing quietly.
 *
 * A problem stops ManiaFlow from using the chart; a warning means it can be used but
 * something is off. Neither is ever dropped on the floor: the library shows both, and an
 * import reports the count of lines that had to be skipped.
 */

import { ErrorCode } from '../utils/errors.js';
import { LIMITS } from '../utils/validation.js';
import { keyCount, redTimingPoints } from './ChartParser.js';

export const Severity = Object.freeze({ PROBLEM: 'problem', WARNING: 'warning' });

/**
 * @param {import('./ChartParser.js').ParsedChart} chart
 * @param {{ availableFiles?: Set<string>, sourceName?: string }} [context]
 * @returns {{ problems: string[], warnings: string[], ok: boolean, severity: string }}
 */
export function validateChart(chart, context = {}) {
  const problems = [];
  const warnings = [];

  if (!chart || typeof chart !== 'object') {
    return { problems: ['No chart data'], warnings: [], ok: false, severity: Severity.PROBLEM };
  }

  // ── mode ──
  if (chart.mode === 3) {
    // native mania: fine
  } else if (chart.mode === 0) {
    problems.push('osu!standard difficulty (mode 0): ManiaFlow does not reimplement the game\'s lazer conversion. Connect the bridge to read the converted notes.');
  } else if (chart.mode === 1) {
    problems.push('osu!taiko difficulty (mode 1) cannot be played as mania');
  } else if (chart.mode === 2) {
    problems.push('osu!catch difficulty (mode 2) cannot be played as mania');
  } else {
    problems.push(`Unknown game mode ${chart.mode}`);
  }

  // ── content ──
  if (!Array.isArray(chart.hitObjects) || chart.hitObjects.length === 0) {
    problems.push('The chart has no hit objects');
  }
  if (!Array.isArray(chart.timingPoints) || chart.timingPoints.length === 0) {
    problems.push('The chart has no timing points');
  } else if (!chart.timingPoints.some((tp) => tp.uninherited && tp.beatLength > 0)) {
    problems.push('The chart has no uninherited (red) timing point, so its BPM is undefined');
  }

  // ── lane count ──
  if (chart.mode === 3) {
    const cs = Number(chart.cs);
    if (!Number.isFinite(cs)) {
      problems.push('CircleSize is not a number, so the lane count is unknown');
    } else {
      const rounded = Math.round(cs);
      if (rounded < LIMITS.KEYS_MIN || rounded > LIMITS.KEYS_MAX) {
        problems.push(`CircleSize ${cs} gives ${rounded} lanes; Ashtonk!mania supports ${LIMITS.KEYS_MIN}–${LIMITS.KEYS_MAX}`);
      } else if (Math.abs(cs - rounded) > 0.01) {
        warnings.push(`CircleSize ${cs} is not a whole number; it rounds to ${rounded} lanes`);
      }
    }
  }

  // ── audio ──
  if (!chart.audioFilename) {
    problems.push('No audio file is specified in [General]');
  } else if (context.availableFiles && !context.availableFiles.has(chart.audioFilename.toLowerCase())) {
    problems.push(`Missing audio file: ${chart.audioFilename}`);
  }

  // ── background ──
  const bg = chart.events?.background?.file;
  if (bg && context.availableFiles && !context.availableFiles.has(bg.toLowerCase())) {
    warnings.push(`Missing background image: ${bg}`);
  }

  // ── things that parse but are suspicious ──
  if (chart.skipped?.hitObjects > 0) {
    warnings.push(`${chart.skipped.hitObjects} hit object line(s) were unreadable or out of range and were skipped`);
  }
  if (chart.skipped?.timingPoints > 0) {
    warnings.push(`${chart.skipped.timingPoints} timing point line(s) were unreadable or out of range and were skipped`);
  }
  if (chart.events?.storyboard) {
    warnings.push('The chart contains storyboard objects. ManiaFlow parses notes and timing only; storyboards are not rendered.');
  }
  if (chart.formatVersion < 5) {
    warnings.push(`Format v${chart.formatVersion}: every time has been shifted +24 ms, as osu! does for pre-v5 files`);
  }
  if (!chart.title && !chart.artist) {
    warnings.push('The chart has no title or artist metadata');
  }

  const degenerate = Array.isArray(chart.timingPoints)
    ? chart.timingPoints.filter((tp) => !(Math.abs(tp.beatLength) > 0)).length
    : 0;
  if (degenerate > 0) {
    warnings.push(`${degenerate} timing point(s) have a zero beat length. Ashtonk!mania keeps those lines but they carry no speed, so they are ignored here too.`);
  }

  const negativeEnds = Array.isArray(chart.hitObjects)
    ? chart.hitObjects.filter((o) => o.endTime < o.time).length
    : 0;
  if (negativeEnds > 0) warnings.push(`${negativeEnds} hold note(s) end before they start; they are treated as taps`);

  const red = chart.mode === 3 && chart.hitObjects?.length ? redTimingPoints(chart) : [];
  if (red.length > 1) {
    const bpms = red.map((tp) => 60000 / tp.beatLength);
    const spread = Math.max(...bpms) - Math.min(...bpms);
    if (spread > 0.01) warnings.push(`The BPM changes across the chart (${Math.round(Math.min(...bpms))}–${Math.round(Math.max(...bpms))})`);
  }

  return {
    problems,
    warnings,
    ok: problems.length === 0,
    severity: problems.length ? Severity.PROBLEM : warnings.length ? Severity.WARNING : null,
  };
}

/** Can this chart be laid out and previewed by ManiaFlow itself? */
export function isPreviewable(chart) {
  if (!chart || chart.mode !== 3) return false;
  if (!Array.isArray(chart.hitObjects) || !chart.hitObjects.length) return false;
  if (!Array.isArray(chart.timingPoints) || !chart.timingPoints.length) return false;
  try {
    keyCount(chart);
    return true;
  } catch {
    return false;
  }
}

/** A short, stable code for the most significant problem — used by the UI to branch. */
export function primaryIssue(chart) {
  const result = validateChart(chart);
  if (result.ok) return null;
  const first = result.problems[0];
  if (/mode 1|taiko/i.test(first)) return ErrorCode.CHART_UNSUPPORTED;
  if (/mode 2|catch/i.test(first)) return ErrorCode.CHART_UNSUPPORTED;
  if (/mode 0|standard/i.test(first)) return ErrorCode.CHART_UNSUPPORTED;
  if (/no hit objects/i.test(first)) return ErrorCode.CHART_EMPTY;
  return ErrorCode.CHART_INVALID;
}

export const ChartValidator = { validateChart, isPreviewable, primaryIssue, Severity };
