import { onUnmounted, ref, watch, type Ref } from 'vue';
import {
  decodeValue,
  isBitFc,
  isReadFc,
  registerSpan,
  type ModbusResponse,
  type ReadFc,
} from '../lib/modbus';
import {
  parseFrame,
  readRequest,
  scanResponse,
  writeMultipleCoilsRequest,
  writeMultipleRegistersRequest,
  writeSingleCoilRequest,
  writeSingleRegisterRequest,
  type ModbusTransport,
} from '../lib/modbus-transport';
import { useSessionStore } from '../stores/sessions';
import type { ModbusMasterConfig, ModbusRegister } from '../types';

/** A decoded value ready to apply to a register row + feed the waveform. */
export interface ModbusSample {
  registerId: string;
  /** Waveform channel from the row, or null. */
  channel: number | null;
  value: number;
  ts: number;
}

/** A grouped, contiguous read request the master will emit in one transaction. */
interface ReadBatch {
  slave: number;
  fc: ReadFc;
  /** Starting address (coil or register). */
  start: number;
  /** Number of coils or 16-bit registers to read. */
  count: number;
  /** Rows covered by this batch, with each row's offset within the read window. */
  rows: Array<{ reg: ModbusRegister; offset: number }>;
}

/** A grouped, contiguous write request. */
interface WriteBatch {
  slave: number;
  /** Single FC variant if the batch holds exactly one row, else the multiple FC. */
  fc: 0x05 | 0x06 | 0x0f | 0x10;
  start: number;
  /** Row payload: bit (coils) or 16-bit word (registers). */
  rows: ModbusRegister[];
}

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
  | { kind: 'timeout' }
  | { kind: 'exception'; code: number }
  | { kind: 'crc-error' }
  | { kind: 'error'; message: string };

/**
 * Per-session Modbus master. Owns the poll loop (READ mode) and the imperative
 * read/write API (used by the table). All TX goes through `sendBytes` so it
 * serializes with the rest of the session's writes; RX arrives via `rawBytes`
 * as exact chunks, which are accumulated and scanned for complete frames.
 *
 * The loop is a self-rescheduling `setTimeout`: each tick awaits every batch's
 * response (or its timeout) before scheduling the next, so requests never
 * overlap — the correct model for RTU, which has no transaction IDs.
 */
