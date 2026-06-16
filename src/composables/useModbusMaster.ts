import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { isBitFc, isReadFc, type ModbusResponse, type ReadFc } from '../lib/modbus';
import {
  buildModbusReadBatches,
  buildModbusWriteBatches,
  encodeModbusCoilWriteValues,
  encodeModbusRegisterWriteValues,
  modbusReadRowCount,
  type ModbusReadBatch,
  type ModbusWriteBatch,
} from '../lib/modbus-batches';
import {
  readRequest,
  writeMultipleCoilsRequest,
  writeMultipleRegistersRequest,
  writeSingleCoilRequest,
  writeSingleRegisterRequest,
  type ModbusTransport,
} from '../lib/modbus-transport';
import { ModbusBackoff } from '../lib/modbus-backoff';
import { ModbusLoopCoordinator } from '../lib/modbus-loop-coordinator';
import {
  isExpectedModbusWriteAck,
  mapModbusReadResponse,
  type ModbusSample,
} from '../lib/modbus-response-mapper';
import { ModbusReplayCoordinator } from '../lib/modbus-replay-coordinator';
import {
  ModbusTransactionRunner,
  type ModbusTransactionStatus,
} from '../lib/modbus-transaction-runner';
import { isPeriodicWritableFc, ModbusWriteSource } from '../lib/modbus-write-source';
import type { ModbusStreamRecord } from '../lib/modbus-stream';
import { useSessionStore } from '../stores/sessions';
import type { ModbusMasterConfig, ModbusRegister } from '../types';

export type { ModbusSample } from '../lib/modbus-response-mapper';

interface UseModbusMasterOptions {
  sessionId: string;
  config: Ref<ModbusMasterConfig>;
  registers: Ref<ModbusRegister[]>;
  /** Serialized binary TX (shares the serial port's write chain). */
  sendBytes: (payload: Uint8Array) => Promise<boolean>;
  /** Subscribe to raw RX bytes; returns an unlisten fn. */
  rawBytes: (cb: (bytes: Uint8Array) => void) => () => void;
  /** Connected flag — the loop only runs while connected. */
  isConnected: Ref<boolean>;
  /** Optional sinks for decoded samples (the waveform subscribes here). */
  onSamples?: (samples: ModbusSample[]) => void;
  /** Optional sink for master status changes (timeouts, exceptions). */
  onStatus?: (status: ModbusMasterStatus) => void;
}

export type ModbusMasterStatus =
  | { kind: 'idle' }
  | { kind: 'polling'; count: number }
  | { kind: 'writing'; count: number }
  | { kind: 'timeout' }
  | { kind: 'exception'; code: number }
  | { kind: 'crc-error' }
  | { kind: 'replaying'; remaining: number }
  | {
      kind: 'backoff';
      scope: 'read' | 'write';
      delayMs: number;
      consecutiveFailures: number;
    }
  | { kind: 'error'; message: string };

type PeriodicBackoffScope = 'read' | 'write';

interface TransactionOutcome {
  response: ModbusResponse | null;
  failure: ModbusTransactionStatus | null;
}

interface ReplayQueueItem {
  ts: number;
  reg: ModbusRegister;
  value: number;
}

/**
 * Per-session Modbus master. Owns two independent background loops plus the
 * imperative read/write API (used by the table):
 *  - **read loop** (`scheduleNextRead`/`pollOnce`): polls every row whose
 *    `periodicRead` is true on each tick (interval `pollIntervalMs`).
 *  - **write loop** (`scheduleNextWrite`/`writeOnce`): each tick advances the
 *    per-key cursor of the loaded `.bbreg` write data source and sends the next
 *    value to every row whose `periodicWrite` is true (interval `writeIntervalMs`).
 *
 * Each register's function code decides whether it reads or writes — there is no
 * global read/send mode. Read and write loops can run simultaneously because
 * both serialize on a single `busy` guard + single `pending` RX slot (RTU is
 * half-duplex; one outstanding request at a time).
 *
 * All TX goes through `sendBytes` so it serializes with the rest of the
 * session's writes; RX arrives via `rawBytes` as exact chunks, which are
 * accumulated and scanned for complete frames.
 */
