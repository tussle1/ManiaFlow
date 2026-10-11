/**
 * OszReader — opens `.osz` / `.osk` archives, which are ZIP containers.
 *
 * Ashtonk!mania imports beatmaps as `.osz`, so ManiaFlow has to be able to read one too or
 * its library would only ever hold loose `.osu` files. Inflation uses the platform's own
 * `DecompressionStream('deflate-raw')` — present in Chrome 103+, Firefox 113+, Safari 16.4+
 * and Node 18+ — so there is no dependency and no hand-written inflate to get wrong.
 * Where it is missing, `readArchive` rejects with a message that says exactly that.
 *
 * Encrypted entries, ZIP64 and spanned archives are detected and reported rather than
 * silently half-read.
 */

import { ChartError, ErrorCode } from '../utils/errors.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;

const textDecoder = new TextDecoder('utf-8');

/** True when this runtime can inflate raw deflate streams. */
export function canInflate() {
  return typeof DecompressionStream === 'function';
}

/**
 * Read a ZIP archive.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<Map<string, Uint8Array>>} filename (lower-cased key kept separately by callers) → bytes
 */
export async function readArchive(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 22) throw new ChartError('The file is too small to be an archive', { code: ErrorCode.CHART_INVALID });

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.length);
  if (eocd < 0) {
    throw new ChartError('Not a ZIP archive: no end-of-central-directory record', { code: ErrorCode.CHART_UNSUPPORTED });
  }
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === EOCD64_LOCATOR_SIG) {
    throw new ChartError('ZIP64 archives are not supported', { code: ErrorCode.CHART_UNSUPPORTED });
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff) throw new ChartError('ZIP64 archives are not supported', { code: ErrorCode.CHART_UNSUPPORTED });

  const files = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIG) {
      throw new ChartError(`The central directory is corrupt at entry ${i + 1}`, { code: ErrorCode.CHART_INVALID });
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const next = offset + 46 + nameLength + extraLength + commentLength;

    // A directory entry ends in `/` and carries no data.
    if (!name.endsWith('/')) {
      if (flags & 0x1) {
        throw new ChartError(`"${name}" is encrypted; encrypted archives are not supported`, { code: ErrorCode.CHART_UNSUPPORTED });
      }
      const payload = await readEntry(bytes, view, localOffset, method, compressedSize, uncompressedSize, name);
      files.set(name, payload);
    }
    offset = next;
  }
  return files;
}

async function readEntry(bytes, view, localOffset, method, compressedSize, uncompressedSize, name) {
  if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
    throw new ChartError(`The local header for "${name}" is missing or corrupt`, { code: ErrorCode.CHART_INVALID });
  }
  // The local header carries its own name and extra-field lengths, which do not have to
  // match the central directory's. Reading the data at the central directory's guess is
  // the classic way to get garbage out of a valid archive.
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > bytes.length) {
    throw new ChartError(`"${name}" is truncated: the archive ends before its data does`, { code: ErrorCode.CHART_INVALID });
  }
  const raw = bytes.subarray(dataStart, dataEnd);

  if (method === 0) return new Uint8Array(raw);
  if (method !== 8) {
    throw new ChartError(`"${name}" uses compression method ${method}, which ManiaFlow does not support`, { code: ErrorCode.CHART_UNSUPPORTED });
  }
  if (compressedSize === 0 && uncompressedSize === 0) return new Uint8Array(0);
  if (!canInflate()) {
    throw new ChartError(
      'This browser cannot decompress archives (DecompressionStream is unavailable). Import loose .osu files instead.',
      { code: ErrorCode.CHART_UNSUPPORTED },
    );
  }
  return inflateRaw(raw, uncompressedSize, name);
}

async function inflateRaw(raw, expectedSize, name) {
  try {
    const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (err) {
    throw new ChartError(
      `"${name}" could not be decompressed${expectedSize ? ` (expected ${expectedSize} bytes)` : ''}: ${err.message}`,
      { code: ErrorCode.CHART_INVALID, cause: err },
    );
  }
}

function findEocd(view, length) {
  // The EOCD is at least 22 bytes and may be followed by a comment of up to 65 535 bytes.
  const earliest = Math.max(0, length - 22 - 0xffff);
  for (let offset = length - 22; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIG) return offset;
  }
  return -1;
}

/**
 * Open an `.osz` and pull out what ManiaFlow needs: every `.osu` difficulty as text, plus
 * the names of the files that came with it (so a missing-audio check is possible).
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{ charts: Array<{name: string, text: string}>, fileNames: Set<string>, audio: string[] }>}
 */
export async function readOsz(data) {
  const files = await readArchive(data);
  const fileNames = new Set([...files.keys()].map((name) => name.toLowerCase()));
  const charts = [];
  const audio = [];

  for (const [name, bytes] of files) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.osu')) {
      charts.push({ name, text: textDecoder.decode(bytes) });
    } else if (/\.(mp3|ogg|wav|m4a|aac|flac)$/.test(lower)) {
      audio.push(name);
    }
  }

  if (!charts.length) {
    throw new ChartError('The archive contains no .osu difficulties', {
      code: ErrorCode.CHART_UNSUPPORTED,
      detail: { entries: files.size },
    });
  }
  // Stable order, matching how song select lists a set.
  charts.sort((a, b) => a.name.localeCompare(b.name));
  return { charts, fileNames, audio };
}

export const OszReader = { readArchive, readOsz, canInflate };
