import type { McumgrTransportMode } from '../../types/mcumgr';
import { encodeConsolePacket, McumgrConsoleDecoder } from './serial-console';
import { encodeRawPacket, McumgrRawDecoder } from './serial-raw';

export interface McumgrTransportCodec {
  readonly mode: McumgrTransportMode;
  encode(smpPacket: Uint8Array): Uint8Array;
  push(bytes: Uint8Array): Uint8Array[];
  reset(): void;
}

export function createMcumgrTransport(
  mode: McumgrTransportMode,
  lineLength: number,
): McumgrTransportCodec {
  if (mode === 'raw-uart') {
    const decoder = new McumgrRawDecoder();
    return {
      mode,
      encode: encodeRawPacket,
      push: (bytes) => decoder.push(bytes),
      reset: () => decoder.reset(),
    };
  }
  const decoder = new McumgrConsoleDecoder();
  return {
    mode,
    encode: (packet) => encodeConsolePacket(packet, lineLength),
    push: (bytes) => decoder.push(bytes),
    reset: () => decoder.reset(),
  };
}
