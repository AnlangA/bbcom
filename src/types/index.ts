import type { ParserConfig } from '../lib/protocol-parser';

// Display and filter types
export type DisplayMode = 'HEX' | 'ASCII' | 'ANSI' | 'UTF8';
export type DirectionFilter = 'ALL' | 'TX' | 'RX';
export type Direction = 'TX' | 'RX';
export type SearchMode = 'TEXT' | 'HEX';
export type PacketViewMode = 'FRAME' | 'MERGED';
export type LineEnding = 'none' | 'CR' | 'LF' | 'CRLF';
export type AiModel = 'glm-5.1' | 'glm-5-turbo' | 'glm-4.7' | 'glm-4.5-air';
export type AiRole = 'user' | 'assistant';
export type LogAiContextMode = 'latest-10k' | 'latest-n-frames' | 'full-capped';

// Data frame
export interface DataFrame {
  id: string;
  direction: Direction;
  timestamp: number;
  data: Uint8Array;
}

// Serial port configuration
export interface PortConfig {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'odd' | 'even';
  flowControl: 'none' | 'software' | 'hardware';
  dtr: boolean;
  rts: boolean;
}

// Send history
export interface SendHistoryEntry {
  data: string;
  isHex: boolean;
}

export interface QuickCommand {
  id: string;
  name: string;
  data: string;
  isHex: boolean;
}

/** A single step of a sequenced macro. `delayMs` is waited AFTER this step's
 * payload is sent (the inter-step gap), matching CoolTerm's macro model. */
export interface MacroStep {
  data: string;
  isHex: boolean;
  /** Delay in ms applied after sending this step. 0 = no delay. */
  delayMs: number;
}

/** A named, ordered sequence of sends with inter-step delays — the
 * CoolTerm/TeraTerm "macro" pattern for scripted device bring-up (e.g. boot
 * commands with wait-for-boot gaps). Persisted per-session like quickCommands. */
export interface Macro {
  id: string;
  name: string;
  steps: MacroStep[];
}

/** Match mode for a scripted trigger: substring in decoded text, or a hex byte
 * sequence matched against raw RX bytes. */
export type TriggerMatchMode = 'text' | 'hex';

/** A scripted trigger: when `pattern` appears in the RX stream, automatically
 *  send `response`. Persisted per-session like macros/quickCommands. */
export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  matchMode: TriggerMatchMode;
  pattern: string;
  response: string;
  responseIsHex: boolean;
  /** Minimum ms between firings (anti-loop cooldown). */
  cooldownMs: number;
}

export type HighlightMatchMode = 'text' | 'hex';
export type HighlightColor = 'amber' | 'red' | 'blue' | 'green' | 'violet';

/** A terminal highlight rule. Matching is done against the decoded text search
 * index or continuous HEX search index, and can be scoped to TX/RX/all. */
export interface HighlightRule {
  id: string;
  name: string;
  enabled: boolean;
  matchMode: HighlightMatchMode;
  pattern: string;
  direction: DirectionFilter;
  color: HighlightColor;
}

export interface SessionParserState {
  config: ParserConfig;
  presetId: string | null;
}

// ---------------------------------------------------------------------------
// Modbus register model + master config.
//
// A register row is the user-facing unit in the register table. Its
// `functionCode` selects the FC family (read coil/input, read/write holding
// reg, …); the master composes wire requests from rows, automatically batching
// contiguous rows into multi-register/multi-coil requests (FC0F/FC10) and
// falling back to single requests (FC05/06) when a row is alone or discontiguous.
// `value` is dual-purpose: in READ mode it holds the latest decoded sample
// (runtime only — never persisted); in SEND mode it holds the value to write.
// ---------------------------------------------------------------------------

/** Register/coil value encoding. 32-bit types span two 16-bit registers. */
export type ModbusValueType = 'bool' | 'uint16' | 'int16' | 'uint32-be' | 'int32-be' | 'float32-be';

/**
 * Function-code family a row belongs to. Stored as the family's single-read or
 * single-write FC; the master picks the multiple variant (0F/10) when batching.
 * - 01 read coils (bit, ro)   02 read discrete inputs (bit, ro)
 * - 03 read holding regs (word, rw reads)   04 read input regs (word, ro)
 * - 05 write single coil (bit)   06 write single register (word)
 */
