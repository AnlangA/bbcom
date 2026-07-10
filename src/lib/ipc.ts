import { invoke } from '@tauri-apps/api/core';
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

export type ExportFramePayload = Omit<DataFrame, 'data'> & { data: number[] };

export type SaveTargetPurpose =
  'export-txt-hex' | 'export-txt-ascii' | 'export-csv' | 'export-jsonl' | 'export-bin' | 'auto-log';

export interface SaveTargetGrant {
  token: string;
  displayPath: string;
}

export async function requestSaveTarget(
  purpose: SaveTargetPurpose,
  suggestedName: string,
): Promise<SaveTargetGrant | null> {
  return invoke<SaveTargetGrant | null>('request_save_target', {
    request: { purpose, suggestedName },
  });
}

export async function revokeFileGrant(token: string): Promise<void> {
  return invoke<void>('revoke_file_grant', { request: { token } });
}

export async function invokeBeginExport(format: ExportFormat, token: string): Promise<string> {
  return invoke<string>('begin_export', { request: { format, token } });
}

export async function invokeAppendExportBatch(
  exportId: string,
  frames: ExportFramePayload[],
): Promise<void> {
  return invoke<void>('append_export_batch', { request: { exportId, frames } });
}

export async function invokeFinishExport(exportId: string): Promise<void> {
  return invoke<void>('finish_export', { request: { exportId } });
}

export async function invokeAbortExport(exportId: string): Promise<void> {
  return invoke<void>('abort_export', { request: { exportId } });
}

/** Append text through a backend-issued auto-log grant. The filesystem path
 * never crosses this command boundary. */
export async function invokeAppendLog(token: string, content: string) {
  return invoke<void>('append_log', { request: { token, content } });
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
