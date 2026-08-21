/** Per-session interactive serial-console settings. Persisted in send_json. */

export type SerialShellNewline = 'none' | 'cr' | 'lf' | 'crlf';
export type SerialShellRxNewline = SerialShellNewline | 'auto';
export type SerialShellEncoding = 'utf-8' | 'gbk' | 'latin1';
export type SerialShellBackspace = 'bs' | 'del';

export interface SerialShellConfig {
  localEcho: boolean;
  txNewline: SerialShellNewline;
  rxNewline: SerialShellRxNewline;
  encoding: SerialShellEncoding;
  backspace: SerialShellBackspace;
}
