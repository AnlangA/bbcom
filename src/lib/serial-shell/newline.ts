import type { SerialShellNewline, SerialShellRxNewline } from '@/types/serial-shell';

export function serialShellNewlineBytes(kind: SerialShellNewline): Uint8Array {
  if (kind === 'cr') return new Uint8Array([0x0d]);
  if (kind === 'lf') return new Uint8Array([0x0a]);
  if (kind === 'crlf') return new Uint8Array([0x0d, 0x0a]);
  return new Uint8Array();
}

export function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/**
 * Streaming RX newline adapter for a terminal emulator. Output is written
 * verbatim to the terminal, so mapping means producing CRLF for logical line
 * endings while leaving lone CR untouched where it should overwrite the line:
 *
 * - `none` / `crlf`: pass through (device already emits terminal-ready
 *   endings; lone CR keeps its overwrite semantics).
 * - `auto` / `lf`: a bare LF becomes CRLF ("implicit CR in every LF") so
 *   LF-only devices do not staircase; CRLF pairs pass through unchanged.
 * - `cr`: a bare CR becomes CRLF; an LF directly following a CR is swallowed
 *   to avoid doubling lines for devices that occasionally emit CRLF.
 */
export class SerialShellRxMapper {
  private mode: SerialShellRxNewline;
  private lastWasCr = false;

  constructor(mode: SerialShellRxNewline) {
    this.mode = mode;
  }

  setMode(mode: SerialShellRxNewline): void {
    this.mode = mode;
    this.lastWasCr = false;
  }

  reset(): void {
    this.lastWasCr = false;
  }

  push(text: string): string {
    if (text.length === 0) return '';
    if (this.mode === 'none' || this.mode === 'crlf') return text;
    let out = '';
    for (const char of text) {
      if (char === '\r') {
        out += this.mode === 'cr' ? '\r\n' : '\r';
        this.lastWasCr = true;
        continue;
      }
      if (char === '\n') {
        if (this.mode === 'cr') {
          if (!this.lastWasCr) out += '\r\n';
        } else {
          out += this.lastWasCr ? '\n' : '\r\n';
        }
        this.lastWasCr = false;
        continue;
      }
      out += char;
      this.lastWasCr = false;
    }
    return out;
  }
}
