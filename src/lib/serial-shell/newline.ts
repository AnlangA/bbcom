import type { SerialShellNewline, SerialShellRxNewline } from '../../types/serial-shell';

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
 * Streaming RX newline mapper. Mapped line endings become `\n`; leftover CR
 * stays `\r` so the display engine can overwrite the current line.
 */
export class SerialShellRxMapper {
  private mode: SerialShellRxNewline;
  private pendingCr = false;

  constructor(mode: SerialShellRxNewline) {
    this.mode = mode;
  }

  setMode(mode: SerialShellRxNewline): void {
    this.mode = mode;
    this.pendingCr = false;
  }

  reset(): void {
    this.pendingCr = false;
  }

  push(text: string): string {
    if (text.length === 0) return '';
    if (this.mode === 'none') return text;
    let out = '';
    for (const char of text) {
      out += this.consume(char);
    }
    return out;
  }

  flush(): string {
    if (!this.pendingCr) return '';
    this.pendingCr = false;
    if (this.mode === 'auto' || this.mode === 'cr') return '\n';
    return '\r';
  }

  private consume(char: string): string {
    if (this.pendingCr) {
      this.pendingCr = false;
      if (char === '\n') return '\n';
      return `${this.pendingCrReplacement()}${this.consumeFresh(char)}`;
    }
    return this.consumeFresh(char);
  }

  private consumeFresh(char: string): string {
    if (char === '\r') {
      if (this.mode === 'lf') return '\r';
      if (this.mode === 'cr' || this.mode === 'auto') return this.beginCr();
      // crlf: wait to see if LF follows
      return this.beginCr();
    }
    if (char === '\n') {
      if (this.mode === 'cr') return '';
      return '\n';
    }
    return char;
  }

  private beginCr(): string {
    this.pendingCr = true;
    return '';
  }

  private pendingCrReplacement(): string {
    if (this.mode === 'auto' || this.mode === 'cr') return '\n';
    return '\r';
  }
}
