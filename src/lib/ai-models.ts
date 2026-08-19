/**
 * Canonical non-streaming Z.ai model registry. `as const` keeps the model type,
 * dropdown options, and frontend validation tied to exactly these four IDs.
 * Rust mirrors the list in `send_chat_by_name` and exercises it in contract
 * tests; no model declares or enables SSE support in v0.5.
 */
export const AI_MODELS = [
  { id: 'glm-4.5-air', label: 'GLM-4.5 Air' },
  { id: 'glm-4.7', label: 'GLM-4.7' },
  { id: 'glm-5-turbo', label: 'GLM-5 Turbo' },
  { id: 'glm-5.1', label: 'GLM-5.1' },
] as const;

export type RegisteredAiModel = (typeof AI_MODELS)[number]['id'];
export const DEFAULT_AI_MODEL: RegisteredAiModel = 'glm-4.5-air';
export const AI_MODEL_IDS = AI_MODELS.map((model) => model.id) as RegisteredAiModel[];

export function isValidAiModel(value: string): value is RegisteredAiModel {
  return (AI_MODEL_IDS as readonly string[]).includes(value);
}

export function aiModelLabel(id: string): string {
  return AI_MODELS.find((model) => model.id === id)?.label ?? id;
}

export function getAiModelOptions(): Array<{ label: string; value: RegisteredAiModel }> {
  return AI_MODELS.map((model) => ({ label: model.label, value: model.id }));
}
