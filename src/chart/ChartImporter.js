/**
 * ChartImporter — turns files the user drops into ChartRecords.
 *
 * Accepts `.osu` (a single difficulty) and `.osz` (a beatmap set, which is a ZIP holding
 * several difficulties plus the audio). Both go through the same parser and validator as a
 * chart read from the game, so the library cannot tell them apart by shape.
 *
 * Failure is reported per file rather than aborting the batch: dropping a folder with one
 * corrupt chart in it imports the rest and says what was wrong with that one. Nothing is
 * silently discarded — a file that produced no notes is listed with the reason.
 */

import { parseOsu, toNotes, keyCount, scrollSegments } from './ChartParser.js';
import { validateChart } from './ChartValidator.js';
import { buildChartRecord, ChartSource } from './ChartRecord.js';
import { readArchive, canInflate } from './OszReader.js';
import { ChartError, ErrorCode, toAppError } from '../utils/errors.js';
import { formatBytes, ellipsizeMiddle } from '../utils/formatters.js';

const OSU_EXT = /\.osu$/i;
const OSZ_EXT = /\.(osz|zip)$/i;
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|aac|flac)$/i;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const TEXT = new TextDecoder('utf-8');

/**
 * @param {FileList|File[]} files
 * @param {object} [options]
 * @param {(progress: {done:number,total:number,current:string}) => void} [options.onProgress]
 * @returns {Promise<{ records: object[], failures: Array<{name:string, reason:string, code:string}> }>}
 */
export async function importFiles(files, options = {}) {
  const list = Array.from(files || []);
  if (!list.length) return { records: [], failures: [] };

  const records = [];
  const failures = [];
  let done = 0;

  // An .osz carries its own audio; loose .osu files may be dropped alongside an audio file,
  // so the batch is scanned for audio first and matched by name afterwards.
  const looseAudio = new Map();
  for (const file of list) {
    if (AUDIO_EXT.test(file.name)) looseAudio.set(file.name.toLowerCase(), file);
  }

  for (const file of list) {
    options.onProgress?.({ done, total: list.length, current: file.name });
    try {
      if (OSZ_EXT.test(file.name)) {
        const imported = await importArchive(file, options);
        records.push(...imported.records);
        failures.push(...imported.failures);
      } else if (OSU_EXT.test(file.name)) {
        const audio = findAudioFor(file, looseAudio);
        const record = await importOsuFile(file, audio);
        records.push(record);
      } else if (AUDIO_EXT.test(file.name)) {
        // Audio on its own is not a chart; it is used by a .osu in the same batch.
        done++;
        continue;
      } else {
        failures.push({
          name: file.name,
          reason: `Unsupported file type. ManiaFlow reads .osu difficulties and .osz beatmap sets${canInflate() ? '' : ', and this browser cannot decompress archives'}.`,
          code: ErrorCode.CHART_UNSUPPORTED,
        });
      }
    } catch (err) {
      const error = toAppError(err);
      failures.push({ name: file.name, reason: error.message, code: error.code });
    }
    done++;
    options.onProgress?.({ done, total: list.length, current: null });
  }

  return { records, failures };
}

/** Parse one `.osu` file into a record. */
export async function importOsuFile(file, audioFile = null) {
  if (file.size > MAX_FILE_BYTES) {
    throw new ChartError(`${ellipsizeMiddle(file.name, 40)} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_FILE_BYTES)} limit`, {
      code: ErrorCode.CHART_INVALID,
    });
  }
  const text = await file.text();
  const chart = parseOsu(text);
  return recordFromChart(chart, {
    source: ChartSource.LOCAL,
    fileName: file.name,
    audioFile,
    sizeBytes: file.size,
  });
}

