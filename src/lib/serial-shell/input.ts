import type { SerialShellBackspace, SerialShellEncoding } from '@/types/serial-shell';
import type { SerialShellNewline } from '@/types/serial-shell';
import { encodeSerialShellText } from './encoding';
import { serialShellNewlineBytes } from './newline';

export type SerialShellKey =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'enter' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'control'; readonly code: number }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

export function isImmediateSerialShellKey(key: SerialShellKey): boolean {
  if (key.kind === 'enter' || key.kind === 'control') return true;
  if (key.kind === 'bytes') return key.bytes.some((byte) => byte < 0x20 || byte === 0x7f);
  return false;
}

export function encodeSerialShellKey(
  key: SerialShellKey,
  encoding: SerialShellEncoding,
  txNewline: SerialShellNewline,
  backspace: SerialShellBackspace,
): Uint8Array {
  if (key.kind === 'text') return encodeSerialShellText(key.text, encoding);
  if (key.kind === 'enter') return serialShellNewlineBytes(txNewline);
  if (key.kind === 'backspace') return new Uint8Array([backspace === 'del' ? 0x7f : 0x08]);
  if (key.kind === 'tab') return new Uint8Array([0x09]);
  if (key.kind === 'control') return new Uint8Array([key.code & 0x1f]);
  return key.bytes;
}

/**
 * Local-echo text written to the terminal for a key when the device does not
 * echo. Enter advances the line and backspace erases the previous cell.
 */
export function echoTextForSerialShellKey(key: SerialShellKey): string | null {
  if (key.kind === 'text') return key.text;
  if (key.kind === 'enter') return '\r\n';
  if (key.kind === 'backspace') return '\b \b';
  if (key.kind === 'tab') return '\t';
  return null;
}

const CSI_FINAL_BYTES: ReadonlyMap<string, Uint8Array> = new Map([
  ['A', new Uint8Array([0x1b, 0x5b, 0x41])],
  ['B', new Uint8Array([0x1b, 0x5b, 0x42])],
  ['C', new Uint8Array([0x1b, 0x5b, 0x43])],
  ['D', new Uint8Array([0x1b, 0x5b, 0x44])],
  ['H', new Uint8Array([0x1b, 0x5b, 0x48])],
  ['F', new Uint8Array([0x1b, 0x5b, 0x46])],
]);

/**
 * Translate a terminal-emulator input string (as produced by xterm.js
 * `onData`) into serial-shell keys. Escape sequences are passed through as
 * raw bytes so devices see the same bytes a real terminal would send.
 */
export function serialShellKeysFromData(data: string): SerialShellKey[] {
  const keys: SerialShellKey[] = [];
  let index = 0;
  while (index < data.length) {
    const char = data[index];
    if (char === '\u001b') {
      const consumed = consumeEscapeSequence(data, index, keys);
      if (consumed > 0) {
        index += consumed;
        continue;
      }
      // Incomplete or exotic sequence at the end of the chunk: send it raw.
      keys.push({ kind: 'bytes', bytes: new TextEncoder().encode(data.slice(index)) });
      break;
    }
    if (char === '\r' || char === '\n') {
      keys.push({ kind: 'enter' });
      // A pasted CRLF is one logical newline, not two Enter presses. Bare CR
      // and LF remain valid independently and use the configured TX EOL.
      index += char === '\r' && data[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\u007f' || char === '\b') {
      keys.push({ kind: 'backspace' });
      index += 1;
      continue;
    }
    if (char === '\t') {
      keys.push({ kind: 'tab' });
      index += 1;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20) {
      keys.push({ kind: 'control', code });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < data.length) {
      const nextCode = data.charCodeAt(end);
      if (nextCode < 0x20 || nextCode === 0x7f || data[end] === '\u001b') break;
      end += 1;
    }
    keys.push({ kind: 'text', text: data.slice(index, end) });
    index = end;
  }
  return keys;
}

function consumeEscapeSequence(data: string, start: number, keys: SerialShellKey[]): number {
  if (start + 1 >= data.length) {
    keys.push({ kind: 'control', code: 0x1b });
    return 1;
  }
  const finalChar = data[start + 1];
  const csiBytes = CSI_FINAL_BYTES.get(finalChar);
  if (csiBytes && start + 2 === data.length) {
    keys.push({ kind: 'bytes', bytes: csiBytes });
    return 2;
  }
  if (finalChar === '[' || finalChar === 'O') {
    // Full CSI/SS3 sequence: forward every byte up to the final byte.
    let end = start + 2;
    while (end < data.length) {
      const code = data.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) break;
      end += 1;
    }
    keys.push({ kind: 'bytes', bytes: new TextEncoder().encode(data.slice(start, end + 1)) });
    return end + 1 - start;
  }
  // Alt-modified key or two-character escape: send the raw bytes.
  keys.push({ kind: 'bytes', bytes: new TextEncoder().encode(data.slice(start, start + 2)) });
  return 2;
}
