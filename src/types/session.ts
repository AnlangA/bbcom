import type { ParserConfig } from '../lib/protocol-parser';
import type { DataFrame, PortConfig, SendHistoryEntry, QuickCommand } from './serial';
import type { Macro, Trigger, HighlightRule } from './macros';
import type { ModbusRegister, ModbusMasterConfig } from './modbus';
import type { WaveformSourceMode } from './waveform';
import type { AiModel, LogAiContextMode, AiChatMessage } from './ai';

/** Per-session parser state (config + active preset), persisted with the session. */
export interface SessionParserState {
  config: ParserConfig;
  presetId: string | null;
}

/** A complete serial session — the central domain aggregate persisted per tab. */
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
  /** Cumulative RX bytes dropped to SerialRxQueue overflow this connection.
   *  Runtime-only — never persisted (sessions are not persisted across reloads). */
  droppedBytes: number;
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
  /** Display-only target file name for auto-logging, or null when disabled.
   * The full native path never enters the WebView. Kept in sync with
   * autoLogEnabled via sessionStore.setAutoLogTarget. Runtime-only. */
  logPath: string | null;
  terminalAiModel: AiModel;
  logAiModel: AiModel;
  logAiContextMode: LogAiContextMode;
  logAiFrameLimit: number;
  logAiMessages: AiChatMessage[];
}
