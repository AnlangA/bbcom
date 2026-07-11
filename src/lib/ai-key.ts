import { invoke } from '@tauri-apps/api/core';

/** The only renderer-visible representation of an AI credential. */
export interface AiKeyStatus {
  configured: boolean;
  durability: 'os' | 'session' | 'missing';
}

const LEGACY_STORAGE_KEY = 'bbcom-app-settings:ai-api-key';

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const candidate = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(candidate.__TAURI_INTERNALS__ || candidate.__TAURI__);
}

/**
 * Both webviews share an origin, so the floating AI window must never read a
 * pre-v0.5 plaintext localStorage key during startup.  The Rust command can
 * safely report key status to that window without exposing or migrating it.
 */
function isAiAssistantWindow(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('window') === 'ai';
}

function missing(): AiKeyStatus {
  return { configured: false, durability: 'missing' };
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

/**
 * One-time migration from the legacy localStorage entry. Rust also checks the
 * old `secure-settings.json` itself. Plaintext is removed only after Rust
 * confirms an OS-keyring read-back (`durability === 'os'`).
 */
export async function migrateLegacyAiApiKey(): Promise<AiKeyStatus> {
  if (!isTauriRuntime()) return missing();
  if (isAiAssistantWindow()) return getAiKeyStatus();
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)?.trim() ?? '';
  const status = await invoke<AiKeyStatus>('migrate_ai_api_key', {
    request: { value: legacy || undefined },
  });
  if (status.durability === 'os' && legacy) localStorage.removeItem(LEGACY_STORAGE_KEY);
  return status;
}

export const AI_KEY_LEGACY_STORAGE_KEY = LEGACY_STORAGE_KEY;

/** Explicit clearing may safely erase an old plaintext copy even offline. */
export function removeLegacyAiApiKey(): void {
  if (isAiAssistantWindow()) return;
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}
