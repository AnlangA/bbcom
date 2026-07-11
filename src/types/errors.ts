/** Stable error codes shared by every Rust-to-WebView command boundary. */
export type AppErrorCode =
  | 'BUSY'
  | 'RATE_LIMITED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'INVALID_INPUT'
  | 'LIMIT_EXCEEDED'
  | 'SECURITY_DENIED'
  | 'SERIAL_DISCONNECTED'
  | 'SERIAL_QUEUE_FULL'
  | 'SERIAL_PARTIAL_WRITE'
  | 'IO_PERMISSION_DENIED'
  | 'IO_DISK_FULL'
  | 'EXPORT_REPLACE_FAILED';

/**
 * Structured, non-sensitive IPC failure. Rust deliberately never includes
 * serial bytes, AI prompts/responses, keys, or filesystem paths in this DTO.
 */
export interface AppError {
  code: AppErrorCode;
  messageKey: string;
  retryable: boolean;
  operation: string;
  requestId?: string;
  field?: string;
  limit?: number;
  actual?: number;
  retryAfterMs?: number;
}