/** Open an `.osz` and produce one record per playable difficulty. */
export async function importArchive(file, options = {}) {
  if (!canInflate()) {
    throw new ChartError(
      'This browser cannot decompress archives (DecompressionStream is unavailable). Drop loose .osu files instead, or use a current Chrome, Edge, Firefox or Safari 16.4+.',
      { code: ErrorCode.CHART_UNSUPPORTED },
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ChartError(`${ellipsizeMiddle(file.name, 40)} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_FILE_BYTES)} limit`, {
      code: ErrorCode.CHART_INVALID,
    });
  }

  const buffer = await file.arrayBuffer();
  // One pass over the archive: it is inflated once and both the difficulties and the audio
  // are taken from the same result. Reading it twice would double the decompression work
  // for every set the user drops.
  const entries = await readArchive(buffer);
  const fileNames = new Set([...entries.keys()].map((name) => name.toLowerCase()));
  const charts = [...entries.entries()]
    .filter(([name]) => name.toLowerCase().endsWith('.osu'))
    .map(([name, bytes]) => ({ name, text: TEXT.decode(bytes) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!charts.length) {
    throw new ChartError('The archive contains no .osu difficulties', {
      code: ErrorCode.CHART_UNSUPPORTED, detail: { entries: entries.size },
    });
  }

  // One audio object URL per set, shared by every difficulty in it. The app revokes these
  // when a chart is dropped, so a long session does not accumulate blob URLs.
  const audioEntry = [...entries.keys()].find((name) => AUDIO_EXT.test(name));
  let audioUrl = null;
  if (audioEntry) {
    const bytes = entries.get(audioEntry);
    const type = /\.mp3$/i.test(audioEntry) ? 'audio/mpeg'
      : /\.ogg$/i.test(audioEntry) ? 'audio/ogg'
        : /\.wav$/i.test(audioEntry) ? 'audio/wav'
          : /\.(m4a|aac)$/i.test(audioEntry) ? 'audio/mp4'
            : /\.flac$/i.test(audioEntry) ? 'audio/flac' : 'audio/*';
    audioUrl = URL.createObjectURL(new Blob([bytes.slice()], { type }));
  }

  const records = [];
  const failures = [];
  for (const entry of charts) {
    try {
      const chart = parseOsu(entry.text);
      const record = recordFromChart(chart, {
        source: ChartSource.ARCHIVE,
        fileName: `${file.name} → ${entry.name}`,
        archiveName: file.name,
        availableFiles: fileNames,
        audioUrl,
      });
      records.push(record);
    } catch (err) {
      const error = toAppError(err);
      failures.push({ name: `${file.name} → ${entry.name}`, reason: error.message, code: error.code });
    }
  }
  return { records, failures, audioUrl };
}

/**
 * Build a record from a parsed chart, attaching audio when there is any.
 * A chart that cannot be previewed still becomes a record: the library shows it with the
 * reason, which is more useful than not showing it at all.
 */
export function recordFromChart(chart, options = {}) {
  let notes = [];
  try {
    notes = toNotes(chart, keyCount(chart));
  } catch {
    // The validation below explains why; an unsupported mode is not an exception worth throwing.
  }
  const record = buildChartRecord({
    chart,
    notes,
    source: options.source || ChartSource.LOCAL,
    fileName: options.fileName || null,
    audioUrl: options.audioUrl ?? null,
    availableFiles: options.availableFiles,
  });
  record.sizeBytes = options.sizeBytes ?? null;
  record.archiveName = options.archiveName ?? null;
  return record;
}

/**
 * Parse `.osu` text directly — used when a chart arrives from the bridge, from a paste, or
 * from a test fixture.
 */
export function importOsuText(text, { fileName = null, source = ChartSource.LOCAL } = {}) {
  const chart = parseOsu(text);
  let notes = [];
  try {
    notes = toNotes(chart, keyCount(chart));
  } catch { /* validation reports the reason */ }
  return buildChartRecord({ chart, notes, source, fileName });
}

/** Attach timing data a record needs to be previewed, without re-parsing. */
export function timingFor(record, { useSV = true, useBPM = true } = {}) {
  if (!record?.chart) {
    throw new ChartError('This chart has no parsed data, so it cannot be previewed', { code: ErrorCode.CHART_INVALID });
  }
  return scrollSegments(record.chart, { useSV, useBPM });
}

function findAudioFor(osuFile, looseAudio) {
  if (!looseAudio.size) return null;
  // Match by the AudioFilename in the file if it is in the batch, else by the set prefix.
  const prefix = osuFile.name.replace(OSU_EXT, '').toLowerCase();
  for (const [name, file] of looseAudio) {
    if (name.startsWith(prefix) || prefix.startsWith(name.replace(AUDIO_EXT, ''))) return file;
  }
  return null;
}

/** Report a validation result as one line, for the import summary. */
export function describeValidation(record) {
  const validation = record?.chart ? validateChart(record.chart) : { problems: record?.problems ?? [], warnings: record?.warnings ?? [], ok: true };
  if (validation.problems.length) return { level: 'problem', text: validation.problems[0] };
  if (validation.warnings.length) return { level: 'warning', text: validation.warnings[0] };
  return { level: 'ok', text: 'Parsed without problems' };
}

export const ChartImporter = { importFiles, importOsuFile, importArchive, importOsuText, recordFromChart, timingFor, describeValidation };