export type ModbusFunctionCode = 0x01 | 0x02 | 0x03 | 0x04 | 0x05 | 0x06;

/** Access class derived from the FC family — drives UI enablement. */
export type ModbusAccess = 'bit-ro' | 'bit-rw' | 'word-ro' | 'word-rw';

/** A register table row. Persisted per-session like triggers/highlights. */
export interface ModbusRegister {
  id: string;
  name: string;
  /** Slave address 1..247 (0 = broadcast for writes). */
  slaveAddress: number;
  functionCode: ModbusFunctionCode;
  /** Starting register/coil address 0..65535. */
  address: number;
  type: ModbusValueType;
  /** Physical unit label (°C, V, …) — cosmetic. */
  unit?: string;
  /** Waveform channel 0..7 this row plots, or null. */
  waveformChannel: number | null;
  /** READ: latest decoded value. SEND: value to write. Runtime-only. */
  value: number | null;
  valueTs: number | null;
  /**
   * Whether this row participates in periodic background reads. A row with a
   * read FC (01/02/03/04) and periodicRead=true is polled each tick. Defaults
   * to true for backward compatibility with pre-existing rows.
   */
  periodicRead: boolean;
  /**
   * Whether this row participates in periodic background writes. Only honored
   * for write FCs (05/06); each tick advances that row's value cursor in the
   * loaded write data source (`.bbreg`) and sends the next value. Defaults to
   * false so auto-writes never start without an explicit opt-in.
   */
  periodicWrite: boolean;
}

/** Per-session Modbus master settings. Persisted (minus row values). */
export interface ModbusMasterConfig {
  /** 'rtu' = addr+PDU+CRC; 'pdu' = raw PDU bytes (TCP-style gateway). */
  transport: 'rtu' | 'pdu';
  /** Master enabled. Gates both the read and write background loops. */
  enabled: boolean;
  /** Read poll interval in ms (100..10000). */
  pollIntervalMs: number;
  /** Write interval in ms (100..10000) — cadence for periodic writes. */
  writeIntervalMs: number;
  /** Per-request response timeout in ms. */
  timeoutMs: number;
}

/** How the waveform sources its samples: free-text RX parsing or Modbus regs. */
export type WaveformSourceMode = 'text' | 'register';

export interface AiChatMessage {
  id: string;
  role: AiRole;
  content: string;
  timestamp: number;
}

// Session
export interface SerialSession {
  id: string;
  portName: string;
  portConfig: PortConfig;
  isConnected: boolean;
  frames: DataFrame[];
  /** Frames received while capture is paused; flushed into `frames` on resume. */
  pausedFrames: DataFrame[];
  capturePaused: boolean;
  txBytes: number;
  rxBytes: number;
  txFrames: number;
  rxFrames: number;
  startTime: number | null;
  sendHistory: SendHistoryEntry[];
  sendDraft: string;
  quickCommands: QuickCommand[];
  macros: Macro[];
  triggers: Trigger[];
  highlights: HighlightRule[];
  parserState: SessionParserState;
  /** Modbus register table + master config. */
  modbusRegisters: ModbusRegister[];
  modbusConfig: ModbusMasterConfig;
  /** Waveform sample source: free-text RX parsing ('text') or registers ('register'). */
  waveformSourceMode: WaveformSourceMode;
  autoLogEnabled: boolean;
  /** Target file path for auto-logging, or null when disabled. Kept in sync
   * with autoLogEnabled via sessionStore.setAutoLogTarget. Runtime-only — not
   * persisted, since sessions themselves are not persisted across reloads. */
  logPath: string | null;
  terminalAiModel: AiModel;
  logAiModel: AiModel;
  logAiContextMode: LogAiContextMode;
  logAiFrameLimit: number;
  logAiMessages: AiChatMessage[];
}

// Checksum
export type ChecksumType = 'CHECKSUM' | 'CRC8' | 'CRC16' | 'CRC32';

// Limits
export const MAX_FRAMES = 10000;
export const MAX_HISTORY = 20;
export const MAX_INPUT_SIZE = 1024 * 1024; // 1MB
export const CACHE_SIZE = 5000;
