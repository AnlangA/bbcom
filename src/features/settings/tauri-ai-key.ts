import { invoke } from '@tauri-apps/api/core';
import type { AiKeyStatus } from '../../generated/ipc-contracts';

/** The only renderer-visible representation of an AI credential. */
export type { AiKeyStatus } from '../../generated/ipc-contracts';

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const candidate = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(candidate.__TAURI_INTERNALS__ || candidate.__TAURI__);
}

/**
 * Both webviews share an origin. The AI window's capability deliberately does
 * NOT grant `get_ai_key_status` (see the ai_window_capability test): its key
 * status arrives solely via the main-window authority bridge.
 */
export function isAiAssistantWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('window') === 'ai';
}

function missing(): AiKeyStatus {
  return { configured: false };
}

export async function getAiKeyStatus(): Promise<AiKeyStatus> {
  if (!isTauriRuntime()) return missing();
  return invoke<AiKeyStatus>('get_ai_key_status');
}

export async function setAiApiKey(value: string): Promise<AiKeyStatus> {
  if (!isTauriRuntime()) throw new Error('native AI key storage is unavailable');
  return invoke<AiKeyStatus>('set_ai_api_key', { request: { value } });
}

export async function clearAiApiKey(): Promise<void> {
  if (!isTauriRuntime()) throw new Error('native AI key storage is unavailable');
  await invoke<void>('clear_ai_api_key');
}
