// Display and filter types
export type DisplayMode = 'HEX' | 'ASCII' | 'ANSI' | 'UTF8';
export type DirectionFilter = 'ALL' | 'TX' | 'RX';
export type Direction = 'TX' | 'RX';
export type SearchMode = 'TEXT' | 'HEX';
export type PacketViewMode = 'FRAME' | 'MERGED';
export type LineEnding = 'none' | 'CR' | 'LF' | 'CRLF';

// Data frame
export interface DataFrame {
  id: string;
  direction: Direction;
  timestamp: string;
  data: number[];
}

// Serial port configuration
export interface PortConfig {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'odd' | 'even';
  flowControl: 'none' | 'software' | 'hardware';
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

// Session
export interface SerialSession {
  id: string;
  portName: string;
  portConfig: PortConfig;
  isConnected: boolean;
  frames: DataFrame[];
  txBytes: number;
  rxBytes: number;
  txFrames: number;
  rxFrames: number;
  startTime: number | null;
  sendHistory: SendHistoryEntry[];
  quickCommands: QuickCommand[];
  autoLogEnabled: boolean;
}

// Checksum
export type ChecksumType = 'CHECKSUM' | 'CRC8' | 'CRC16' | 'CRC32';

// Limits
export const MAX_FRAMES = 10000;
export const MAX_HISTORY = 20;
export const MAX_INPUT_SIZE = 1024 * 1024; // 1MB
export const CACHE_SIZE = 2000;
