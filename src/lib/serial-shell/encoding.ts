import type { SerialShellEncoding } from '../../types/serial-shell';

const TEXT_ENCODER = new TextEncoder();

function decoderLabel(encoding: SerialShellEncoding): string {
  if (encoding === 'gbk') return 'gbk';
  if (encoding === 'latin1') return 'latin1';
  return 'utf-8';
}

export function createSerialShellDecoder(encoding: SerialShellEncoding): TextDecoder {
  return new TextDecoder(decoderLabel(encoding), { fatal: false });
}

export class SerialShellDecoder {
  private encoding: SerialShellEncoding;
  private decoder: TextDecoder;

  constructor(encoding: SerialShellEncoding) {
    this.encoding = encoding;
    this.decoder = createSerialShellDecoder(encoding);
  }

  setEncoding(encoding: SerialShellEncoding): void {
    if (encoding === this.encoding) return;
    this.encoding = encoding;
    this.decoder = createSerialShellDecoder(encoding);
  }

  push(bytes: Uint8Array): string {
    if (bytes.length === 0) return '';
    return this.decoder.decode(bytes, { stream: true });
  }

  reset(): void {
    this.decoder.decode(new Uint8Array(), { stream: false });
    this.decoder = createSerialShellDecoder(this.encoding);
  }
}

export function encodeSerialShellText(text: string, encoding: SerialShellEncoding): Uint8Array {
  if (text.length === 0) return new Uint8Array();
  if (encoding === 'utf-8') return TEXT_ENCODER.encode(text);
  if (encoding === 'latin1') {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }
  return encodeGbk(text);
}

let gbkReverse: Map<string, number> | null = null;

function gbkReverseMap(): Map<string, number> {
  if (gbkReverse) return gbkReverse;
  const map = new Map<string, number>();
  const decoder = createSerialShellDecoder('gbk');
  for (let byte = 0; byte < 0x80; byte += 1) {
    map.set(String.fromCharCode(byte), byte);
  }
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    pair[0] = lead;
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      pair[1] = trail;
      const decoded = decoder.decode(pair);
      if (decoded.length === 1 && decoded !== '\uFFFD' && !map.has(decoded)) {
        map.set(decoded, (lead << 8) | trail);
      }
    }
  }
  gbkReverse = map;
  return map;
}

function encodeGbk(text: string): Uint8Array {
  const map = gbkReverseMap();
  const bytes: number[] = [];
  for (const char of text) {
    const mapped = map.get(char);
    if (mapped === undefined) {
      bytes.push(0x3f);
      continue;
    }
    if (mapped <= 0xff) {
      bytes.push(mapped);
      continue;
    }
    bytes.push((mapped >> 8) & 0xff, mapped & 0xff);
  }
  return Uint8Array.from(bytes);
}
