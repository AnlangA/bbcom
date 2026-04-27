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
  txBytes: number;
  rxBytes: number;
  txFrames: number;
  rxFrames: number;
  startTime: number | null;
  sendHistory: SendHistoryEntry[];
  sendDraft: string;
  quickCommands: QuickCommand[];
  autoLogEnabled: boolean;
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
export const CACHE_SIZE = 2000;
