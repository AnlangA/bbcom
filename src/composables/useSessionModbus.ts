import { computed, ref, type Ref } from 'vue';
import { useMessage } from 'naive-ui';
import { useSessionStore } from '../stores/sessions';
import { useModbusMaster } from './useModbusMaster';
import { parseStream, type ModbusStreamRecord } from '../lib/modbus';
import {
  buildModbusWaveformChannelLabels,
  findAvailableModbusWaveformChannel,
  formatSessionModbusStatus,
  snapshotModbusStatus,
  type SessionModbusStatus,
} from '../lib/session-modbus-view';
import { t } from '../lib/i18n';
import type { ModbusRegister, SerialSession } from '../types';

/**
 * Bridges the Modbus master to a serial session and exposes the imperative
 * handlers the ModbusPanel calls (read/write all/row, replay, write-source
 * file picking, plot-in-waveform). Extracted from SessionView so the session
 * component stays a thin orchestrator.
 *
 * The master shares the serial port through `sendBytes`/`rawBytes` (serialized
 * TX, raw RX) and routes decoded samples into the waveform when its source mode
 * is 'register'. All handlers are no-op-safe when the session is disconnected.
 */
export interface UseSessionModbusOptions {
  session: Ref<SerialSession>;
  /** Serialized binary TX (shares the serial port's write chain). */
  sendBytes: (payload: Uint8Array) => Promise<boolean>;
  /** Subscribe to raw RX bytes; returns an unlisten fn. */
  rawBytes: (cb: (bytes: Uint8Array) => void) => () => void;
  /** Connected flag — the loop only runs while connected. */
  isConnected: Ref<boolean>;
  /** Waveform panel ref, so decoded register samples can be pushed into it. */
  waveformRef: Ref<{
    pushRegisterSample: (channel: number, value: number, timestamp?: number) => void;
  } | null>;
  /** Jump the view to the waveform (used by plot-in-waveform). */
  showWaveform: () => void;
}

export function useSessionModbus({
  session,
  sendBytes,
  rawBytes,
  isConnected,
  waveformRef,
  showWaveform,
}: UseSessionModbusOptions) {
  const sessionStore = useSessionStore();
  const message = useMessage();

  const configRef = computed(() => session.value.modbusConfig);
  const registersRef = computed(() => session.value.modbusRegisters);

  const modbusBusy = ref(false);
  const modbusStatus = ref<SessionModbusStatus>({ kind: 'idle' });
  const writeSourceName = ref<string | null>(null);
  // The hidden file input lives in SessionView's template; this ref lets the
  // "load" button click it. SessionView assigns the element via setInputEl().
  const writeSourceInput = ref<HTMLInputElement | null>(null);

  const master = useModbusMaster({
    sessionId: session.value.id,
    config: configRef,
    registers: registersRef,
    sendBytes,
    rawBytes,
    isConnected,
    onSamples: (samples) => {
      if (session.value.waveformSourceMode !== 'register') return;
      for (const s of samples) {
        if (s.channel === null) continue;
        waveformRef.value?.pushRegisterSample(s.channel, s.value, s.ts);
      }
    },
    onStatus: (s) => {
      modbusStatus.value = snapshotModbusStatus(s);
    },
  });

  const modbusStatusText = computed(() => formatSessionModbusStatus(modbusStatus.value, t));
  const modbusStatusClass = computed(() => modbusStatus.value.kind);
  const waveformChannelLabels = computed(() =>
    buildModbusWaveformChannelLabels(session.value.modbusRegisters),
  );

  function toggleWaveformSourceMode() {
    const next = session.value.waveformSourceMode === 'register' ? 'text' : 'register';
    sessionStore.setWaveformSourceMode(session.value.id, next);
  }

  async function readAll() {
    modbusBusy.value = true;
    try {
      // Batched sweep: contiguous rows share one FC03/04 request, serialized
      // against the poll loop via the master's busy guard.
      await master.readAll();
    } finally {
      modbusBusy.value = false;
    }
  }

  async function readRow(reg: ModbusRegister) {
    modbusBusy.value = true;
    try {
      await master.readOnce(reg);
    } finally {
      modbusBusy.value = false;
    }
  }

  async function sendAll() {
    modbusBusy.value = true;
    try {
      const res = await master.sendAll();
      if (res.sent > 0) {
        message.success(t('modbus.sendAll') + ` (${res.ok}/${res.sent})`);
      }
    } finally {
      modbusBusy.value = false;
    }
  }

  async function sendRow(reg: ModbusRegister): Promise<boolean> {
    modbusBusy.value = true;
    try {
      // Result is returned to ModbusPanel so it can flash the row on success or
      // toast on failure — closer to the row the user acted on than a global bar.
      return await master.sendRow(reg);
    } finally {
      modbusBusy.value = false;
    }
  }

  function startReplay(records: ModbusStreamRecord[]) {
    master.startReplay(records);
  }
  function stopReplay() {
    master.stopReplay();
  }

  // --- Periodic-write data source (.bbreg) ---
  // The source is parsed from the picked file then handed to the master, which
  // groups records into per-(slave,writeFc,addr) value sequences.
  function pickWriteSource() {
    writeSourceInput.value?.click();
  }
  function loadWriteSource(records: ModbusStreamRecord[], name: string) {
    master.loadWriteSource(records, name);
    writeSourceName.value = name;
    message.success(t('modbus.writeSourceLoaded', { count: records.length, name }));
  }
  function clearWriteSource() {
    master.clearWriteSource();
    writeSourceName.value = null;
  }
  function onWriteSourcePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const records = parseStream(text);
      if (records.length === 0) {
        message.warning(t('modbus.empty'));
        return;
      }
      loadWriteSource(records, file.name);
    };
    reader.readAsText(file);
    input.value = ''; // allow re-picking the same file
  }

  /** Plot-in-waveform: assign a channel, set source mode, jump to the waveform. */
  function plotInWaveform(reg: ModbusRegister) {
    let ch = reg.waveformChannel;
    if (ch === null) {
      // Assign the next free channel (0..7).
      ch = findAvailableModbusWaveformChannel(session.value.modbusRegisters);
      if (ch === null) return; // all channels taken
      sessionStore.updateModbusRegister(session.value.id, reg.id, { waveformChannel: ch });
    }
    sessionStore.setWaveformSourceMode(session.value.id, 'register');
    showWaveform();
  }

  return {
    // state
    modbusBusy,
    modbusStatusText,
    modbusStatusClass,
    waveformChannelLabels,
    writeSourceInput,
    writeSourceName,
    master,
    // handlers
    toggleWaveformSourceMode,
    readAll,
    readRow,
    sendAll,
    sendRow,
    startReplay,
    stopReplay,
    pickWriteSource,
    loadWriteSource,
    clearWriteSource,
    onWriteSourcePicked,
    plotInWaveform,
  };
}
