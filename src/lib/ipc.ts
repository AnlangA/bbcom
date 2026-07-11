import { invoke } from '@tauri-apps/api/core';
import type { ExportFormat } from './constants';
import type { AiModel, AppError, ChecksumType, DataFrame } from '../types';
import { t } from './i18n';

export type AiRisk = 'safe' | 'caution' | 'dangerous';

export interface TerminalAiRequest {
  requestId: string;
  kind: 'terminal';
  prompt: string;
  model: AiModel;
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

export interface LogAiRequest {
  requestId: string;
  kind: 'log';
  prompt: string;
  model: AiModel;
  context: string;
  contextMode?: string;
  sessionMeta?: string;
}

export type AiRequest = TerminalAiRequest | LogAiRequest;

export type AiRequestResult =
  ({ kind: 'terminal' } & TerminalAiResponse) | ({ kind: 'log' } & LogAiResponse);

export interface LogAiResponse {
  answer: string;
  evidence: string[];
  suggestions: string[];
  truncated: boolean;
}

export interface AppCommandErrorDetails {
  message?: string;
  field?: string;
  format?: string;
  path?: string;
}

/** Narrow an unknown rejected Tauri value to the v0.5 error contract. */
export function asAppError(error: unknown): AppError | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Partial<AppError>;
  if (
    typeof value.code !== 'string' ||
    typeof value.messageKey !== 'string' ||
    typeof value.retryable !== 'boolean' ||
    typeof value.operation !== 'string'
  ) {
    return null;
  }
  return value as AppError;
}

export async function calculateChecksum(data: ArrayLike<number>, algorithm: ChecksumType) {
  return invoke<{ result: string }>('calculate_checksum', {
    request: { data: Array.from(data), algorithm },
  });
}

export type ExportFramePayload = Omit<DataFrame, 'data'> & { data: number[] };

export interface BeginExportResponse {
  exportId: string;
}

export interface ExportAppendStats {
  totalFrames: number;
  totalRawBytes: number;
}

export interface ExportFinishStats {
  frames: number;
  rawBytes: number;
  outputBytes: number;
  durationMs: number;
}

export type SaveTargetPurpose =
  'export-txt-hex' | 'export-txt-ascii' | 'export-csv' | 'export-jsonl' | 'export-bin' | 'auto-log';

export interface SaveTargetGrant {
  token: string;
  displayName: string;
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

export async function invokeBeginExport(
  format: ExportFormat,
  token: string,
  expectedFrames: number,
  expectedRawBytes: number,
): Promise<BeginExportResponse> {
  return invoke<BeginExportResponse>('begin_export', {
    request: { format, token, expectedFrames, expectedRawBytes },
  });
}

export async function invokeAppendExportBatch(
  exportId: string,
  frames: ExportFramePayload[],
): Promise<ExportAppendStats> {
  return invoke<ExportAppendStats>('append_export_batch', { request: { exportId, frames } });
}

export async function invokeFinishExport(exportId: string): Promise<ExportFinishStats> {
  return invoke<ExportFinishStats>('finish_export', { request: { exportId } });
}

export async function invokeAbortExport(exportId: string): Promise<void> {
  return invoke<void>('abort_export', { request: { exportId } });
}

export type AutoLogFormat = 'hex' | 'text';

export interface BeginAutoLogResponse {
  logId: string;
}

export interface AutoLogAppendStats {
  frames: number;
  rawBytes: number;
}

export async function invokeBeginAutoLog(
  token: string,
  format: AutoLogFormat,
): Promise<BeginAutoLogResponse> {
  return invoke<BeginAutoLogResponse>('begin_auto_log', { request: { token, format } });
}

export async function invokeAppendAutoLogBatch(
  logId: string,
  frames: ExportFramePayload[],
): Promise<AutoLogAppendStats> {
  return invoke<AutoLogAppendStats>('append_auto_log_batch', { request: { logId, frames } });
}

export async function invokeFinishAutoLog(logId: string): Promise<void> {
  return invoke<void>('finish_auto_log', { request: { logId } });
}

export async function invokeAbortAutoLog(logId: string): Promise<void> {
  return invoke<void>('abort_auto_log', { request: { logId } });
}

/** The Rust process owns and retrieves the API key; this DTO contains none. */
export async function runAiRequest(request: AiRequest): Promise<AiRequestResult> {
  return invoke<AiRequestResult>('run_ai_request', { request });
}

export async function cancelAiRequest(requestId: string): Promise<void> {
  return invoke<void>('cancel_ai_request', { request: { requestId } });
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
  const appError = asAppError(error);
  const code = appError?.code ?? (typeof record.code === 'string' ? record.code : undefined);
  if (code) {
    const key = COMMAND_ERROR_KEYS[code];
    return key ? t(key) : fallback;
  }
  const details = record.details as AppCommandErrorDetails | undefined;
  if (details?.message) return details.message;
  if (typeof record.message === 'string') return record.message;
  return fallback;
}

const COMMAND_ERROR_KEYS: Readonly<Record<string, string>> = {
  BUSY: 'error.busy',
  RATE_LIMITED: 'error.rate_limited',
  CANCELLED: 'error.cancelled',
  TIMEOUT: 'error.timeout',
  INVALID_INPUT: 'error.invalid_input',
  LIMIT_EXCEEDED: 'error.limit_exceeded',
  SECURITY_DENIED: 'error.security_denied',
  SERIAL_DISCONNECTED: 'error.serial_disconnected',
  SERIAL_QUEUE_FULL: 'error.serial_queue_full',
  SERIAL_PARTIAL_WRITE: 'error.serial_partial_write',
  IO_PERMISSION_DENIED: 'error.io_permission_denied',
  IO_DISK_FULL: 'error.io_disk_full',
  EXPORT_REPLACE_FAILED: 'error.export_failed',
};
