import { invoke } from '@tauri-apps/api/core';
import { toRaw } from 'vue';
import type { ExportFormat } from './constants';
import type { ChecksumType, DataFrame } from '../types';

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

export async function calculateChecksum(data: ArrayLike<number>, algorithm: ChecksumType) {
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

/**
 * Serialize one DataFrame as a single JSONL line matching the Rust `DataFrame`
 * serde shape ({"id","direction","timestamp","data":[...]}). Used by the
 * capture-file export path so each frame crosses IPC as a small text append
 * (via append_log) instead of as a JSON object on the `frames` invoke argument.
 */
export function frameToJsonlLine(frame: DataFrame): string {
  return JSON.stringify({
    id: frame.id,
    direction: frame.direction,
    timestamp: frame.timestamp,
    data: Array.from(frame.data),
  });
}

/**
 * Capture-file export. `captureFile` is a JSONL temp file the caller has
 * already written (one DataFrame per line, via repeated invokeAppendLog). The
 * Rust side reads+parses it, avoiding serialization of up to 100k DataFrame
 * objects through the `invoke` argument. The wire shape is camelCase to match
 * the Rust `CaptureFileExportRequest` (`#[serde(rename_all = "camelCase")]`).
 */
export async function invokeExportDataFromCaptureFile(
  captureFile: string,
  format: ExportFormat,
  path: string,
) {
  return invoke<void>('export_data_from_capture_file', {
    request: { captureFile, format, path },
  });
}

/** Append a chunk of text to the auto-log file (created if missing). Stateless
 * on the Rust side; the caller serializes calls to preserve order. */
export async function invokeAppendLog(path: string, content: string) {
  return invoke<void>('append_log', { path, content });
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
