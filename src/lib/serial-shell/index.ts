/**
 * Serial-shell domain barrel: config, encoding, newline mapping, and
 * terminal-input translation. Framework-free so tests can run headlessly.
 * Display is owned by the xterm.js terminal in the shell panel.
 */
export {
  DEFAULT_SERIAL_SHELL_CONFIG,
  cloneSerialShellConfig,
  normalizeSerialShellConfig,
} from './config';
export { SerialShellDecoder, encodeSerialShellText } from './encoding';
export { SerialShellRxMapper, concatBytes, serialShellNewlineBytes } from './newline';
export {
  encodeSerialShellKey,
  echoTextForSerialShellKey,
  isImmediateSerialShellKey,
  serialShellKeysFromData,
  type SerialShellKey,
} from './input';
