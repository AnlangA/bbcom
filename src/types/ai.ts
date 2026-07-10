import type { RegisteredAiModel } from '../lib/ai-models';

/** Supported Z.ai chat models, derived from the canonical frontend registry. */
export type AiModel = RegisteredAiModel;

/** Role of a message in an AI chat thread. */
export type AiRole = 'user' | 'assistant';

/** How the log-AI assistant scopes the serial context it analyzes. */
export type LogAiContextMode = 'latest-10k' | 'latest-n-frames' | 'full-capped';

/** One message in the log-AI assistant's chat thread. */
export interface AiChatMessage {
  id: string;
  role: AiRole;
  content: string;
  timestamp: number;
}

/**
 * The only regular session payload allowed across the main/AI-window event
 * boundary. It deliberately excludes serial frames, API keys, and chat body.
 */
export interface AiSessionSummary {
  id: string;
  portName: string;
  baudRate: number;
  isConnected: boolean;
  txBytes: number;
  rxBytes: number;
  txFrames: number;
  rxFrames: number;
  terminalAiModel: AiModel;
  logAiModel: AiModel;
  logAiContextMode: LogAiContextMode;
  logAiFrameLimit: number;
}

/** A bounded, separately delivered chat state for the AI window UI. */
export interface AiChatSnapshot {
  sessionId: string;
  messages: AiChatMessage[];
}

/** On-demand, capped log context; never part of a regular session event. */
export interface AiLogContextSnapshot {
  sessionId: string;
  text: string;
  truncated: boolean;
  frameCount: number;
  charLimit: number;
}

/** Local composition used only inside the AI window. */
export type AiWindowSession = Omit<AiSessionSummary, 'baudRate'> & {
  /** Optional solely for compatibility with local test fixtures/old snapshots. */
  baudRate?: number;
  logAiMessages: AiChatMessage[];
};
