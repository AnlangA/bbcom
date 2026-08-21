import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { effectScope, ref } from 'vue';
import { useSessionMcumgr, MCUMGR_OWNER_ID } from '../../src/composables/useSessionMcumgr.ts';
import {
  DEFAULT_MCUMGR_CONFIG,
  encodeConsolePacket,
  encodeSmpRequest,
  encodeOsEcho,
  SMP_GROUP,
  SMP_OP,
} from '../../src/lib/mcumgr/index.ts';
import type { SerialSession } from '../../src/types/session.ts';
import type { SerialSendResult } from '../../src/types/serial.ts';
import type { SerialTransactionLeaseCoordinator } from '../../src/features/serial/application/serial-transaction-lease.ts';

test('useSessionMcumgr acquires the first-class lease owner and writes through it', async () => {
  const observers = new Set<(bytes: Uint8Array) => void>();
  const writes: Uint8Array[] = [];
  const session = ref({
    id: 's1',
    mcumgrConfig: { ...DEFAULT_MCUMGR_CONFIG, shellHistory: [] },
  } as SerialSession);
  const token = 'lease-token' as never;
  const serialTransactions = {
    acquire: vi.fn(async (ownerId: string) => {
      assert.equal(ownerId, MCUMGR_OWNER_ID);
      return { token, ownerId, generation: 1 };
    }),
    release: vi.fn(async () => ({ reason: 'released' })),
    write: vi.fn(async (_token: unknown, payload: Uint8Array) => {
      writes.push(payload);
      const result: SerialSendResult = {
        outcome: 'complete',
        requestedBytes: payload.length,
        sentBytes: payload.length,
      };
      queueMicrotask(() => {
        const request = encodeSmpRequest({
          version: 2,
          op: SMP_OP.write,
          group: SMP_GROUP.os,
          command: 0,
          sequence: 0,
          payload: encodeOsEcho('hi'),
        });
        const response = encodeSmpRequest({
          version: 2,
          op: SMP_OP.write,
          group: SMP_GROUP.os,
          command: 0,
          sequence: 0,
          payload: encodeOsEcho('hi'),
        });
        // Response op must be writeRsp. Build from the request header.
        const framed = encodeConsolePacket(
          Uint8Array.from([
            (0b01 << 3) | SMP_OP.writeRsp,
            0,
            0,
            6,
            0,
            0,
            0,
            0,
            0xa1,
            0x61,
            0x72,
            0x62,
            0x68,
            0x69,
          ]),
          127,
        );
        for (const observer of observers) observer(framed);
        void request;
        void response;
      });
      return result;
    }),
  } as unknown as SerialTransactionLeaseCoordinator<SerialSendResult>;

  const scope = effectScope();
  const mcumgr = scope.run(() =>
    useSessionMcumgr({
      session,
      serialTransactions,
      rawBytes: (callback) => {
        observers.add(callback);
        return () => observers.delete(callback);
      },
      isConnected: ref(true),
      setConfig: (patch) => {
        session.value.mcumgrConfig = { ...session.value.mcumgrConfig, ...patch };
      },
    }),
  );
  assert.ok(mcumgr);
  const echoed = await mcumgr.run('echo', (client) => client.echo('hi'));
  assert.equal(echoed, 'hi');
  assert.equal(serialTransactions.acquire.mock.calls[0]?.[0], 'mcumgr-client');
  assert.equal(serialTransactions.release.mock.calls.length, 1);
  assert.ok(writes[0] && writes[0][0] === 0x06 && writes[0][1] === 0x09);
  scope.stop();
});
