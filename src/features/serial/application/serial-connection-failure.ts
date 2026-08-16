import type { IpcError, PortLeaseConflict } from '../../../generated/ipc-contracts';

export interface SerialConnectionFailure {
  readonly error: Readonly<IpcError>;
  readonly category:
    'port-in-use' | 'invalid-port' | 'device-missing' | 'permission-denied' | 'backend-failure';
  readonly conflict?: Readonly<PortLeaseConflict>;
}

export const SERIAL_OPEN_OPERATION = 'serial_open';

export function createConnectionFailure(
  code: Extract<
    IpcError['code'],
    'PORT_IN_USE' | 'INVALID_INPUT' | 'SERIAL_DISCONNECTED' | 'IO_PERMISSION_DENIED' | 'BUSY'
  >,
  messageKey: string,
  category: SerialConnectionFailure['category'],
  conflict?: Readonly<PortLeaseConflict>,
): SerialConnectionFailure {
  const ipcError = Object.freeze<IpcError>({
    code,
    messageKey,
    retryable: code === 'SERIAL_DISCONNECTED' || code === 'BUSY',
    operation: SERIAL_OPEN_OPERATION,
  });
  return Object.freeze({
    error: ipcError,
    category,
    ...(conflict ? { conflict: Object.freeze({ ...conflict }) } : {}),
  });
}

export function classifyOpenFailure(error: unknown): SerialConnectionFailure {
  const ipcCode =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  if (ipcCode === 'IO_PERMISSION_DENIED') {
    return createConnectionFailure(
      'IO_PERMISSION_DENIED',
      'error.io_permission_denied',
      'permission-denied',
    );
  }
  if (ipcCode === 'SERIAL_DISCONNECTED') {
    return createConnectionFailure(
      'SERIAL_DISCONNECTED',
      'error.serial_disconnected',
      'device-missing',
    );
  }
  if (ipcCode === 'INVALID_INPUT') {
    return createConnectionFailure('INVALID_INPUT', 'error.invalid_input', 'invalid-port');
  }
  const stableText = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const normalized = stableText.toLowerCase();
  if (/permission|access.?denied|eacces|eperm/.test(normalized)) {
    return createConnectionFailure(
      'IO_PERMISSION_DENIED',
      'error.io_permission_denied',
      'permission-denied',
    );
  }
  if (/not.?found|no such|disconnected|enoent|device.*missing/.test(normalized)) {
    return createConnectionFailure(
      'SERIAL_DISCONNECTED',
      'error.serial_disconnected',
      'device-missing',
    );
  }
  if (/invalid.*(?:port|path)|bad.*(?:port|path)|typeerror|dataerror/.test(normalized)) {
    return createConnectionFailure('INVALID_INPUT', 'error.invalid_input', 'invalid-port');
  }
  return createConnectionFailure('BUSY', 'error.busy', 'backend-failure');
}
