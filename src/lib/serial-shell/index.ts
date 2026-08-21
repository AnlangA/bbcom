/**
 * Serial-shell domain barrel: config, encoding, newline mapping, and the
 * dumb-terminal display engine. Framework-free so tests can run headlessly.
 */
export {
  DEFAULT_SERIAL_SHELL_CONFIG,
  SERIAL_SHELL_HISTORY_ENTRY_MAX_CHARS,
  SERIAL_SHELL_HISTORY_LIMIT,
  cloneSerialShellConfig,
  normalizeSerialShellConfig,
  normalizeShellHistory,
  pushShellHistory,
} from './config';
export { SerialShellDecoder, encodeSerialShellText } from './encoding';
export { SerialShellRxMapper, concatBytes, serialShellNewlineBytes } from './newline';
export {
  encodeSerialShellKey,
  encodeSerialShellLine,
  echoTextForSerialShellKey,
  isImmediateSerialShellKey,
  serialShellKeyFromKeyboard,
  type SerialShellKey,
} from './input';
export {
  SERIAL_SHELL_MAX_BYTES,
  SERIAL_SHELL_MAX_LINES,
  SerialShellEngine,
  type SerialShellEngineLimits,
} from './engine';
