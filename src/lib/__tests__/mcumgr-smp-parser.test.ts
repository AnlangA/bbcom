import assert from 'node:assert/strict';
import { encode } from 'cborg';
import { describe, test } from 'vitest';
import { bytesToBase64 } from '@/lib/base64';
import { decodeBoundedSmpCbor, MAX_SMP_CBOR_BIGNUM_BYTES } from '@/lib/mcumgr-smp-cbor';
import {
  McumgrSmpParser,
  SMP_CONSOLE_CONTINUATION_MARKER,
  SMP_CONSOLE_INITIAL_MARKER,
  type SmpRecord,
} from '@/lib/mcumgr-smp-parser';

function smpPacket(input: {
  op: number;
  group?: number;
  sequence?: number;
  command?: number;
  versionBits?: number;
  flags?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const payload = input.payload ?? encode(new Map());
  const output = new Uint8Array(8 + payload.length);
  output[0] = ((input.versionBits ?? 1) << 3) | input.op;
  output[1] = input.flags ?? 0;
  output[2] = payload.length >>> 8;
  output[3] = payload.length;
  output[4] = (input.group ?? 0) >>> 8;
  output[5] = input.group ?? 0;
  output[6] = input.sequence ?? 0;
  output[7] = input.command ?? 0;
  output.set(payload, 8);
  return output;
}

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function consoleBody(packet: Uint8Array, corruptCrc = false): Uint8Array {
  const crc = crc16Xmodem(packet) ^ (corruptCrc ? 1 : 0);
  const output = new Uint8Array(packet.length + 4);
  const framedLength = packet.length + 2;
  output[0] = framedLength >>> 8;
  output[1] = framedLength;
  output.set(packet, 2);
  output[output.length - 2] = crc >>> 8;
  output[output.length - 1] = crc;
  return output;
}

function consoleLine(marker: readonly [number, number], body: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(bytesToBase64(body));
  const output = new Uint8Array(2 + encoded.length + 1);
  output.set(marker, 0);
  output.set(encoded, 2);
  output[output.length - 1] = 0x0a;
  return output;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function rawParser(timeout = 3_000): McumgrSmpParser {
  return new McumgrSmpParser({
    transport: 'raw-uart',
    maxPacketBytes: 1024 * 1024,
    reassemblyTimeoutMs: timeout,
  });
}

function consoleParser(timeout = 3_000): McumgrSmpParser {
  return new McumgrSmpParser({
    transport: 'serial-console',
    maxPacketBytes: 1024 * 1024,
    reassemblyTimeoutMs: timeout,
  });
}

function mapValue(record: SmpRecord, key: string): unknown {
  assert.ok(record.cbor instanceof Map);
  return record.cbor.get(key);
}

describe('MCUmgr SMP Raw UART', () => {
  test('decodes the v2 golden vector and preserves generic CBOR', () => {
    const parser = rawParser();
    const golden = Uint8Array.from([
      0x0a, 0x00, 0x00, 0x06, 0x00, 0x00, 0x2a, 0x00, 0xa1, 0x61, 0x64, 0x62, 0x68, 0x69,
    ]);
    const records = parser.feed({ direction: 'TX', data: golden, timestamp: 100, captureSeq: 7 });

    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.header?.version, 2);
    assert.equal(record.header?.opName, 'Write request');
    assert.equal(record.header?.groupName, 'OS');
    assert.equal(record.header?.commandName, 'Echo');
    assert.equal(record.header?.sequence, 42);
    assert.equal(record.status, 'pending');
    assert.equal(record.captureSeq, 7);
    assert.equal(mapValue(record, 'd'), 'hi');
  });

  test('handles arbitrary chunk boundaries and correlates request/response RTT', () => {
    const parser = rawParser();
    const request = smpPacket({
      op: 2,
      group: 0,
      sequence: 255,
      payload: encode(new Map([['d', 'hello']])),
    });
    const response = smpPacket({
      op: 3,
      group: 0,
      sequence: 255,
      payload: encode(new Map([['r', 'hello']])),
    });

    let requestRecord: SmpRecord | undefined;
    for (let index = 0; index < request.length; index += 1) {
      const records = parser.feed({
        direction: 'TX',
        data: request.subarray(index, index + 1),
        timestamp: 1_000,
      });
      requestRecord ??= records[0];
    }
    assert.ok(requestRecord);
    const [responseRecord] = parser.feed({ direction: 'RX', data: response, timestamp: 1_025 });
    assert.equal(responseRecord.requestId, requestRecord.id);
    assert.equal(responseRecord.rttMs, 25);
    assert.equal(requestRecord.responseId, responseRecord.id);
    assert.equal(requestRecord.status, 'ok');
  });

  test('resynchronizes after noise without losing the following packet', () => {
    const parser = rawParser();
    const packet = smpPacket({ op: 0, group: 2, sequence: 4, command: 1 });
    const records = parser.feed({
      direction: 'RX',
      data: concat(Uint8Array.of(0xff, 0xfe, 0xfd), packet),
      timestamp: 1,
    });
    assert.equal(records.length, 2);
    assert.equal(records[0].diagnostics[0].code, 'smp.raw.resync');
    assert.equal(records[1].header?.groupName, 'Statistics');
  });

  test('preserves reserved versions and unknown commands as warning records', () => {
    const parser = rawParser();
    const version = parser.feed({
      direction: 'RX',
      data: smpPacket({ op: 1, versionBits: 2, flags: 0x80, sequence: 3 }),
      timestamp: 1,
    })[0];
    assert.equal(version.header?.versionBits, 2);
    assert.ok(version.diagnostics.some((item) => item.code === 'smp.header.version'));
    assert.ok(version.diagnostics.some((item) => item.code === 'smp.header.flags'));

    const command = parser.feed({
      direction: 'RX',
      data: smpPacket({ op: 1, group: 2, command: 250, sequence: 4 }),
      timestamp: 2,
    })[0];
    assert.equal(command.header?.command, 250);
    assert.ok(command.diagnostics.some((item) => item.code === 'smp.header.unknown-command'));
  });

  test('does not strip an unpadded v1 read header from a sticky stream', () => {
    const parser = rawParser();
    const first = smpPacket({ op: 1, sequence: 1, payload: Uint8Array.of(0x82, 0, 0) });
    assert.equal(first.length % 4, 3);
    const second = smpPacket({ op: 0, versionBits: 0, sequence: 2 });
    const records = parser.feed({
      direction: 'RX',
      data: concat(first, second),
      timestamp: 10,
    });
    assert.deepEqual(
      records.map((record) => record.header?.sequence),
      [1, 2],
    );
  });

  test('preserves an unpadded v1 custom-group request after a misaligned message', () => {
    const parser = rawParser();
    const first = smpPacket({ op: 1, sequence: 1, payload: Uint8Array.of(0x82, 0, 0) });
    assert.equal(first.length % 4, 3);
    const second = smpPacket({ op: 0, versionBits: 0, group: 64, sequence: 2 });
    const records = parser.feed({
      direction: 'RX',
      data: concat(first, second),
      timestamp: 10,
    });
    assert.deepEqual(
      records.map((record) => record.header?.sequence),
      [1, 2],
    );
    assert.equal(records[1].header?.group, 64);
  });

  test('frames zero-length and custom non-CBOR payloads without content heuristics', () => {
    const parser = rawParser();
    const empty = smpPacket({
      op: 1,
      versionBits: 0,
      sequence: 3,
      payload: new Uint8Array(0),
    });
    const custom = smpPacket({
      op: 1,
      group: 64,
      sequence: 4,
      payload: Uint8Array.of(0xff, 0xff),
    });
    const records = parser.feed({
      direction: 'RX',
      data: concat(empty, custom),
      timestamp: 10,
    });

    assert.deepEqual(
      records.map((record) => record.header?.sequence),
      [3, 4],
    );
    assert.equal(records[0].header?.dataLength, 0);
    assert.ok(records[1].diagnostics.some((item) => item.code === 'smp.cbor.invalid'));
  });

  test('keeps unpadded sticky parsing invariant across every three-chunk split', () => {
    const first = smpPacket({ op: 1, sequence: 1, payload: Uint8Array.of(0xa0) });
    const second = smpPacket({ op: 0, versionBits: 0, sequence: 9 });
    const wire = concat(first, second);

    for (let firstCut = 1; firstCut < wire.length - 1; firstCut += 1) {
      for (let secondCut = firstCut + 1; secondCut < wire.length; secondCut += 1) {
        const parser = rawParser();
        const records = [
          ...parser.feed({ direction: 'RX', data: wire.subarray(0, firstCut), timestamp: 1 }),
          ...parser.feed({
            direction: 'RX',
            data: wire.subarray(firstCut, secondCut),
            timestamp: 2,
          }),
          ...parser.feed({ direction: 'RX', data: wire.subarray(secondCut), timestamp: 3 }),
        ];
        assert.deepEqual(
          records.map((record) => record.header?.sequence),
          [1, 9],
          `split at ${firstCut}/${secondCut}`,
        );
      }
    }
  });

  test('times out an incomplete false header, then recovers on the next packet', () => {
    const parser = rawParser(100);
    const falseHeader = Uint8Array.of(0, 0, 1, 0, 0, 0, 0, 0);
    const packet = smpPacket({ op: 1, group: 2, sequence: 9, command: 1 });
    assert.deepEqual(
      parser.feed({ direction: 'RX', data: falseHeader, timestamp: 10, captureSeq: 1 }),
      [],
    );
    assert.deepEqual(
      parser.feed({
        direction: 'RX',
        data: packet,
        timestamp: 20,
        captureSeq: 2,
      }),
      [],
    );
    const timedOut = parser.flushExpired(120);
    assert.equal(timedOut.length, 1);
    assert.equal(timedOut[0].diagnostics[0].code, 'smp.raw.timeout');

    const records = parser.feed({
      direction: 'RX',
      data: packet,
      timestamp: 130,
      captureSeq: 3,
    });
    assert.equal(records[0].captureSeq, 3);
    assert.equal(records[0].timestamp, 130);
    assert.equal(records[0].header?.sequence, 9);
  });

  test('waits for the declared payload even when a chunk contains header-like bytes', () => {
    const parser = rawParser();
    const embedded = Uint8Array.of(1, 0, 0, 0, 0, 0, 9, 0);
    const packet = smpPacket({
      op: 1,
      sequence: 44,
      payload: encode(
        new Map<string, unknown>([
          ['blob', embedded],
          ['tail', 'complete'],
        ]),
      ),
    });
    let embeddedOffset = -1;
    for (let index = 8; index + embedded.length <= packet.length; index += 1) {
      if (embedded.every((byte, offset) => packet[index + offset] === byte)) {
        embeddedOffset = index;
        break;
      }
    }
    assert.ok(embeddedOffset >= 0);
    const split = embeddedOffset + embedded.length;
    assert.deepEqual(
      parser.feed({ direction: 'RX', data: packet.subarray(0, split), timestamp: 1 }),
      [],
    );
    const records = parser.feed({
      direction: 'RX',
      data: packet.subarray(split),
      timestamp: 2,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].header?.sequence, 44);
  });

  test('byte-resynchronizes an illegal reserved/op header', () => {
    const parser = rawParser();
    const valid = smpPacket({ op: 1, sequence: 5 });
    const records = parser.feed({
      direction: 'RX',
      data: concat(Uint8Array.of(0xe7), valid),
      timestamp: 1,
    });
    assert.equal(records[0].diagnostics[0].code, 'smp.raw.resync');
    assert.equal(records[1].header?.sequence, 5);
  });

  test('keeps TX and RX partial buffers independent and reports timeouts', () => {
    const parser = rawParser(100);
    const tx = smpPacket({ op: 2, group: 1, sequence: 3 });
    const rx = smpPacket({ op: 3, group: 1, sequence: 3 });
    assert.deepEqual(parser.feed({ direction: 'TX', data: tx.subarray(0, 5), timestamp: 0 }), []);
    assert.equal(parser.feed({ direction: 'RX', data: rx, timestamp: 20 }).length, 1);
    const expired = parser.flushExpired(101);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].direction, 'TX');
    assert.equal(expired[0].diagnostics[0].code, 'smp.raw.timeout');
  });

  test('matches the oldest retry when a sequence number is reused', () => {
    const parser = rawParser();
    const request = smpPacket({ op: 2, group: 1, sequence: 0, command: 1 });
    const response = smpPacket({ op: 3, group: 1, sequence: 0, command: 1 });
    const first = parser.feed({ direction: 'TX', data: request, timestamp: 1 })[0];
    const retry = parser.feed({ direction: 'TX', data: request, timestamp: 2 })[0];
    const firstResponse = parser.feed({ direction: 'RX', data: response, timestamp: 4 })[0];
    const retryResponse = parser.feed({ direction: 'RX', data: response, timestamp: 7 })[0];

    assert.equal(firstResponse.requestId, first.id);
    assert.equal(firstResponse.rttMs, 3);
    assert.equal(retryResponse.requestId, retry.id);
    assert.equal(retryResponse.rttMs, 5);
  });

  test('decodes v1 and v2 error shapes and treats custom non-CBOR as a warning', () => {
    const parser = rawParser();
    const v1 = parser.feed({
      direction: 'RX',
      data: smpPacket({
        op: 1,
        versionBits: 0,
        payload: encode(
          new Map<string, unknown>([
            ['rc', 3],
            ['rsn', 'invalid'],
          ]),
        ),
      }),
      timestamp: 1,
    })[0];
    assert.equal(v1.header?.version, 1);
    assert.equal(v1.status, 'error');
    assert.match(v1.summary, /rc=3/);

    const v2 = parser.feed({
      direction: 'RX',
      data: smpPacket({
        op: 3,
        payload: encode(
          new Map([
            [
              'err',
              new Map<string, unknown>([
                ['group', 1],
                ['rc', 2],
              ]),
            ],
          ]),
        ),
      }),
      timestamp: 2,
    })[0];
    assert.equal(v2.status, 'error');
    assert.match(v2.summary, /group=1.*rc=2/);

    const custom = parser.feed({
      direction: 'TX',
      data: smpPacket({ op: 2, group: 64, payload: Uint8Array.of(0xff, 0xff) }),
      timestamp: 3,
    })[0];
    assert.equal(custom.status, 'warning');
    assert.ok(custom.diagnostics.some((diagnostic) => diagnostic.code === 'smp.cbor.invalid'));
  });
});

