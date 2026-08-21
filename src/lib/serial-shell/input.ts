import type {
  SerialShellBackspace,
  SerialShellEncoding,
  SerialShellNewline,
} from '../../types/serial-shell';
import { encodeSerialShellText } from './encoding';
import { concatBytes, serialShellNewlineBytes } from './newline';

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

export function encodeSerialShellLine(
  text: string,
  encoding: SerialShellEncoding,
  txNewline: SerialShellNewline,
): Uint8Array {
  return concatBytes(encodeSerialShellText(text, encoding), serialShellNewlineBytes(txNewline));
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

export function echoTextForSerialShellKey(key: SerialShellKey): string | null {
  if (key.kind === 'text') return key.text;
  if (key.kind === 'enter') return '\n';
  if (key.kind === 'backspace') return '\b';
  if (key.kind === 'tab') return '\t';
  return null;
}

/** Translate a DOM-like keyboard event into a serial-shell key, or null to ignore. */
export function serialShellKeyFromKeyboard(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}): SerialShellKey | null {
  if (event.altKey || event.metaKey) return null;
  if (event.ctrlKey) {
    if (event.key.length === 1) {
      const code = event.key.toLowerCase().charCodeAt(0);
      if (code >= 0x61 && code <= 0x7a) return { kind: 'control', code: code - 0x60 };
    }
    return null;
  }
  if (event.key === 'Enter') return { kind: 'enter' };
  if (event.key === 'Backspace') return { kind: 'backspace' };
  if (event.key === 'Tab') return { kind: 'tab' };
  if (event.key === 'ArrowUp') return { kind: 'bytes', bytes: new Uint8Array([0x1b, 0x5b, 0x41]) };
  if (event.key === 'ArrowDown')
    return { kind: 'bytes', bytes: new Uint8Array([0x1b, 0x5b, 0x42]) };
  if (event.key === 'ArrowRight')
    return { kind: 'bytes', bytes: new Uint8Array([0x1b, 0x5b, 0x43]) };
  if (event.key === 'ArrowLeft')
    return { kind: 'bytes', bytes: new Uint8Array([0x1b, 0x5b, 0x44]) };
  if (event.key === 'Escape') return { kind: 'control', code: 0x1b };
  if (event.key.length === 1) return { kind: 'text', text: event.key };
  return null;
}
