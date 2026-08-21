/** Per-session interactive serial-console settings. Persisted in send_json. */

export type SerialShellInputMode = 'line' | 'char';
export type SerialShellNewline = 'none' | 'cr' | 'lf' | 'crlf';
export type SerialShellRxNewline = SerialShellNewline | 'auto';
export type SerialShellEncoding = 'utf-8' | 'gbk' | 'latin1';
export type SerialShellBackspace = 'bs' | 'del';

export interface SerialShellConfig {
  inputMode: SerialShellInputMode;
  localEcho: boolean;
  txNewline: SerialShellNewline;
  rxNewline: SerialShellRxNewline;
  encoding: SerialShellEncoding;
  backspace: SerialShellBackspace;
  showTimestamp: boolean;
  /** Line-mode command history, newest last. Runtime and persistence share this. */
  history: string[];
}

export interface SerialShellLine {
  readonly id: number;
  readonly text: string;
  readonly timestamp: number;
}

export interface SerialShellSnapshot {
  readonly lines: readonly SerialShellLine[];
  readonly current: SerialShellLine;
  readonly droppedLines: number;
  readonly droppedBytes: number;
  readonly resetVersion: number;
}
