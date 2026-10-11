/**
 * ChartRecord — the one shape a chart has inside ManiaFlow.
 *
 * A chart can arrive three ways: imported from a loose `.osu` file, extracted from an
 * `.osz` archive, or read from the game through the bridge. All three are normalised here
 * so the library, the preview, the Timing Lab and the session recorder are all looking at
 * the same object and none of them needs to know where it came from.
 *
 * Fields that ManiaFlow cannot determine are `null`, never a plausible-looking zero: the
 * star rating is the clearest example, since it belongs to the game's strain model.
 */

import { num, str, isPlainObject } from '../utils/validation.js';
import { analyse } from './ChartMetadata.js';
import { validateChart, isPreviewable } from './ChartValidator.js';
import { shortId } from '../utils/formatters.js';

export const ChartSource = Object.freeze({ LOCAL: 'local', ARCHIVE: 'archive', BRIDGE: 'bridge' });

/**
 * @param {object} input
 * @param {import('./ChartParser.js').ParsedChart} input.chart parsed chart
 * @param {import('./ChartParser.js').Note[]} input.notes normalised notes (with `byColumn`/`keys`)
 * @param {string} input.source one of ChartSource
 * @param {object} [input.record] a record read from the game, whose own fields win
 * @param {string} [input.fileName] where it came from, for display
 * @param {string|null} [input.audioUrl] object URL when an archive supplied audio
 * @param {Set<string>} [input.availableFiles] archive contents, for the missing-audio check
 */
export function buildChartRecord(input) {
  const chart = input?.chart;
  const notes = Array.isArray(input?.notes) ? input.notes : [];
  const source = Object.values(ChartSource).includes(input?.source) ? input.source : ChartSource.LOCAL;
  const fromGame = isPlainObject(input?.record) ? input.record : null;
  const analysis = notes.length || chart ? analyse(chart, notes) : null;
  const validation = chart ? validateChart(chart, { availableFiles: input?.availableFiles }) : { problems: ['No chart data'], warnings: [], ok: false };

  // The game's own figures win over ManiaFlow's recomputation: it has the audio, the real
  // star rating and the same normalised notes the player sees.
  const merge = (own, theirs) => (theirs == null ? own : theirs);

  const keys = merge(notes.keys ?? num(chart?.cs, 0), num(fromGame?.keys, Number.NaN) || null);
  const id = fromGame?.id || `local-${shortId(`${chart?.title ?? ''}|${chart?.version ?? ''}|${chart?.beatmapId ?? notes.length}`)}`;

  return {
    id,
    source,
    fileName: str(input?.fileName, null),
    hash: fromGame?.hash ?? null,
    setId: fromGame?.setId ?? (Number.isFinite(num(chart?.beatmapSetId, Number.NaN)) && chart.beatmapSetId > 0 ? chart.beatmapSetId : null),
    onlineId: fromGame?.onlineId ?? (chart?.beatmapId > 0 ? chart.beatmapId : null),

    title: merge(str(chart?.title, ''), fromGame?.title) || 'Unknown title',
    titleUnicode: merge(str(chart?.titleUnicode, ''), fromGame?.titleUnicode) || null,
    artist: merge(str(chart?.artist, ''), fromGame?.artist) || 'Unknown artist',
    artistUnicode: merge(str(chart?.artistUnicode, ''), fromGame?.artistUnicode) || null,
    creator: merge(str(chart?.creator, ''), fromGame?.creator) || 'Unknown',
    version: merge(str(chart?.version, ''), fromGame?.version) || 'Normal',
    sourceTag: str(chart?.source, ''),
    tags: Array.isArray(chart?.tags) ? chart.tags : [],

    mode: merge(num(chart?.mode, 3), num(fromGame?.mode, Number.NaN) || null),
    keys: Number.isFinite(+keys) ? +keys : 0,
    od: merge(num(chart?.od, 5), num(fromGame?.od, Number.NaN) || null),
    hp: merge(num(chart?.hp, 5), num(fromGame?.hp, Number.NaN) || null),

    bpm: merge(analysis?.bpm ?? null, num(fromGame?.bpm, Number.NaN) || null),
    bpmMin: merge(analysis?.bpmMin ?? null, num(fromGame?.bpmMin, Number.NaN) || null),
    bpmMax: merge(analysis?.bpmMax ?? null, num(fromGame?.bpmMax, Number.NaN) || null),
    length: merge(analysis?.length ?? null, num(fromGame?.length, Number.NaN) || null),
    drainLength: merge(analysis?.drainLength ?? null, num(fromGame?.drainLength, Number.NaN) || null),
    objectCount: merge(analysis?.objectCount ?? notes.length, num(fromGame?.objectCount, Number.NaN) || null),
    noteCount: merge(analysis?.noteCount ?? null, num(fromGame?.noteCount, Number.NaN) || null),
    lnCount: merge(analysis?.lnCount ?? null, num(fromGame?.lnCount, Number.NaN) || null),
    nps: merge(analysis?.nps ?? null, num(fromGame?.nps, Number.NaN) || null),
    // ManiaFlow's own measure, and labelled as such wherever it appears.
    peakNps: analysis?.peakNps ?? null,
    lnRatio: analysis?.lnRatio ?? null,
    // The game's strain-based rating. Never estimated here.
    stars: Number.isFinite(num(fromGame?.stars, Number.NaN)) && num(fromGame.stars) > 0 ? num(fromGame.stars) : null,

    previewTime: num(chart?.previewTime, -1),
    audioFilename: str(chart?.audioFilename, null),
    audioUrl: input?.audioUrl ?? null,
    backgroundFile: chart?.events?.background?.file ?? null,
    breaks: Array.isArray(chart?.events?.breaks) ? chart.events.breaks : [],
    formatVersion: num(chart?.formatVersion, null),

    problems: validation.problems,
    warnings: validation.warnings,
    previewable: isPreviewable(chart),
    valid: validation.ok,

    added: num(fromGame?.added, Date.now()),
    openedAt: null,

    // The parsed objects themselves, so a consumer never has to re-parse.
    chart: chart ?? null,
    notes,
    analysis,
  };
}

