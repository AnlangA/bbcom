import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  Cbor,
  McumgrError,
  McumgrTransactionRunner,
  byteSourceFromBytes,
  crc16Xmodem,
  decodeCbor,
  decodeCborMap,
  decodeImageState,
  decodeSmpPacket,
  encodeConsolePacket,
  encodeCbor,
  encodeImageUploadChunk,
  encodeOsEcho,
  encodeSmpRequest,
  imageChunkSize,
  packByte0,
  parseMcubootImage,
  SMP_GROUP,
  SMP_OP,
  uploadImage,
  type McumgrWriteResult,
} from '../../src/lib/mcumgr/index.ts';
import { McumgrConsoleDecoder } from '../../src/lib/mcumgr/serial-console.ts';
import { createMcumgrTransport } from '../../src/lib/mcumgr/transport.ts';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

function complete(bytes: number): McumgrWriteResult {
  return { outcome: 'complete', requestedBytes: bytes, sentBytes: bytes };
}

test('crc16-xmodem matches the empty and single-byte vectors', () => {
  assert.equal(crc16Xmodem(new Uint8Array()), 0);
  assert.equal(crc16Xmodem(Uint8Array.of(0x01)), 0x1021);
});

test('CBOR encodes the OS echo payload as a definite text map', () => {
  assert.equal(hex(encodeOsEcho('hi')), 'a1 61 64 62 68 69');
  const decoded = decodeCbor(encodeCbor(Cbor.map({ d: Cbor.text('hi') })));
  assert.equal(decoded.kind, 'map');
});

test('SMP v2 OS echo "hi" with seq 0x2a matches the gold request', () => {
  const packet = encodeSmpRequest({
    version: 2,
    op: SMP_OP.write,
    group: SMP_GROUP.os,
    command: 0,
    sequence: 0x2a,
    payload: encodeOsEcho('hi'),
  });
  assert.equal(hex(packet), '0a 00 00 06 00 00 2a 00 a1 61 64 62 68 69');
  assert.equal(packByte0(2, SMP_OP.write), 0x0a);
  assert.equal(decodeSmpPacket(packet).header.version, 2);
});

test('console transport frames an SMP packet and decodes it from noisy lines', () => {
  const smp = encodeSmpRequest({
    version: 2,
    op: SMP_OP.write,
    group: SMP_GROUP.os,
    command: 0,
    sequence: 0x2a,
    payload: encodeOsEcho('hi'),
  });
  const framed = encodeConsolePacket(smp, 127);
  assert.equal(framed[0], 0x06);
  assert.equal(framed[1], 0x09);
  assert.equal(framed[framed.length - 1], 0x0a);
  const decoder = new McumgrConsoleDecoder();
  const noise = new TextEncoder().encode('boot log\n');
  assert.deepEqual(decoder.push(noise), []);
  assert.deepEqual([...decoder.push(framed)].map(hex), [hex(smp)]);
});

test('read-only transactions retry on timeout; writes never retry after a physical write', async () => {
  let writes = 0;
  const transport = createMcumgrTransport('raw-uart', 127);
  const runner = new McumgrTransactionRunner({
    write: async (payload) => {
      writes += 1;
      if (writes === 1) return complete(payload.length);
      return complete(payload.length);
    },
    getTransport: () => transport,
    getTimeoutMs: () => 20,
    getRetries: () => 1,
  });
  await assert.rejects(
    runner.transact({
      version: 2,
      op: SMP_OP.read,
      group: SMP_GROUP.os,
      command: 6,
      payload: Uint8Array.of(0xa0),
    }),
    (error: unknown) => error instanceof McumgrError && error.kind === 'timeout',
  );
  assert.equal(writes, 2);

  writes = 0;
  const writeRunner = new McumgrTransactionRunner({
    write: async (payload) => {
      writes += 1;
      return complete(payload.length);
    },
    getTransport: () => createMcumgrTransport('raw-uart', 127),
    getTimeoutMs: () => 20,
    getRetries: () => 3,
  });
  await assert.rejects(
    writeRunner.transact({
      version: 2,
      op: SMP_OP.write,
      group: SMP_GROUP.os,
      command: 0,
      payload: encodeOsEcho('x'),
    }),
    (error: unknown) => error instanceof McumgrError && error.kind === 'timeout',
  );
  assert.equal(writes, 1);
});

test('a partial write after bytes left the host is not retried', async () => {
  let writes = 0;
  const runner = new McumgrTransactionRunner({
    write: async (payload) => {
      writes += 1;
      return { outcome: 'partial', requestedBytes: payload.length, sentBytes: 4 };
    },
    getTransport: () => createMcumgrTransport('raw-uart', 127),
    getTimeoutMs: () => 50,
    getRetries: () => 2,
  });
  await assert.rejects(
    runner.transact({
      version: 2,
      op: SMP_OP.write,
      group: SMP_GROUP.os,
      command: 0,
      payload: encodeOsEcho('hi'),
    }),
    (error: unknown) => error instanceof McumgrError && error.kind === 'partial-write',
  );
  assert.equal(writes, 1);
});

test('image upload sends sha/len on the first chunk and follows offset redirects', async () => {
  const source = byteSourceFromBytes(new Uint8Array(40).fill(7));
  const offsets: number[] = [];
  const result = await uploadImage({
    source,
    mtu: 512,
    firstTimeoutMs: 1000,
    subsequentTimeoutMs: 1000,
    async transact(request) {
      const map = decodeCborMap(request.payload ?? new Uint8Array());
      const off = map.get('off');
      assert.equal(off?.kind, 'uint');
      offsets.push(off && off.kind === 'uint' ? off.value : -1);
      if (offsets.length === 1) {
        assert.equal(map.get('len')?.kind, 'uint');
        assert.equal(map.get('sha')?.kind, 'bstr');
      }
      if (offsets.length === 2 && off && off.kind === 'uint' && off.value !== 0) {
        return { payload: encodeCbor(Cbor.map({ off: Cbor.uint(0) })) };
      }
      const next = Math.min(source.size, (off && off.kind === 'uint' ? off.value : 0) + 16);
      return { payload: encodeCbor(Cbor.map({ off: Cbor.uint(next) })) };
    },
  });
  assert.equal(offsets[0], 0);
  assert.ok(offsets.includes(0));
  assert.equal(result.match, undefined);
  assert.ok(imageChunkSize(512) <= 16 * 1024);
  assert.ok(
    encodeImageUploadChunk({ off: 0, data: Uint8Array.of(1), len: 1, sha: new Uint8Array(32) })
      .length > 0,
  );
});

test('MCUboot parser accepts the little-endian magic', () => {
  const header = new Uint8Array(32);
  new DataView(header.buffer).setUint32(0, 0x96f3b83d, true);
  new DataView(header.buffer).setUint16(8, 32, true);
  assert.equal(parseMcubootImage(header).magicOk, true);
  assert.equal(parseMcubootImage(new Uint8Array(32)).magicOk, false);
});

test('image state decoder reads slot maps without re-encoding', () => {
  const payload = encodeCbor(
    Cbor.map({
      images: Cbor.array([
        Cbor.map({
          slot: Cbor.uint(0),
          version: Cbor.text('1.0.0'),
          confirmed: Cbor.bool(true),
        }),
      ]),
    }),
  );
  assert.deepEqual(decodeImageState(payload), {
    images: [
      {
        image: undefined,
        slot: 0,
        version: '1.0.0',
        hash: undefined,
        bootable: undefined,
        pending: undefined,
        confirmed: true,
        active: undefined,
        permanent: undefined,
      },
    ],
    splitStatus: undefined,
  });
});
