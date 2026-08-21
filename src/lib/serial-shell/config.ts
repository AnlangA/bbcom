import type {
  SerialShellBackspace,
  SerialShellConfig,
  SerialShellEncoding,
  SerialShellNewline,
  SerialShellRxNewline,
} from '../../types/serial-shell';

/**
 * Defaults match a conventional terminal emulator (PuTTY/minicom): the device
 * echoes what it receives, and Enter transmits a bare CR.
 */
export const DEFAULT_SERIAL_SHELL_CONFIG: SerialShellConfig = {
  localEcho: false,
  txNewline: 'cr',
  rxNewline: 'auto',
  encoding: 'utf-8',
  backspace: 'bs',
};

const NEWLINES = new Set<SerialShellNewline>(['none', 'cr', 'lf', 'crlf']);
const RX_NEWLINES = new Set<SerialShellRxNewline>(['none', 'cr', 'lf', 'crlf', 'auto']);
const ENCODINGS = new Set<SerialShellEncoding>(['utf-8', 'gbk', 'latin1']);
const BACKSPACES = new Set<SerialShellBackspace>(['bs', 'del']);

function pick<T>(raw: unknown, allowed: ReadonlySet<T>, fallback: T): T {
  return allowed.has(raw as T) ? (raw as T) : fallback;
}

export function cloneSerialShellConfig(config: SerialShellConfig): SerialShellConfig {
  return {
    localEcho: config.localEcho === true,
    txNewline: pick(config.txNewline, NEWLINES, DEFAULT_SERIAL_SHELL_CONFIG.txNewline),
    rxNewline: pick(config.rxNewline, RX_NEWLINES, DEFAULT_SERIAL_SHELL_CONFIG.rxNewline),
    encoding: pick(config.encoding, ENCODINGS, DEFAULT_SERIAL_SHELL_CONFIG.encoding),
    backspace: pick(config.backspace, BACKSPACES, DEFAULT_SERIAL_SHELL_CONFIG.backspace),
  };
}

/**
 * Lenient loader for persisted configs. Unknown fields (including the legacy
 * `inputMode`/`showTimestamp`/`history` of the pre-terminal shell) are
 * silently dropped.
 */
export function normalizeSerialShellConfig(raw: unknown): SerialShellConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SERIAL_SHELL_CONFIG };
  const value = raw as Partial<SerialShellConfig>;
  return cloneSerialShellConfig({
    localEcho: value.localEcho === true,
    txNewline: value.txNewline ?? DEFAULT_SERIAL_SHELL_CONFIG.txNewline,
    rxNewline: value.rxNewline ?? DEFAULT_SERIAL_SHELL_CONFIG.rxNewline,
    encoding: value.encoding ?? DEFAULT_SERIAL_SHELL_CONFIG.encoding,
    backspace: value.backspace ?? DEFAULT_SERIAL_SHELL_CONFIG.backspace,
  });
}
