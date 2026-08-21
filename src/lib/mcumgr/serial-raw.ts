import { decodeSmpPacket, SMP_HEADER_BYTES } from './smp';

export const MCUMGR_RAW_MAX_PAYLOAD = 0xffff;

export class McumgrRawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McumgrRawError';
  }
}

/** Raw UART transport: wire bytes are the SMP packet with no console framing. */
export function encodeRawPacket(smpPacket: Uint8Array): Uint8Array {
  decodeSmpPacket(smpPacket);
  return smpPacket;
}

export class McumgrRawDecoder {
  private remainder: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  reset(): void {
    this.remainder = new Uint8Array(0);
  }

  push(bytes: Uint8Array): Uint8Array[] {
    this.remainder = concat(this.remainder, bytes);
    const packets: Uint8Array[] = [];
    while (this.remainder.length >= SMP_HEADER_BYTES) {
      const header = findHeader(this.remainder);
      if (!header) {
        this.remainder =
          this.remainder.length > 7
            ? this.remainder.subarray(this.remainder.length - 7)
            : this.remainder;
        break;
      }
      if (header.skip > 0) this.remainder = this.remainder.subarray(header.skip);
      const total = SMP_HEADER_BYTES + header.payloadLength;
      if (this.remainder.length < total) break;
      packets.push(this.remainder.subarray(0, total));
      this.remainder = this.remainder.subarray(total);
    }
    return packets;
  }
}

function findHeader(bytes: Uint8Array): { skip: number; payloadLength: number } | null {
  for (let i = 0; i + SMP_HEADER_BYTES <= bytes.length; i += 1) {
    const reserved = bytes[i] >> 5;
    const version = (bytes[i] >> 3) & 0x03;
    const op = bytes[i] & 0x07;
    const flags = bytes[i + 1];
    const payloadLength = (bytes[i + 2] << 8) | bytes[i + 3];
    if (reserved !== 0 || flags !== 0) continue;
    if (version > 1 || op > 3) continue;
    if (payloadLength > MCUMGR_RAW_MAX_PAYLOAD) continue;
    return { skip: i, payloadLength };
  }
  return null;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
