import type { ParserConfig } from '@/lib/protocol-parser';
import type { AiChatMessage, AiModel, LogAiContextMode } from '@/features/ai/domain/ai';
import type { Macro, Trigger, HighlightRule } from '@/features/send-panel/domain/macros';
import type { DataFrame, PortConfig, QuickCommand, SendHistoryEntry } from '@/features/serial/domain/serial';
import type { McumgrClientConfig } from '@/features/terminal/domain/mcumgr';
import type { ModbusMasterConfig, ModbusRegister } from '@/features/terminal/domain/modbus';
import type { SerialShellConfig } from '@/features/terminal/domain/serial-shell';
import type { WaveformSourceMode } from '@/features/terminal/domain/waveform';

/** Per-session parser state (config + active preset), persisted with the session. */
export interface SessionParserState {
  config: ParserConfig;
  presetId: string | null;
}

/** A complete serial session — the central domain aggregate persisted per tab. */
export interface SerialSession {
  id: string;
  /** Optional host-rendered tab name. The native serial path is never used as
   * a plugin-facing identity when this value is supplied. */
  displayName?: string;
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
  /** Interactive serial-console settings. Persisted in workspace send_json. */
  shellConfig: SerialShellConfig;
  /** First-class MCUMgr / SMP client settings. Persisted in mcumgr_config. */
  mcumgrConfig: McumgrClientConfig;
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
