/**
 * AI model dispatch table (F13 / T3.8).
 *
 * The Rust side (`commands/ai/service.rs` `send_chat_by_name`) already uses a
 * `match` dispatch-table (not `Box<dyn Model>` — AP-2: `ModelName: Into<String>`
 * is not dyn-safe). This module is the frontend's mirror: the single source of
 * truth for which models exist, their display labels, and whether each supports
 * streaming (F14). The IPC layer validates model names against this table before
 * invoking the Rust command, so an unknown model is caught client-side.
 */

export interface AiModelEntry {
  /** The model identifier sent to Rust (matches the match arms in service.rs). */
  id: string;
  /** Human-readable label for the settings dropdown. */
  label: string;
  /** Whether this model supports SSE streaming output (F14). */
  streaming: boolean;
}

/**
 * The canonical model registry. Adding a model here AND in the Rust
 * `send_chat_by_name` match extends the AI pipeline. The `streaming` flag
 * drives whether the frontend uses the streaming IPC endpoint.
 */
export const AI_MODELS: readonly AiModelEntry[] = [
  { id: 'glm-4.5-air', label: 'GLM-4.5 Air', streaming: true },
  { id: 'glm-4.7', label: 'GLM-4.7', streaming: true },
  { id: 'glm-5-turbo', label: 'GLM-5 Turbo', streaming: true },
  { id: 'glm-5.1', label: 'GLM-5.1', streaming: true },
];

/** The default model (used when the user hasn't configured one). */
export const DEFAULT_AI_MODEL = 'glm-4.5-air';

/** All valid model IDs (for the AiModel type + validation). */
export const AI_MODEL_IDS: readonly string[] = AI_MODELS.map((m) => m.id);

/** True if `id` is a known model. */
export function isValidAiModel(id: string): boolean {
  return AI_MODEL_IDS.includes(id);
}

/** True if `id` supports SSE streaming output (F14). */
export function supportsStreaming(id: string): boolean {
  return AI_MODELS.find((m) => m.id === id)?.streaming ?? false;
}

/** Get the display label for a model, or the id itself if unknown. */
export function aiModelLabel(id: string): string {
  return AI_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Dropdown options for the model selector. */
export function aiModelOptions(): Array<{ label: string; value: string }> {
  return AI_MODELS.map((m) => ({ label: m.label, value: m.id }));
}