/** A stable display name for a record, honouring the unicode-metadata preference. */
export function displayName(record, preferUnicode = false) {
  if (!record) return 'Unknown chart';
  const title = (preferUnicode && record.titleUnicode) || record.title || 'Unknown title';
  const artist = (preferUnicode && record.artistUnicode) || record.artist || 'Unknown artist';
  return `${artist} — ${title}`;
}

/** `Artist — Title [Version]`, the form the library and the top bar use. */
export function displayFullName(record, preferUnicode = false) {
  if (!record) return 'Unknown chart';
  return `${displayName(record, preferUnicode)} [${record.version || 'Normal'}]`;
}

/** The lane→key mapping a record should start from: the game's defaults for its key count. */
export const DEFAULT_KEYBINDS = Object.freeze({
  1: [['Space']],
  2: [['KeyF'], ['KeyJ']],
  3: [['KeyF'], ['Space'], ['KeyJ']],
  4: [['KeyD'], ['KeyF'], ['KeyJ'], ['KeyK']],
  5: [['KeyD'], ['KeyF'], ['Space'], ['KeyJ'], ['KeyK']],
  6: [['KeyS'], ['KeyD'], ['KeyF'], ['KeyJ'], ['KeyK'], ['KeyL']],
  7: [['KeyS'], ['KeyD'], ['KeyF'], ['Space'], ['KeyJ'], ['KeyK'], ['KeyL']],
  8: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  9: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['Space'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  10: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyV'], ['KeyN'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  11: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyV'], ['Space'], ['KeyN'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  12: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyC'], ['KeyV'], ['KeyN'], ['KeyM'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  13: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyC'], ['KeyV'], ['Space'], ['KeyN'], ['KeyM'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  14: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyX'], ['KeyC'], ['KeyV'], ['KeyN'], ['KeyM'], ['Comma'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  15: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyX'], ['KeyC'], ['KeyV'], ['Space'], ['KeyN'], ['KeyM'], ['Comma'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  16: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyZ'], ['KeyX'], ['KeyC'], ['KeyV'], ['KeyN'], ['KeyM'], ['Comma'], ['Period'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  17: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyZ'], ['KeyX'], ['KeyC'], ['KeyV'], ['Space'], ['KeyN'], ['KeyM'], ['Comma'], ['Period'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
  18: [['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyG'], ['KeyZ'], ['KeyX'], ['KeyC'], ['KeyV'], ['KeyN'], ['KeyM'], ['Comma'], ['Period'], ['KeyH'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon']],
});

/**
 * The default lane→key mapping for a key count.
 * These are Ashtonk!mania's own `DEFAULT_KEYBINDS`, reproduced so an offline chart starts
 * from the same layout the game would use. When a bridge is connected the game's configured
 * keybinds are read instead, and these are only the fallback.
 */
export function defaultKeyMap(keys) {
  const count = Math.max(1, Math.min(18, Math.round(num(keys, 4))));
  const table = DEFAULT_KEYBINDS[count];
  if (table) return table.map((codes) => [...codes]);
  // Beyond the documented table: fall back to the 18K layout's first `count` lanes, which
  // is what the game does when a stored binding is missing.
  return DEFAULT_KEYBINDS[18].slice(0, count).map((codes) => [...codes]);
}