describe('MCUmgr SMP Serial Console', () => {
  test('decodes a packet after log noise and validates CRC', () => {
    const parser = consoleParser();
    const packet = smpPacket({ op: 0, group: 0, sequence: 9 });
    const line = consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(packet));
    const records = parser.feed({
      direction: 'TX',
      data: concat(new TextEncoder().encode('boot log\nnoise: '), line),
      timestamp: 10,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].crcStatus, 'valid');
    assert.equal(records[0].header?.sequence, 9);
  });

  test('reassembles multiple fragments and diagnoses orphan continuations', () => {
    const parser = consoleParser();
    const packet = smpPacket({
      op: 2,
      group: 9,
      payload: encode(new Map([['argv', ['echo', 'hello']]])),
    });
    const body = consoleBody(packet);
    const split = 6;
    const first = consoleLine(SMP_CONSOLE_INITIAL_MARKER, body.subarray(0, split));
    const rest = consoleLine(SMP_CONSOLE_CONTINUATION_MARKER, body.subarray(split));

    assert.deepEqual(parser.feed({ direction: 'TX', data: first, timestamp: 1 }), []);
    const completed = parser.feed({ direction: 'TX', data: rest, timestamp: 2 });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].header?.groupName, 'Shell');

    const orphan = parser.feed({ direction: 'RX', data: rest, timestamp: 3 });
    assert.equal(orphan[0].diagnostics[0].code, 'smp.console.orphan-continuation');
  });

  test('retains the SMP header when CRC is invalid and reports malformed Base64', () => {
    const parser = consoleParser();
    const packet = smpPacket({ op: 3, group: 1, sequence: 2 });
    const crcRecord = parser.feed({
      direction: 'RX',
      data: consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(packet, true)),
      timestamp: 1,
    })[0];
    assert.equal(crcRecord.header?.groupName, 'Image');
    assert.equal(crcRecord.crcStatus, 'invalid');
    assert.equal(crcRecord.status, 'error');

    const invalid = concat(
      Uint8Array.from(SMP_CONSOLE_INITIAL_MARKER),
      new TextEncoder().encode('***\n'),
    );
    const badBase64 = parser.feed({ direction: 'RX', data: invalid, timestamp: 2 })[0];
    assert.equal(badBase64.diagnostics[0].code, 'smp.console.base64');
  });

  test('rescans one console line after invalid Base64 for a later initial marker', () => {
    const parser = consoleParser();
    const packet = smpPacket({ op: 1, sequence: 19 });
    const line = concat(
      Uint8Array.from(SMP_CONSOLE_INITIAL_MARKER),
      new TextEncoder().encode('***'),
      consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(packet)),
    );
    const records = parser.feed({ direction: 'RX', data: line, timestamp: 1 });
    assert.equal(records[0].diagnostics[0].code, 'smp.console.base64');
    assert.equal(records[1].header?.sequence, 19);
  });

  test('does not correlate a CRC-invalid response or consume the valid request', () => {
    const parser = consoleParser();
    const requestPacket = smpPacket({ op: 2, sequence: 12 });
    const responsePacket = smpPacket({ op: 3, sequence: 12 });
    const request = parser.feed({
      direction: 'TX',
      data: consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(requestPacket)),
      timestamp: 1,
    })[0];
    const corrupt = parser.feed({
      direction: 'RX',
      data: consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(responsePacket, true)),
      timestamp: 2,
    })[0];
    assert.equal(corrupt.crcStatus, 'invalid');
    assert.equal(corrupt.requestId, undefined);
    assert.equal(request.status, 'pending');

    const valid = parser.feed({
      direction: 'RX',
      data: consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(responsePacket)),
      timestamp: 3,
    })[0];
    assert.equal(valid.requestId, request.id);
    assert.equal(request.responseId, valid.id);
    assert.equal(valid.rttMs, 2);
  });

  test('decodes multiple aligned SMP messages in one transport packet', () => {
    const parser = consoleParser();
    const first = smpPacket({ op: 0, group: 2, sequence: 1, payload: encode(new Map()) });
    const padding = new Uint8Array((4 - (first.length % 4)) % 4);
    const second = smpPacket({ op: 0, group: 2, sequence: 2, command: 1 });
    const transportPacket = concat(first, padding, second);
    const records = parser.feed({
      direction: 'TX',
      data: consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(transportPacket)),
      timestamp: 1,
    });
    assert.deepEqual(
      records.map((record) => record.header?.sequence),
      [1, 2],
    );
  });

  test('preserves reserved header values as warnings and expires partial console packets', () => {
    const parser = consoleParser(100);
    const unknownVersion = smpPacket({ op: 0, versionBits: 2 });
    const decoded = parser.feed({
      direction: 'TX',
      data: consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(unknownVersion)),
      timestamp: 1,
    })[0];
    assert.equal(decoded.header?.versionBits, 2);
    assert.equal(decoded.status, 'warning');
    assert.ok(decoded.diagnostics.some((diagnostic) => diagnostic.code === 'smp.header.version'));

    const incomplete = consoleBody(smpPacket({ op: 2, group: 1 })).subarray(0, 6);
    assert.deepEqual(
      parser.feed({
        direction: 'TX',
        data: consoleLine(SMP_CONSOLE_INITIAL_MARKER, incomplete),
        timestamp: 10,
      }),
      [],
    );
    const expired = parser.flushExpired(110);
    assert.equal(expired[0].diagnostics[0].code, 'smp.console.timeout');
  });

  test('handles every-byte chunks, unterminated lines, and decoded length overflow', () => {
    const packet = smpPacket({ op: 0, group: 0, sequence: 12 });
    const line = consoleLine(SMP_CONSOLE_INITIAL_MARKER, consoleBody(packet));
    const parser = consoleParser(100);
    const records: SmpRecord[] = [];
    for (let index = 0; index < line.length; index += 1) {
      records.push(
        ...parser.feed({
          direction: 'TX',
          data: line.subarray(index, index + 1),
          timestamp: index,
        }),
      );
    }
    assert.equal(records.length, 1);
    assert.equal(records[0].header?.sequence, 12);

    const unterminated = line.subarray(0, line.length - 1);
    assert.deepEqual(parser.feed({ direction: 'RX', data: unterminated, timestamp: 200 }), []);
    assert.equal(parser.nextExpiryTimestamp(), 300);
    const timedOut = parser.flushExpired(300);
    assert.equal(timedOut[0].diagnostics[0].code, 'smp.console.timeout');

    const overflow = concat(consoleBody(packet), Uint8Array.of(0xaa));
    const overflowRecord = parser.feed({
      direction: 'RX',
      data: consoleLine(SMP_CONSOLE_INITIAL_MARKER, overflow),
      timestamp: 400,
    })[0];
    assert.equal(overflowRecord.status, 'error');
    assert.ok(
      overflowRecord.diagnostics.some((item) => item.code === 'smp.console.trailing-bytes'),
    );
  });
});

