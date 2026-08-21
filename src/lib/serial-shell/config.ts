import type {
  SerialShellBackspace,
  SerialShellConfig,
  SerialShellEncoding,
  SerialShellInputMode,
  SerialShellNewline,
  SerialShellRxNewline,
} from '../../types/serial-shell';

export const SERIAL_SHELL_HISTORY_LIMIT = 100;
export const SERIAL_SHELL_HISTORY_ENTRY_MAX_CHARS = 1_024;

export const DEFAULT_SERIAL_SHELL_CONFIG: SerialShellConfig = {
  inputMode: 'line',
  localEcho: true,
  txNewline: 'crlf',
  rxNewline: 'auto',
  encoding: 'utf-8',
  backspace: 'bs',
  showTimestamp: false,
  history: [],
};

const INPUT_MODES = new Set<SerialShellInputMode>(['line', 'char']);
const NEWLINES = new Set<SerialShellNewline>(['none', 'cr', 'lf', 'crlf']);
const RX_NEWLINES = new Set<SerialShellRxNewline>(['none', 'cr', 'lf', 'crlf', 'auto']);
const ENCODINGS = new Set<SerialShellEncoding>(['utf-8', 'gbk', 'latin1']);
const BACKSPACES = new Set<SerialShellBackspace>(['bs', 'del']);

function pick<T>(raw: unknown, allowed: ReadonlySet<T>, fallback: T): T {
  return allowed.has(raw as T) ? (raw as T) : fallback;
}

export function normalizeShellHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const history: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trimEnd();
    if (trimmed.length === 0) continue;
    history.push(trimmed.slice(0, SERIAL_SHELL_HISTORY_ENTRY_MAX_CHARS));
    if (history.length >= SERIAL_SHELL_HISTORY_LIMIT) break;
  }
  return history;
}

export function pushShellHistory(history: readonly string[], line: string): string[] {
  const next = line.trimEnd().slice(0, SERIAL_SHELL_HISTORY_ENTRY_MAX_CHARS);
  if (next.length === 0) return [...history];
  const withoutDup = history.filter((item) => item !== next);
  withoutDup.push(next);
  return withoutDup.slice(-SERIAL_SHELL_HISTORY_LIMIT);
}

export function cloneSerialShellConfig(config: SerialShellConfig): SerialShellConfig {
  return {
    inputMode: pick(config.inputMode, INPUT_MODES, DEFAULT_SERIAL_SHELL_CONFIG.inputMode),
    localEcho: config.localEcho === true,
    txNewline: pick(config.txNewline, NEWLINES, DEFAULT_SERIAL_SHELL_CONFIG.txNewline),
    rxNewline: pick(config.rxNewline, RX_NEWLINES, DEFAULT_SERIAL_SHELL_CONFIG.rxNewline),
    encoding: pick(config.encoding, ENCODINGS, DEFAULT_SERIAL_SHELL_CONFIG.encoding),
    backspace: pick(config.backspace, BACKSPACES, DEFAULT_SERIAL_SHELL_CONFIG.backspace),
    showTimestamp: config.showTimestamp === true,
    history: normalizeShellHistory(config.history),
  };
}

export function normalizeSerialShellConfig(raw: unknown): SerialShellConfig {
  if (!raw || typeof raw !== 'object') return cloneSerialShellConfig(DEFAULT_SERIAL_SHELL_CONFIG);
  const value = raw as Partial<SerialShellConfig>;
  return cloneSerialShellConfig({
    inputMode: value.inputMode ?? DEFAULT_SERIAL_SHELL_CONFIG.inputMode,
    localEcho: value.localEcho === true,
    txNewline: value.txNewline ?? DEFAULT_SERIAL_SHELL_CONFIG.txNewline,
    rxNewline: value.rxNewline ?? DEFAULT_SERIAL_SHELL_CONFIG.rxNewline,
    encoding: value.encoding ?? DEFAULT_SERIAL_SHELL_CONFIG.encoding,
    backspace: value.backspace ?? DEFAULT_SERIAL_SHELL_CONFIG.backspace,
    showTimestamp: value.showTimestamp === true,
    history: Array.isArray(value.history) ? value.history : [],
  });
}
