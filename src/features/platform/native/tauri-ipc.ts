import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  AiRequestResult,
  AiRisk,
  AiWindowState,
  AppError,
  AutoLogAppendStats,
  AutoLogFormat,
  BeginAutoLogResponse,
  BeginExportResponse,
  ChecksumType,
  Direction,
  ExportAppendStats,
  ExportFinishStats,
  ExportFormat,
  ExportFramePayload,
  ExportSource,
  LogAiResponse,
  McumgrCommandResult,
  McumgrError,
  McumgrExecuteRequest,
  McumgrFilePick,
  McumgrFilePurpose,
  McumgrFirmwareUpdateRequest,
  McumgrFsDownloadRequest,
  McumgrFsDownloadResult,
  McumgrFsUploadRequest,
  McumgrImageUploadRequest,
  McumgrProgress,
  McumgrSavePick,
  RunAiRequest,
  SaveTargetGrant,
  SaveTargetPurpose,
  TerminalAiResponse,
} from '@/generated/ipc-contracts';
import { bytesToBase64 } from '@/lib/base64';
import { t } from '@/lib/i18n';

export type {
  AiRequestResult,
  AiRisk,
  AiWindowState,
  AppError,
  AutoLogAppendStats,
  AutoLogFormat,
  BeginAutoLogResponse,
  BeginExportResponse,
  ChecksumType,
  ExportAppendStats,
  ExportFinishStats,
  ExportFormat,
  ExportFramePayload,
  ExportSource,
  LogAiResponse,
  McumgrCommandResult,
  McumgrError,
  McumgrExecuteRequest,
  McumgrFilePick,
  McumgrFilePurpose,
  McumgrFsDownloadResult,
  McumgrProgress,
  McumgrSavePick,
  SaveTargetGrant,
  SaveTargetPurpose,
  TerminalAiResponse,
};

/**
 * Export/auto-log frame kept byte-backed up to the IPC boundary: `data` stays
 * the raw capture buffer and is widened to the base64 channel only inside the
 * typed invoke wrapper.
 */
export interface ExportFrameBytes {
  readonly id: string;
  readonly direction: Direction;
  readonly timestamp: number;
  readonly data: Uint8Array;
}

/** Canonical credential-free AI request generated from the Rust command DTO. */
export type AiRequest = RunAiRequest;

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
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  return invoke<{ result: string }>('calculate_checksum', {
    request: { data: [], dataB64: bytesToBase64(bytes), algorithm },
  });
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
  source?: ExportSource,
): Promise<BeginExportResponse> {
  // The source selector is omitted entirely (not `undefined`) when absent so
  // the renderer-memory request stays byte-compatible with the prior wire.
  const request: Record<string, unknown> = { format, token, expectedFrames, expectedRawBytes };
  if (source) request.source = source;
  return invoke<BeginExportResponse>('begin_export', { request });
}

export async function invokeAppendExportBatch(
  exportId: string,
  frames: readonly ExportFrameBytes[],
): Promise<ExportAppendStats> {
  return invoke<ExportAppendStats>('append_export_batch', {
    request: {
      exportId,
      frames: frames.map((frame) => ({
        id: frame.id,
        direction: frame.direction,
        timestamp: frame.timestamp,
        data: [],
        dataB64: bytesToBase64(frame.data),
      })),
    },
  });
}

export async function invokeFinishExport(exportId: string): Promise<ExportFinishStats> {
  return invoke<ExportFinishStats>('finish_export', { request: { exportId } });
}

export async function invokeAbortExport(exportId: string): Promise<void> {
  return invoke<void>('abort_export', { request: { exportId } });
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

/**
 * MCUmgr commands. The Rust side opens the serial port itself, so callers
 * must have yielded (closed) the frontend connection first. Progress-bearing
 * operations stream `McumgrProgress` over a channel.
 */
export async function invokeMcumgrExecute(
  request: McumgrExecuteRequest,
): Promise<McumgrCommandResult> {
  return invoke<McumgrCommandResult>('mcumgr_execute', { request });
}

export function createMcumgrProgressChannel(
  onProgress: (progress: McumgrProgress) => void,
): Channel<McumgrProgress> {
  const channel = new Channel<McumgrProgress>();
  channel.onmessage = onProgress;
  return channel;
}

export async function invokeMcumgrFirmwareUpdate(
  request: McumgrFirmwareUpdateRequest,
  onProgress: Channel<McumgrProgress>,
): Promise<McumgrCommandResult> {
  return invoke<McumgrCommandResult>('mcumgr_firmware_update', { request, onProgress });
}

export async function invokeMcumgrImageUpload(
  request: McumgrImageUploadRequest,
  onProgress: Channel<McumgrProgress>,
): Promise<McumgrCommandResult> {
  return invoke<McumgrCommandResult>('mcumgr_image_upload', { request, onProgress });
}

export async function invokeMcumgrFsUpload(
  request: McumgrFsUploadRequest,
  onProgress: Channel<McumgrProgress>,
): Promise<McumgrCommandResult> {
  return invoke<McumgrCommandResult>('mcumgr_fs_upload', { request, onProgress });
}

export async function invokeMcumgrFsDownload(
  request: McumgrFsDownloadRequest,
  onProgress: Channel<McumgrProgress>,
): Promise<McumgrFsDownloadResult> {
  return invoke<McumgrFsDownloadResult>('mcumgr_fs_download', { request, onProgress });
}

export async function invokeMcumgrCancel(): Promise<void> {
  return invoke<void>('mcumgr_cancel');
}

export async function invokeMcumgrPickFile(
  purpose: McumgrFilePurpose,
): Promise<McumgrFilePick | null> {
  return invoke<McumgrFilePick | null>('mcumgr_pick_file', { request: { purpose } });
}

export async function invokeMcumgrPickSaveTarget(
  suggestedName: string,
): Promise<McumgrSavePick | null> {
  return invoke<McumgrSavePick | null>('mcumgr_pick_save_target', {
    request: { suggestedName },
  });
}

const MCUMGR_ERROR_KINDS = new Set([
  'busy',
  'cancelled',
  'timeout',
  'port',
  'device',
  'protocol',
  'invalid-input',
  'io',
]);

/** Narrow an unknown rejected Tauri value to the MCUmgr error contract. */
export function asMcumgrError(error: unknown): McumgrError | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Partial<McumgrError>;
  if (typeof value.kind !== 'string' || !MCUMGR_ERROR_KINDS.has(value.kind)) return null;
  if (typeof value.message !== 'string') return null;
  return value as McumgrError;
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
