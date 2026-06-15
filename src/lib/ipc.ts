import { invoke } from '@tauri-apps/api/core';
import { toRaw } from 'vue';
import type { ChecksumAlgorithm, ExportFormat } from './constants';
import type { DataFrame } from '../types';

export type AiRisk = 'safe' | 'caution' | 'dangerous';

export interface TerminalAiRequest {
  prompt: string;
  apiKey: string;
  model: string;
  enableCodingPlan: boolean;
  shell: string;
  context?: string;
}

export interface TerminalAiResponse {
  command: string;
  explanation: string;
  risk: AiRisk;
}

export interface AiWindowState {
  visible: boolean;
}

export interface AppCommandErrorDetails {
  message?: string;
  field?: string;
  format?: string;
  path?: string;
}

export async function calculateChecksum(data: ArrayLike<number>, algorithm: ChecksumAlgorithm) {
  return invoke<{ result: string }>('calculate_checksum', {
    request: { data: Array.from(data), algorithm },
  });
}

export async function invokeExportData(frames: DataFrame[], format: ExportFormat, path: string) {
  return invoke<void>('export_data', {
    // toRaw unwraps the reactive array proxy; frame elements are markRaw'd at
    // creation, so the Tauri serializer walks raw typed arrays instead of
    // recursing through per-byte proxies.
    request: { frames: toRaw(frames), format, path },
  });
}

export async function terminalAiAssist(request: TerminalAiRequest) {
  return invoke<TerminalAiResponse>('terminal_ai_assist', { request });
}

export async function getAiWindowState() {
  return invoke<AiWindowState>('get_ai_window_state');
}

export async function showAiWindow() {
  return invoke<void>('show_ai_window');
}

export async function hideAiWindow() {
  return invoke<void>('hide_ai_window');
}

export async function resizeAiWindow(width: number, height: number) {
  return invoke<void>('resize_ai_window', {
    request: { width, height },
  });
}

export async function startAiWindowDrag() {
  return invoke<void>('start_ai_window_drag');
}

export function getCommandErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return fallback;
  const record = error as Record<string, unknown>;
  const details = record.details as AppCommandErrorDetails | undefined;
  if (details?.message) return details.message;
  if (typeof record.message === 'string') return record.message;
  return fallback;
}
