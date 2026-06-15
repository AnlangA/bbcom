/**
 * Protocol parser preset templates.
 *
 * Ready-made `ParserConfig`s for common serial protocols, so a user can pick
 * "Modbus RTU" or "NMEA0183" from a dropdown instead of hand-configuring a
 * delimiter/length template. Pure data + a name lookup; no UI deps.
 */
import type { ParserConfig } from './protocol-parser';

export interface ParserPreset {
  id: string;
  name: string;
  description: string;
  config: ParserConfig;
}

/**
 * NMEA0183: sentences start with '$' and end with CRLF, e.g.
 *   $GPGGA,092750.000,...*XX\r\n
 * The checksum (*XX) is part of the sentence, so we include the CRLF delimiter.
 */
const NMEA: ParserPreset = {
  id: 'nmea0183',
  name: 'NMEA 0183',
  description: 'GPS sentences: $...*CS terminated by CRLF',
  config: {
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: true,
  },
};

/**
 * AT command responses: lines terminated by CRLF. Matches most modem-style
 * traffic ("OK\r\n", "+CWLAP:...\r\n").
 */
const AT_RESPONSE: ParserPreset = {
  id: 'at-crlf',
  name: 'AT / modem (CRLF)',
  description: 'Text lines terminated by CR LF',
  config: {
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: false,
  },
};

/**
 * Plain LF-terminated text lines (Unix-style logs, printf debug output).
 */
const TEXT_LF: ParserPreset = {
  id: 'text-lf',
  name: 'Text line (LF)',
  description: 'Lines terminated by LF',
  config: {
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  },
};

/**
 * Modbus RTU frame: [Address(1)][Function(1)][Data(N)][CRC(2)]. The exact data
 * length is function-dependent, so we model it as a length-field frame where
 * the length isn't embedded — instead we use a small fixed minimum and rely on
 * the user tuning it. A pragmatic preset is a fixed 8-byte frame (common for
 * simple read responses), which the user can adjust.
 */
const MODBUS_FIXED_8: ParserPreset = {
  id: 'modbus-fixed-8',
  name: 'Modbus RTU (8B fixed)',
  description: 'Fixed 8-byte frames (tune for your function code)',
  config: {
    kind: 'fixed',
    frameSize: 8,
  },
};

/**
 * Length-prefixed binary: [Len(1)][Payload(Len)]. The length byte counts the
 * payload only, so lengthAdjust = 1 (the length byte itself).
 */
const LEN_PREFIX_1B: ParserPreset = {
  id: 'len-prefix-1b',
  name: 'Length-prefixed (1B)',
  description: '1-byte big-endian length prefix + payload',
  config: {
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 1,
    bigEndian: true,
    lengthAdjust: 1,
  },
};

/**
 * A 2-byte little-endian length prefix at offset 0 (common in some custom
 * binary protocols). lengthAdjust = 2 (the 2 length bytes).
 */
const LEN_PREFIX_2B_LE: ParserPreset = {
  id: 'len-prefix-2b-le',
  name: 'Length-prefixed (2B LE)',
  description: '2-byte little-endian length prefix + payload',
  config: {
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 2,
    bigEndian: false,
    lengthAdjust: 2,
  },
};

export const PARSER_PRESETS: ParserPreset[] = [
  AT_RESPONSE,
  TEXT_LF,
  NMEA,
  MODBUS_FIXED_8,
  LEN_PREFIX_1B,
  LEN_PREFIX_2B_LE,
];

/** Look up a preset by id, or null if unknown. */
export function findPreset(id: string): ParserPreset | null {
  for (const p of PARSER_PRESETS) {
    if (p.id === id) return p;
  }
  return null;
}
