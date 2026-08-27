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
  nameZh?: string;
  description: string;
  descriptionZh?: string;
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
  nameZh: 'NMEA 0183',
  description: 'GPS sentences: $...*CS terminated by CRLF',
  descriptionZh: 'GPS 语句：以 $ 开始，并由 CRLF 结束',
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
  nameZh: 'AT / 调制解调器（CRLF）',
  description: 'Text lines terminated by CR LF',
  descriptionZh: '按 CR LF 结束符拆分 AT 命令响应和文本行',
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
  nameZh: '文本行（LF）',
  description: 'Lines terminated by LF',
  descriptionZh: '按 LF 结束符拆分日志或普通文本行',
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
  nameZh: 'Modbus RTU（定长 8B）',
  description: 'Fixed 8-byte frames (tune for your function code)',
  descriptionZh: '每 8 字节拆分一帧，可按实际功能码调整',
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
  nameZh: '长度前缀（1B）',
  description: '1-byte big-endian length prefix + payload',
  descriptionZh: '1 字节大端长度前缀加负载',
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
  nameZh: '长度前缀（2B 小端）',
  description: '2-byte little-endian length prefix + payload',
  descriptionZh: '2 字节小端长度前缀加负载',
  config: {
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 2,
    bigEndian: false,
    lengthAdjust: 2,
  },
};

/**
 * SCPI instruments respond with LF-terminated lines, e.g.
 *   +1.23450000E+00\n
 * The same shape is also used by many multimeters / power supplies / DSOs.
 */
const SCPI_LF: ParserPreset = {
  id: 'scpi-lf',
  name: 'SCPI / instrument (LF)',
  nameZh: 'SCPI / 仪器（LF）',
  description: 'SCPI measurement lines terminated by LF',
  descriptionZh: '按 LF 拆分 SCPI 仪器测量响应',
  config: {
    kind: 'delimiter',
    delimiter: [0x0a],
    includeDelimiter: false,
  },
};

/**
 * NUL-delimited binary frames (0x00). Common in embedded debug links where a
 * text delimiter (CR/LF) could appear inside binary payloads.
 */
const NUL_DELIMITED: ParserPreset = {
  id: 'nul-delimited',
  name: 'NUL-delimited (0x00)',
  nameZh: 'NUL 分隔（0x00）',
  description: 'Binary frames terminated by a NUL byte',
  descriptionZh: '按 NUL 字节拆分二进制帧',
  config: {
    kind: 'delimiter',
    delimiter: [0x00],
    includeDelimiter: false,
  },
};

/**
 * A 2-byte big-endian length prefix at offset 0 — the common shape for many
 * TCP-style framing schemes reused over serial (lengthValue = payload length).
 */
const LEN_PREFIX_2B_BE: ParserPreset = {
  id: 'len-prefix-2b-be',
  name: 'Length-prefixed (2B BE)',
  nameZh: '长度前缀（2B 大端）',
  description: '2-byte big-endian length prefix + payload',
  descriptionZh: '2 字节大端长度前缀加负载',
  config: {
    kind: 'length',
    lengthOffset: 0,
    lengthSize: 2,
    bigEndian: true,
    lengthAdjust: 2,
  },
};

export const PARSER_PRESETS: ParserPreset[] = [
  AT_RESPONSE,
  TEXT_LF,
  SCPI_LF,
  NMEA,
  MODBUS_FIXED_8,
  LEN_PREFIX_1B,
  LEN_PREFIX_2B_BE,
  LEN_PREFIX_2B_LE,
  NUL_DELIMITED,
];

/** Look up a preset by id, or null if unknown. */
export function findPreset(id: string): ParserPreset | null {
  for (const p of PARSER_PRESETS) {
    if (p.id === id) return p;
  }
  return null;
}
