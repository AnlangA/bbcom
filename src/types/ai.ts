/** Supported Z.ai chat models (mirrors the Rust dispatch table in commands/ai). */
export type AiModel = 'glm-5.1' | 'glm-5-turbo' | 'glm-4.7' | 'glm-4.5-air';

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
