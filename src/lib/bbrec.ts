/**
 * `.bbrec` raw byte-stream record / replay.
 *
 * A capture file records the raw RX/TX byte chunks (with direction + a relative
 * timestamp) exactly as they arrived on the wire, so a session can be replayed
 * through the same frame pipeline later — for regression testing, demos, or
 * re-parsing a capture with a different protocol config.
 *
 * Format: JSONL (one {@link ByteRecord} per line), mirroring the `.bbreg`
 * Modbus-stream convention so the encode/parse helpers stay symmetric. This is
 * a text format (the byte payload is hex-encoded) for portability and
 * grep-ability; for very large captures the user would use the binary export
 * instead. A small magic header line identifies the file type + version.
 */

/** One captured byte chunk with direction and a relative timestamp (ms). */
export interface ByteRecord {
  /** 'rx' or 'tx'. */
  dir: 'rx' | 'tx';
  /** Monotonic offset from the capture start, in milliseconds. */
  t: number;
  /** Hex-encoded byte payload (uppercase, no separators) — survives UTF-8 round-trips. */
  hex: string;
}

/** File header identifying a `.bbrec` capture. */
export const BBREC_MAGIC = '#!bbrec-v1';

/**
 * Encode captured byte records into a `.bbrec` text file. The magic header
 * comes first, then one JSONL record per line.
 */
export function encodeBbrec(records: readonly ByteRecord[]): string {
  const lines = [BBREC_MAGIC];
  for (const r of records) {
    lines.push(JSON.stringify(r));
  }
  return lines.join('\n') + '\n';
}

/**
 * Parse a `.bbrec` text file back into records. The magic header is validated
 * and skipped; blank lines are ignored. Throws on a missing/mismatched header
 * so a caller can't silently import the wrong file type.
 */
export function parseBbrec(text: string): ByteRecord[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  if (lines[0] !== BBREC_MAGIC) {
    throw new Error(`Not a .bbrec file (missing magic header "${BBREC_MAGIC}")`);
  }
  const out: ByteRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const raw = JSON.parse(lines[i]) as unknown;
    if (!raw || typeof raw !== 'object' || !('dir' in raw) || !('t' in raw) || !('hex' in raw)) {
      throw new Error(`.bbrec line ${i + 1} is not a valid ByteRecord`);
    }
    const rec = raw as ByteRecord;
    if (rec.dir !== 'rx' && rec.dir !== 'tx') {
      throw new Error(`.bbrec line ${i + 1} has invalid dir "${rec.dir}"`);
    }
    if (typeof rec.t !== 'number' || !Number.isFinite(rec.t)) {
      throw new Error(`.bbrec line ${i + 1} has invalid timestamp`);
    }
    if (typeof rec.hex !== 'string') {
      throw new Error(`.bbrec line ${i + 1} has invalid hex`);
    }
    out.push({ dir: rec.dir, t: rec.t, hex: rec.hex });
  }
  return out;
}

/** Decode a hex string into a Uint8Array. Empty/odd-length hex → empty array. */
export function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(cleaned.length / 2));
  for (let i = 0; i + 1 < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

/** Encode a Uint8Array into an uppercase hex string (no separators). */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    s += bytes[i].toString(16).padStart(2, '0').toUpperCase();
  }
  return s;
}

export interface ReplayResult {
  /** All frames emitted across the replay (in arrival order). */
  frames: { data: Uint8Array; offset: number }[];
  /** Total bytes fed to the engine. */
  bytesFed: number;
  /** Number of records replayed. */
  records: number;
}

/**
 * Replay a parsed `.bbrec` capture through a {@link ProtocolEngine}, feeding the
 * RX chunks in timestamp order. TX records are skipped (they were sent, not
 * parsed). Returns the full set of frames the engine emitted. This is the
 * round-trip that proves a capture + engine reproduce the original framing.
 *
 * The caller may pass `engine` = null to just collect the RX bytes (used by the
 * record/replay unit test to verify byte-level fidelity before framing).
 */
export function replayBbrec(
  records: readonly ByteRecord[],
  engine: {
    feed(bytes: Uint8Array): { data: Uint8Array; offset: number }[];
  } | null,
): ReplayResult {
  const frames: { data: Uint8Array; offset: number }[] = [];
  let bytesFed = 0;
  let count = 0;
  for (const r of records) {
    if (r.dir !== 'rx') continue;
    count += 1;
    const bytes = hexToBytes(r.hex);
    bytesFed += bytes.length;
    if (engine) {
      const emitted = engine.feed(bytes);
      for (const f of emitted) frames.push(f);
    }
  }
  return { frames, bytesFed, records: count };
}