describe('bounded CBOR decoding', () => {
  test('supports indefinite maps/arrays, BigInt, and byte strings', () => {
    const indefinite = Uint8Array.from([
      0xbf, 0x61, 0x61, 0x9f, 0x01, 0x02, 0xff, 0x61, 0x62, 0x1b, 0xff, 0xff, 0xff, 0xff, 0xff,
      0xff, 0xff, 0xff, 0x61, 0x63, 0x42, 0xaa, 0xbb, 0xff,
    ]);
    const result = decodeBoundedSmpCbor(indefinite);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.value instanceof Map);
    assert.deepEqual(result.value.get('a'), [1, 2]);
    assert.equal(result.value.get('b'), 18_446_744_073_709_551_615n);
    assert.deepEqual(result.value.get('c'), Uint8Array.of(0xaa, 0xbb));
  });

  test('rejects duplicate keys, excessive depth, excessive nodes, and indefinite strings', () => {
    assert.equal(
      decodeBoundedSmpCbor(Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])).ok,
      false,
    );

    const deep = Uint8Array.from([...new Uint8Array(33).fill(0x81), 0x00]);
    assert.equal(decodeBoundedSmpCbor(deep).ok, false);

    const many = new Uint8Array(4_100 + 3);
    many.set([0x99, 0x10, 0x04]);
    assert.equal(decodeBoundedSmpCbor(many).ok, false);

    assert.equal(decodeBoundedSmpCbor(Uint8Array.from([0x7f, 0x61, 0x61, 0xff])).ok, false);
  });

  test('rejects an oversized tag 2 bignum before the expensive BigInt decoder runs', () => {
    const payload = new Uint8Array(4 + MAX_SMP_CBOR_BIGNUM_BYTES + 1);
    payload.set([0xc2, 0x59, 0x10, 0x01]);
    payload.fill(0xff, 4);
    const result = decodeBoundedSmpCbor(payload);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /bignum.*4096/i);
  });

  test('decodes standard positive and negative bignum tags', () => {
    const positive = decodeBoundedSmpCbor(
      Uint8Array.from([0xc2, 0x49, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]),
    );
    assert.deepEqual(positive, { ok: true, value: 18_446_744_073_709_551_616n });

    const negative = decodeBoundedSmpCbor(
      Uint8Array.from([0xc3, 0x49, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]),
    );
    assert.deepEqual(negative, { ok: true, value: -18_446_744_073_709_551_617n });
  });
});