export function useModbusMaster(options: UseModbusMasterOptions) {
  const { sessionId, config, registers, sendBytes, rawBytes, isConnected } = options;
  // Hold the options that may be swapped after construction (waveform sink).
  const opts = { ...options };
  // Acquire the store inside setup so it binds to the active Pinia instance.
  const sessionStore = useSessionStore();

  const running = ref(false);
  const status = ref<ModbusMasterStatus>({ kind: 'idle' });

  let unlistenRx: (() => void) | null = null;
  let stopped = false;
  let lastTransactionStatus: ModbusTransactionStatus | null = null;

  const replaying = ref(false);

  const writing = ref(false);
  const writeSource = new ModbusWriteSource();

  function emitStatus(s: ModbusMasterStatus) {
    status.value = s;
    opts.onStatus?.(s);
  }

  const readBackoff = new ModbusBackoff();
  const writeBackoff = new ModbusBackoff();

  const transactions = new ModbusTransactionRunner<ModbusReadBatch | ModbusWriteBatch>({
    sendBytes,
    getTransport: () => config.value.transport,
    getTimeoutMs: () => config.value.timeoutMs,
    onStatus: (transactionStatus) => {
      lastTransactionStatus = transactionStatus;
      emitStatus(transactionStatus);
    },
  });

  const loops = new ModbusLoopCoordinator({
    shouldRunRead,
    shouldRunWrite,
    getReadIntervalMs: () => readBackoff.delayFor(config.value.pollIntervalMs),
    getWriteIntervalMs: () => writeBackoff.delayFor(config.value.writeIntervalMs),
    runRead: pollOnce,
    runWrite: writeOnce,
  });

  const replayCoordinator = new ModbusReplayCoordinator<ReplayQueueItem>({
    runItem: runReplayItem,
    onProgress: (remaining) => {
      replaying.value = true;
      emitStatus({ kind: 'replaying', remaining });
    },
    onIdle: () => {
      if (replaying.value) {
        replaying.value = false;
        emitStatus({ kind: 'idle' });
      }
    },
    onError: (error) => {
      emitStatus({ kind: 'error', message: errorMessage(error) });
    },
  });

  /**
   * Run an on-demand operation with the busy guard held. While held, neither
   * background loop arms a new tick, so on-demand ops and the loops can't race
   * for the single `pending` slot.
   */
  async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
    return loops.runExclusive(fn);
  }

  // --- RX subscription ---------------------------------------------------

  function handleRx(bytes: Uint8Array) {
    transactions.receive(bytes);
  }

  function startListening() {
    if (unlistenRx) return;
    unlistenRx = rawBytes(handleRx);
  }

  function stopListening() {
    if (unlistenRx) {
      unlistenRx();
      unlistenRx = null;
    }
  }

  // --- Transaction core --------------------------------------------------

  function expectedReadResponseLength(
    batch: ModbusReadBatch,
    transport: ModbusTransport,
  ): number | undefined {
    // RTU frames itself via CRC; only PDU transport needs an explicit length.
    if (transport === 'rtu') return undefined;
    if (isBitFc(batch.fc)) {
      // [addr][fc][byteCount][data…] — but PDU drops addr, so [fc][byteCount][data…].
      const byteCount = Math.ceil(batch.count / 8);
      return 2 + byteCount;
    }
    return 2 + batch.count * 2;
  }

  function expectedWriteResponseLength(
    _batch: ModbusWriteBatch,
    transport: ModbusTransport,
  ): number | undefined {
    if (transport === 'rtu') return undefined;
    // write-ack echo: [fc][startHi][startLo][countHi][countLo] = 5 (PDU, no addr).
    return 5;
  }

  /** Send a framed request and resolve with the parsed response (or null on timeout). */
  async function transact(
    batch: ModbusReadBatch | ModbusWriteBatch,
    buildWire: () => Uint8Array,
    expectedLen: number | undefined,
    periodicScope?: PeriodicBackoffScope,
  ): Promise<ModbusResponse | null> {
    const outcome = await transactDetailed(batch, buildWire, expectedLen);
    if (periodicScope) recordPeriodicOutcome(periodicScope, outcome);
    return outcome.response;
  }

  async function transactDetailed(
    batch: ModbusReadBatch | ModbusWriteBatch,
    buildWire: () => Uint8Array,
    expectedLen: number | undefined,
  ): Promise<TransactionOutcome> {
    lastTransactionStatus = null;
    const response = await transactions.transact(batch, buildWire, expectedLen);
    if (response) resetBackoffs();
    return { response, failure: response ? null : lastTransactionStatus };
  }

  function recordPeriodicOutcome(scope: PeriodicBackoffScope, outcome: TransactionOutcome): void {
    const backoff = scope === 'read' ? readBackoff : writeBackoff;
    if (outcome.response) {
      backoff.recordSuccess();
      return;
    }
    if (!shouldTrackBackoff(outcome.failure)) return;

    backoff.recordFailure();
    if (!backoff.isBackingOff()) return;

    const baseDelayMs =
      scope === 'read' ? config.value.pollIntervalMs : config.value.writeIntervalMs;
    emitStatus({
      kind: 'backoff',
      scope,
      delayMs: backoff.delayFor(baseDelayMs),
      consecutiveFailures: backoff.getConsecutiveFailures(),
    });
  }

  function shouldTrackBackoff(failure: ModbusTransactionStatus | null): boolean {
    return (
      !stopped &&
      config.value.enabled &&
      isConnected.value &&
      (failure?.kind === 'timeout' || failure?.kind === 'error')
    );
  }

  function resetBackoffs(): void {
    readBackoff.reset();
    writeBackoff.reset();
  }

  /**
   * Send one write batch and resolve with the ack count. Factored out of
   * `sendAll` so the periodic write loop shares the exact same wire logic.
   * Caller must hold the busy guard.
   */
  async function sendWriteBatches(
    batches: ModbusWriteBatch[],
    periodicScope?: PeriodicBackoffScope,
  ): Promise<{ sent: number; ok: number }> {
    const transport = config.value.transport;
    let ok = 0;
    let sent = 0;
    for (const batch of batches) {
      if (stopped) break;
      sent += batch.rows.length;
      let wire: Uint8Array;
      if (batch.kind === 'coil') {
        const bits = encodeModbusCoilWriteValues(batch);
        wire =
          batch.fc === 0x05
            ? writeSingleCoilRequest(transport, batch.slave, batch.start, bits[0])
            : writeMultipleCoilsRequest(transport, batch.slave, batch.start, bits);
      } else {
        const values = encodeModbusRegisterWriteValues(batch);
        wire =
          batch.fc === 0x06
            ? writeSingleRegisterRequest(transport, batch.slave, batch.start, values[0])
            : writeMultipleRegistersRequest(transport, batch.slave, batch.start, values);
      }
      const expectedLen = expectedWriteResponseLength(batch, transport);
      const response = await transact(batch, () => wire, expectedLen, periodicScope);
      if (isExpectedModbusWriteAck(response, batch, transport)) ok += batch.rows.length;
      else if (response?.kind === 'exception')
        emitStatus({ kind: 'exception', code: response.code });
    }
    return { sent, ok };
  }

  // --- Read loop ---------------------------------------------------------

  async function pollOnce() {
    // Only rows opted into periodic reading are polled.
    const regs = registers.value.filter((r) => r.periodicRead);
    const transport = config.value.transport;
    const batches = buildModbusReadBatches(regs);
    if (batches.length === 0) {
      emitStatus({ kind: 'idle' });
      return;
    }
    emitStatus({ kind: 'polling', count: batches.length });
    const samples: ModbusSample[] = [];
    const valueUpdates: Array<{
      id: string;
      value: number;
      values?: number[] | null;
      valueTs: number;
    }> = [];
    const now = Date.now();

    for (const batch of batches) {
      if (stopped) return;
      const wire = readRequest(transport, batch.slave, batch.fc, batch.start, batch.count);
      const expectedLen = expectedReadResponseLength(batch, transport);
      const response = await transact(batch, () => wire, expectedLen, 'read');
      if (!response) continue; // timeout / send failure → skip, next tick retries
      if (response.kind === 'exception') {
        emitStatus({ kind: 'exception', code: response.code });
        continue;
      }
      const mapped = mapModbusReadResponse(batch, response, now);
      valueUpdates.push(...mapped.valueUpdates);
      samples.push(...mapped.samples);
    }

    if (valueUpdates.length > 0) {
      sessionStore.setModbusRegisterValues(sessionId, valueUpdates);
    }
    if (samples.length > 0) {
      opts.onSamples?.(samples);
    }
    if (status.value.kind === 'polling') emitStatus({ kind: 'idle' });
  }

  function shouldRunRead(): boolean {
    return (
      !stopped &&
      config.value.enabled &&
      isConnected.value &&
      registers.value.some((r) => r.periodicRead && isReadFc(r.functionCode))
    );
  }

  // --- Write loop (periodic write data source) ---------------------------

  /**
   * Load a `.bbreg` stream as the periodic-write data source. Records are
   * grouped into per-key value sequences (keyed by `slave:writeFc:addr`, with
   * the FC-mapping FC03→FC06 / FC01→FC05 so recorded reads can drive writes).
   * A row opts in via `periodicWrite`; each write tick advances its cursor and
   * sends the next value, wrapping to the start at the end (fixed-interval loop).
   */
  function loadWriteSource(records: ModbusStreamRecord[], name: string): void {
    writeSource.load(records, name);
  }

  function clearWriteSource(): void {
    writeSource.clear();
  }

  async function writeOnce() {
    const targets = writeSource.nextTargets(registers.value);
    if (targets.length === 0) {
      if (status.value.kind === 'writing') emitStatus({ kind: 'idle' });
      return;
    }

    // Mirror the loaded value into the table (runtime-only) so the UI shows
    // what is being pushed, then batch-send exactly like sendAll.
    const now = Date.now();
    sessionStore.setModbusRegisterValues(
      sessionId,
      targets.map((t) => ({ id: t.reg.id, value: t.value, values: null, valueTs: now })),
    );
    emitStatus({ kind: 'writing', count: targets.length });
    const regsWithValues = targets.map((t) => ({ ...t.reg, value: t.value }));
    writing.value = true;
    try {
      await sendWriteBatches(buildModbusWriteBatches(regsWithValues), 'write');
    } finally {
      writing.value = false;
      if (status.value.kind === 'writing') emitStatus({ kind: 'idle' });
    }
  }

  function shouldRunWrite(): boolean {
    return (
      !stopped &&
      config.value.enabled &&
      isConnected.value &&
      registers.value.some((r) => r.periodicWrite && isPeriodicWritableFc(r.functionCode))
    );
  }

  function clearWritingState() {
    if (writing.value) {
      writing.value = false;
    }
  }

  function start() {
    if (running.value) return;
    running.value = true;
    stopped = false;
    resetBackoffs();
    startListening();
    loops.start();
  }

  function stop() {
    stopped = true;
    running.value = false;
    loops.stop();
    stopReplay();
    clearWritingState();
    resetBackoffs();
    transactions.cancel();
    stopListening();
    emitStatus({ kind: 'idle' });
  }

  // --- Imperative API (table buttons) -----------------------------------

  /** Read a single row on demand, regardless of table mode. */
  async function readOnce(reg: ModbusRegister): Promise<number | null> {
    if (!isReadFc(reg.functionCode)) return null;
    const fc = reg.functionCode as ReadFc;
    const count = modbusReadRowCount(reg);
    const transport = config.value.transport;
    const batch: ModbusReadBatch = {
      slave: reg.slaveAddress,
      fc,
      start: reg.address,
      count,
      rows: [{ reg, offset: 0 }],
    };
    startListening();
    return withBusy(async () => {
      const wire = readRequest(transport, batch.slave, batch.fc, batch.start, batch.count);
      const expectedLen = expectedReadResponseLength(batch, transport);
      const response = await transact(batch, () => wire, expectedLen);
      if (!response) return null;
      if (response.kind === 'exception') {
        emitStatus({ kind: 'exception', code: response.code });
        return null;
      }
      const mapped = mapModbusReadResponse(batch, response, Date.now());
      if (mapped.valueUpdates.length === 0) return null;
      sessionStore.setModbusRegisterValues(sessionId, mapped.valueUpdates);
      return mapped.valueUpdates[0].value;
    });
  }

  /**
   * Read every periodic-read row in one batched sweep (contiguous rows share a
   * single FC03/04 request). Serialized against the read loop via the busy guard
   * so on-demand reads can't interleave with poll ticks.
   */
  async function readAll(): Promise<void> {
    startListening();
    await withBusy(() => pollOnce());
    // Re-arm the read loop in case it was deferred while we held the bus.
    loops.resume();
  }

  /** Write a single row's value (FC05/06/10). */
  async function sendRow(reg: ModbusRegister): Promise<boolean> {
    const batches = buildModbusWriteBatches([reg]);
    if (batches.length === 0) return false;
    startListening();
    return withBusy(async () => {
      const { ok } = await sendWriteBatches(batches);
      return ok === 1;
    });
  }

  /** Write every writable row; only explicit FC10 register rows batch together. */
  async function sendAll(): Promise<{ sent: number; ok: number }> {
    startListening();
    return withBusy(() => sendWriteBatches(buildModbusWriteBatches(registers.value)));
  }

  // --- Replay (.bbreg stream → registers) --------------------------------

  /**
   * Replay a loaded `.bbreg` stream onto the device's registers. Each record is
   * matched to a write-row by `(slave, fc, addr)`, sorted by timestamp, and
   * written at its recorded inter-arrival cadence via `sendRow` (which respects
   * the busy guard + serialized TX). Honors the per-request timeout; a missing
   * match or an unreceptive slave skips the record without aborting the replay.
   */
  function startReplay(records: ModbusStreamRecord[]): void {
    const byKey = new Map<string, ModbusRegister>();
    for (const reg of registers.value) {
      if (reg.functionCode === 0x05 || reg.functionCode === 0x06 || reg.functionCode === 0x10) {
        byKey.set(`${reg.slaveAddress}:${reg.functionCode}:${reg.address}`, reg);
      }
    }
    const queue: ReplayQueueItem[] = [];
    for (const rec of records) {
      // FC03 read records replay onto the matching FC06 write row at the same
      // address (a recorded sensor value becomes the setpoint to push back).
      const writeFc = rec.fc === 0x03 ? 0x06 : rec.fc === 0x01 ? 0x05 : rec.fc;
      const reg = byKey.get(`${rec.slave}:${writeFc}:${rec.addr}`);
      if (!reg) continue;
      queue.push({ ts: rec.t, reg, value: rec.value });
    }
    if (queue.length === 0) {
      replayCoordinator.stop();
      return;
    }
    startListening();
    replayCoordinator.start(queue);
  }

  async function runReplayItem(item: ReplayQueueItem): Promise<void> {
    // Write the value; skip on failure (timeout/no-ack) but keep replaying.
    sessionStore.updateModbusRegister(sessionId, item.reg.id, {
      value: item.value,
      values: null,
      valueTs: Date.now(),
    });
    await sendRow({ ...item.reg, value: item.value });
  }

  function stopReplay(): void {
    replayCoordinator.stop();
  }

  // --- Lifecycle ---------------------------------------------------------

  // Start/stop the background loops on enable + connectivity changes. Both
  // loops are independent: a row opts in via periodicRead / periodicWrite.
  watch(
    () => [config.value.enabled, isConnected.value] as const,
    ([enabled, connected]) => {
      if (enabled && connected) {
        // Listening is useful for reads, writes, and replay (all need acks).
        startListening();
        loops.resume();
      } else {
        loops.pause();
        resetBackoffs();
        if (!connected) {
          stopReplay();
          transactions.cancel({ kind: 'error', message: 'connection closed' });
          stopListening();
        }
      }
    },
    { immediate: true },
  );

  onScopeDispose(() => stop());

  return {
    running,
    replaying,
    writing,
    status,
    start,
    stop,
    readOnce,
    readAll,
    sendRow,
    sendAll,
    startReplay,
    stopReplay,
    loadWriteSource,
    clearWriteSource,
    /** Current write data-source filename (null when none loaded). */
    getWriteSourceName: () => writeSource.getName(),
    /** Allow the waveform sink to be attached after construction. */
    setOnSamples: (cb: (samples: ModbusSample[]) => void) => {
      opts.onSamples = cb;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