export function useModbusMaster(options: UseModbusMasterOptions) {
  const { sessionId, config, registers, sendBytes, rawBytes, isConnected } = options;
  // Hold the options that may be swapped after construction (waveform sink).
  const opts = { ...options };
  // Acquire the store inside setup so it binds to the active Pinia instance.
  const sessionStore = useSessionStore();

  const running = ref(false);
  const status = ref<ModbusMasterStatus>({ kind: 'idle' });

  // RX accumulation state. One outstanding request at a time (RTU is
  // half-duplex; the next request isn't sent until this resolves or times out).
  let rxBuffer: Uint8Array = new Uint8Array(0);
  let pending: {
    batch: ReadBatch | WriteBatch;
    resolve: (response: ModbusResponse | null) => void;
    timer: ReturnType<typeof setTimeout>;
    /** Expected PDU length for the response (PDU transport needs this). */
    expectedLen?: number;
  } | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let unlistenRx: (() => void) | null = null;
  let stopped = false;

  function emitStatus(s: ModbusMasterStatus) {
    status.value = s;
    opts.onStatus?.(s);
  }

  // --- RX subscription ---------------------------------------------------

  function handleRx(bytes: Uint8Array) {
    if (!pending) {
      // Unsolicited bytes (e.g. late echo, noise). Drop to avoid framing drift.
      rxBuffer = new Uint8Array(0);
      return;
    }
    const concat = new Uint8Array(rxBuffer.length + bytes.length);
    concat.set(rxBuffer, 0);
    concat.set(bytes, rxBuffer.length);
    rxBuffer = concat;

    const transport: ModbusTransport = config.value.transport;
    const { frames, remainder } = scanResponse(transport, rxBuffer, pending.expectedLen);
    rxBuffer = remainder;
    if (frames.length > 0) {
      const response = parseFrame(transport, frames[0]);
      // Resolve + clear pending; any extra frames are spurious — drop them.
      clearTimeout(pending.timer);
      const p = pending;
      pending = null;
      p.resolve(response);
    }
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

  function expectedReadResponseLength(batch: ReadBatch, transport: ModbusTransport): number | undefined {
    // RTU frames itself via CRC; only PDU transport needs an explicit length.
    if (transport === 'rtu') return undefined;
    if (isBitFc(batch.fc)) {
      // [addr][fc][byteCount][data…] — but PDU drops addr, so [fc][byteCount][data…].
      const byteCount = Math.ceil(batch.count / 8);
      return 2 + byteCount;
    }
    return 2 + batch.count * 2;
  }

  function expectedWriteResponseLength(_batch: WriteBatch, transport: ModbusTransport): number | undefined {
    if (transport === 'rtu') return undefined;
    // write-ack echo: [fc][startHi][startLo][countHi][countLo] = 5 (PDU, no addr).
    return 5;
  }

  /** Send a framed request and resolve with the parsed response (or null on timeout). */
  function transact(
    batch: ReadBatch | WriteBatch,
    buildWire: () => Uint8Array,
    expectedLen: number | undefined,
  ): Promise<ModbusResponse | null> {
    return new Promise<ModbusResponse | null>((resolve) => {
      const timeoutMs = config.value.timeoutMs;
      const timer = setTimeout(() => {
        if (pending && pending.batch === batch) {
          pending = null;
          rxBuffer = new Uint8Array(0); // resync on timeout
          emitStatus({ kind: 'timeout' });
        }
        resolve(null);
      }, timeoutMs);
      pending = { batch, resolve, timer, expectedLen };
      rxBuffer = new Uint8Array(0);
      void sendBytes(buildWire()).then((ok) => {
        if (!ok) {
          if (pending && pending.batch === batch) {
            clearTimeout(pending.timer);
            pending = null;
          }
          resolve(null);
        }
      });
    });
  }

  // --- Batching ----------------------------------------------------------

  /** Group read-enabled rows into contiguous read batches. */
  function buildReadBatches(regs: ModbusRegister[]): ReadBatch[] {
    // Only read FCs participate in the poll loop.
    const readable = regs
      .filter((r) => isReadFc(r.functionCode))
      .slice()
      .sort(
        (a, b) =>
          a.slaveAddress - b.slaveAddress ||
          a.functionCode - b.functionCode ||
          a.address - b.address,
      );
    const batches: ReadBatch[] = [];
    for (const reg of readable) {
      const fc = reg.functionCode as ReadFc;
      const span = isBitFc(fc) ? 1 : registerSpan(reg.type);
      // Try to extend the last batch when same slave/fc and address-contiguous.
      const last = batches[batches.length - 1];
      if (
        last &&
        last.slave === reg.slaveAddress &&
        last.fc === fc &&
        last.start + last.count === reg.address
      ) {
        last.count += span;
        last.rows.push({ reg, offset: reg.address - last.start });
      } else {
        batches.push({
          slave: reg.slaveAddress,
          fc,
          start: reg.address,
          count: span,
          rows: [{ reg, offset: 0 }],
        });
      }
    }
    // Clamp each batch to the Modbus per-request max (2000 coils / 125 regs).
    const cap = (b: ReadBatch) => {
      const max = isBitFc(b.fc) ? 2000 : 125;
      if (b.count <= max) return [b];
      // Split oversized batches at the max boundary.
      const out: ReadBatch[] = [];
      let remaining = b.rows;
      let cursor = b.start;
      while (remaining.length > 0) {
        const sliceRows: typeof b.rows = [];
        let used = 0;
        for (const row of remaining) {
          const span = isBitFc(b.fc) ? 1 : registerSpan(row.reg.type);
          if (used + span > max) break;
          sliceRows.push({ reg: row.reg, offset: row.offset - (cursor - b.start) });
          used += span;
        }
        out.push({ slave: b.slave, fc: b.fc, start: cursor, count: used, rows: sliceRows });
        cursor += used;
        remaining = remaining.slice(sliceRows.length);
      }
      return out;
    };
    return batches.flatMap(cap);
  }

  /** Group write-enabled rows into contiguous write batches. */
  function buildWriteBatches(regs: ModbusRegister[]): WriteBatch[] {
    const writable = regs
      .filter((r) => r.functionCode === 0x05 || r.functionCode === 0x06)
      .filter((r) => r.value !== null && Number.isFinite(r.value))
      .slice()
      .sort(
        (a, b) =>
          a.slaveAddress - b.slaveAddress || a.functionCode - b.functionCode || a.address - b.address,
      );
    const batches: WriteBatch[] = [];
    for (const reg of writable) {
      const isCoil = reg.functionCode === 0x05;
      const span = isCoil ? 1 : registerSpan(reg.type);
      const last = batches[batches.length - 1];
      // A single row alone uses the single FC; contiguous same-slave rows
      // upgrade the batch to the multiple FC (0F/10).
      if (
        last &&
        last.slave === reg.slaveAddress &&
        isCoil === (last.fc === 0x0f) &&
        last.start + last.rows.length === reg.address
      ) {
        last.rows.push(reg);
        last.fc = isCoil ? 0x0f : 0x10;
      } else {
        batches.push({
          slave: reg.slaveAddress,
          fc: isCoil ? 0x05 : 0x06,
          start: reg.address,
          rows: [reg],
        });
        // span kept for clarity; single-row batches use the single FC regardless.
        void span;
      }
    }
    return batches;
  }

  // --- Poll loop (READ mode) --------------------------------------------

  async function pollOnce() {
    const regs = registers.value;
    const transport = config.value.transport;
    const batches = buildReadBatches(regs);
    if (batches.length === 0) {
      emitStatus({ kind: 'idle' });
      return;
    }
    emitStatus({ kind: 'polling', count: batches.length });
    const samples: ModbusSample[] = [];
    const valueUpdates: Array<{ id: string; value: number; valueTs: number }> = [];
    const now = Date.now();

    for (const batch of batches) {
      if (stopped) return;
      const wire = readRequest(transport, batch.slave, batch.fc, batch.start, batch.count);
      const expectedLen = expectedReadResponseLength(batch, transport);
      const response = await transact(batch, () => wire, expectedLen);
      if (!response) continue; // timeout / send failure → skip, next tick retries
      if (response.kind === 'exception') {
        emitStatus({ kind: 'exception', code: response.code });
        continue;
      }
      if (transport === 'rtu' && response.kind === 'read-regs') {
        // CRC already verified by parseFrame for RTU; nothing extra to do.
      }
      if (response.kind === 'read-bits') {
        for (const { reg, offset } of batch.rows) {
          const bit = response.bits[offset] ?? false;
          const value = bit ? 1 : 0;
          valueUpdates.push({ id: reg.id, value, valueTs: now });
          if (reg.waveformChannel !== null) {
            samples.push({ registerId: reg.id, channel: reg.waveformChannel, value, ts: now });
          }
        }
      } else if (response.kind === 'read-regs') {
        for (const { reg } of batch.rows) {
          const span = registerSpan(reg.type);
          const startIdx = reg.address - batch.start;
          const window = response.regs.slice(startIdx, startIdx + span);
          if (window.length < span) continue;
          const value = decodeValue(reg.type, window);
          valueUpdates.push({ id: reg.id, value, valueTs: now });
          if (reg.waveformChannel !== null) {
            samples.push({ registerId: reg.id, channel: reg.waveformChannel, value, ts: now });
          }
        }
      }
    }

    if (valueUpdates.length > 0) {
      sessionStore.setModbusRegisterValues(sessionId, valueUpdates);
    }
    if (samples.length > 0) {
      opts.onSamples?.(samples);
    }
    if (status.value.kind === 'polling') emitStatus({ kind: 'idle' });
  }

  function scheduleNext() {
    if (stopped) return;
    if (!shouldRun()) return;
    const interval = Math.max(100, config.value.pollIntervalMs);
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (stopped) return;
      await pollOnce();
      scheduleNext();
    }, interval);
  }

  function shouldRun(): boolean {
    return (
      !stopped &&
      config.value.enabled &&
      isConnected.value &&
      config.value.tableMode === 'read'
    );
  }

  function start() {
    if (running.value) return;
    running.value = true;
    stopped = false;
    startListening();
    scheduleNext();
  }

  function stop() {
    stopped = true;
    running.value = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
    }
    rxBuffer = new Uint8Array(0);
    stopListening();
    emitStatus({ kind: 'idle' });
  }

  // --- Imperative API (table buttons) -----------------------------------

  /** Read a single row on demand, regardless of table mode. */
  async function readOnce(reg: ModbusRegister): Promise<number | null> {
    if (!isReadFc(reg.functionCode)) return null;
    const fc = reg.functionCode as ReadFc;
    const span = isBitFc(fc) ? 1 : registerSpan(reg.type);
    const transport = config.value.transport;
    const batch: ReadBatch = {
      slave: reg.slaveAddress,
      fc,
      start: reg.address,
      count: span,
      rows: [{ reg, offset: 0 }],
    };
    startListening();
    const wire = readRequest(transport, batch.slave, batch.fc, batch.start, batch.count);
    const expectedLen = expectedReadResponseLength(batch, transport);
    const response = await transact(batch, () => wire, expectedLen);
    if (!response) return null;
    if (response.kind === 'exception') {
      emitStatus({ kind: 'exception', code: response.code });
      return null;
    }
    if (response.kind === 'read-bits') {
      const value = response.bits[0] ? 1 : 0;
      sessionStore.setModbusRegisterValues(sessionId, [
        { id: reg.id, value, valueTs: Date.now() },
      ]);
      return value;
    }
    if (response.kind === 'read-regs') {
      const value = decodeValue(reg.type, response.regs.slice(0, span));
      sessionStore.setModbusRegisterValues(sessionId, [
        { id: reg.id, value, valueTs: Date.now() },
      ]);
      return value;
    }
    return null;
  }

  /** Write a single row's value (FC05/06 single, or batched if contiguous). */
  async function sendRow(reg: ModbusRegister): Promise<boolean> {
    if (reg.value === null || !Number.isFinite(reg.value)) return false;
    const transport = config.value.transport;
    if (reg.functionCode === 0x05) {
      const wire = writeSingleCoilRequest(transport, reg.slaveAddress, reg.address, reg.value !== 0);
      const batch: WriteBatch = { slave: reg.slaveAddress, fc: 0x05, start: reg.address, rows: [reg] };
      const expectedLen = expectedWriteResponseLength(batch, transport);
      const response = await transact(batch, () => wire, expectedLen);
      return response?.kind === 'write-ack';
    }
    if (reg.functionCode === 0x06) {
      const wire = writeSingleRegisterRequest(transport, reg.slaveAddress, reg.address, reg.value);
      const batch: WriteBatch = { slave: reg.slaveAddress, fc: 0x06, start: reg.address, rows: [reg] };
      const expectedLen = expectedWriteResponseLength(batch, transport);
      const response = await transact(batch, () => wire, expectedLen);
      return response?.kind === 'write-ack';
    }
    return false;
  }

  /** Write every writable row, auto-batching contiguous ones into FC0F/FC10. */
  async function sendAll(): Promise<{ sent: number; ok: number }> {
    const batches = buildWriteBatches(registers.value);
    const transport = config.value.transport;
    startListening();
    let ok = 0;
    let sent = 0;
    for (const batch of batches) {
      if (stopped) break;
      sent += batch.rows.length;
      let wire: Uint8Array;
      if (batch.fc === 0x05 || batch.fc === 0x0f) {
        const bits = batch.rows.map((r) => (r.value ?? 0) !== 0);
        wire =
          batch.rows.length === 1
            ? writeSingleCoilRequest(transport, batch.slave, batch.start, bits[0])
            : writeMultipleCoilsRequest(transport, batch.slave, batch.start, bits);
      } else {
        const values = batch.rows.map((r) => r.value ?? 0);
        wire =
          batch.rows.length === 1
            ? writeSingleRegisterRequest(transport, batch.slave, batch.start, values[0])
            : writeMultipleRegistersRequest(transport, batch.slave, batch.start, values);
      }
      const expectedLen = expectedWriteResponseLength(batch, transport);
      const response = await transact(batch, () => wire, expectedLen);
      if (response?.kind === 'write-ack') ok += batch.rows.length;
      else if (response?.kind === 'exception') emitStatus({ kind: 'exception', code: response.code });
    }
    return { sent, ok };
  }

  // --- Lifecycle ---------------------------------------------------------

  // Start/stop on enable + connectivity changes.
  watch(
    () => [config.value.enabled, isConnected.value, config.value.tableMode] as const,
    ([enabled, connected, mode]) => {
      if (enabled && connected) {
        // Listening is useful in both modes (sendRow needs responses too).
        startListening();
        if (mode === 'read') scheduleNext();
      } else {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      }
    },
    { immediate: true },
  );

  onUnmounted(() => stop());

  return {
    running,
    status,
    start,
    stop,
    readOnce,
    sendRow,
    sendAll,
    /** Allow the waveform sink to be attached after construction. */
    setOnSamples: (cb: (samples: ModbusSample[]) => void) => {
      opts.onSamples = cb;
    },
  };
}
