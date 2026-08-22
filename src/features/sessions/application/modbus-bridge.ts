import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useSessionDocument } from '@/features/sessions/ports/session-ports';
import { useModbusMaster } from './use-modbus-master';
import { parseStream, type ModbusStreamRecord } from '@/lib/modbus';
import {
  buildModbusWaveformChannelLabels,
  findAvailableModbusWaveformChannel,
  formatSessionModbusStatus,
  snapshotModbusStatus,
  type SessionModbusStatus,
} from '@/lib/session-modbus-view';
import { t } from '@/lib/i18n';
import type { ModbusRegister, SerialSendResult, SerialSession, SerialWriteOptions } from '@/types';
import type { ApplicationNotificationPort } from '@/features/platform/application/application-notifications';

const NOOP_NOTIFICATIONS: ApplicationNotificationPort = Object.freeze({
  info: () => undefined,
  success: () => undefined,
  warning: () => undefined,
  error: () => undefined,
});

export interface ModbusBridgeCreateOptions {
  session: Ref<SerialSession>;
  sendBytes: (payload: Uint8Array, options?: SerialWriteOptions) => Promise<SerialSendResult>;
  rawBytes: (cb: (bytes: Uint8Array) => void) => () => void;
  isConnected: Ref<boolean>;
  waveformRef: Ref<{
    pushRegisterSample: (channel: number, value: number, timestamp?: number) => void;
    pushRegisterSamples: (
      samples: readonly { channel: number; value: number; timestamp?: number }[],
    ) => void;
  } | null>;
  showWaveform: () => void;
  notifications?: ApplicationNotificationPort;
}

/**
 * Bridges the Modbus master to a serial session and exposes the imperative
 * handlers the ModbusPanel calls.
 */
export class ModbusBridge {
  readonly modbusBusy = ref(false);
  readonly modbusStatus = ref<SessionModbusStatus>({ kind: 'idle' });
  readonly writeSourceName = ref<string | null>(null);
  readonly writeSourceInput = ref<HTMLInputElement | null>(null);
  readonly modbusStatusText: ComputedRef<string>;
  readonly modbusStatusClass: ComputedRef<string>;
  readonly waveformChannelLabels: ComputedRef<Record<number, string>>;
  readonly master: ReturnType<typeof useModbusMaster>;

  private readonly options: ModbusBridgeCreateOptions;
  private readonly document: ReturnType<typeof useSessionDocument>;
  private readonly notifications: ApplicationNotificationPort;

  constructor(options: ModbusBridgeCreateOptions) {
    this.options = options;
    this.notifications = options.notifications ?? NOOP_NOTIFICATIONS;
    this.document = useSessionDocument(options.session.value.id);

    const configRef = computed(() => options.session.value.modbusConfig);
    const registersRef = computed(() => options.session.value.modbusRegisters);

    this.master = useModbusMaster({
      sessionId: options.session.value.id,
      config: configRef,
      registers: registersRef,
      sendBytes: options.sendBytes,
      rawBytes: options.rawBytes,
      isConnected: options.isConnected,
      onSamples: (samples) => {
        if (options.session.value.waveformSourceMode !== 'register') return;
        const waveformSamples: { channel: number; value: number; timestamp?: number }[] = [];
        for (const sample of samples) {
          if (sample.channel === null) continue;
          waveformSamples.push({
            channel: sample.channel,
            value: sample.value,
            timestamp: sample.ts,
          });
        }
        options.waveformRef.value?.pushRegisterSamples(waveformSamples);
      },
      onStatus: (status) => {
        this.modbusStatus.value = snapshotModbusStatus(status);
      },
    });

    this.modbusStatusText = computed(() => formatSessionModbusStatus(this.modbusStatus.value, t));
    this.modbusStatusClass = computed(() => this.modbusStatus.value.kind);
    this.waveformChannelLabels = computed(() =>
      buildModbusWaveformChannelLabels(options.session.value.modbusRegisters),
    );
  }

  toggleWaveformSourceMode(): void {
    const next =
      this.options.session.value.waveformSourceMode === 'register' ? 'text' : 'register';
    this.document.setWaveformSourceMode(this.options.session.value.id, next);
  }

  async readAll(): Promise<void> {
    this.modbusBusy.value = true;
    try {
      await this.master.readAll();
    } finally {
      this.modbusBusy.value = false;
    }
  }

  async readRow(reg: ModbusRegister): Promise<void> {
    this.modbusBusy.value = true;
    try {
      await this.master.readOnce(reg);
    } finally {
      this.modbusBusy.value = false;
    }
  }

  async sendAll(): Promise<void> {
    this.modbusBusy.value = true;
    try {
      const result = await this.master.sendAll();
      if (result.sent > 0) {
        this.notifications.success(t('modbus.sendAll') + ` (${result.ok}/${result.sent})`);
      }
    } finally {
      this.modbusBusy.value = false;
    }
  }

  async sendRow(reg: ModbusRegister): Promise<boolean> {
    this.modbusBusy.value = true;
    try {
      return await this.master.sendRow(reg);
    } finally {
      this.modbusBusy.value = false;
    }
  }

  startReplay(records: ModbusStreamRecord[]): void {
    this.master.startReplay(records);
  }

  stopReplay(): void {
    this.master.stopReplay();
  }

  pickWriteSource(): void {
    this.writeSourceInput.value?.click();
  }

  loadWriteSource(records: ModbusStreamRecord[], name: string): void {
    this.master.loadWriteSource(records, name);
    this.writeSourceName.value = name;
    this.notifications.success(t('modbus.writeSourceLoaded', { count: records.length, name }));
  }

  clearWriteSource(): void {
    this.master.clearWriteSource();
    this.writeSourceName.value = null;
  }

  onWriteSourcePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const records = parseStream(text);
      if (records.length === 0) {
        this.notifications.warning(t('modbus.empty'));
        return;
      }
      this.loadWriteSource(records, file.name);
    };
    reader.readAsText(file);
    input.value = '';
  }

  plotInWaveform(reg: ModbusRegister): void {
    let channel = reg.waveformChannel;
    if (channel === null) {
      channel = findAvailableModbusWaveformChannel(this.options.session.value.modbusRegisters);
      if (channel === null) return;
      this.document.updateModbusRegister(this.options.session.value.id, reg.id, {
        waveformChannel: channel,
      });
    }
    this.document.setWaveformSourceMode(this.options.session.value.id, 'register');
    this.options.showWaveform();
  }
}

export function createModbusBridge(options: ModbusBridgeCreateOptions): ModbusBridge {
  return new ModbusBridge(options);
}

export function useSessionModbus(options: ModbusBridgeCreateOptions) {
  const bridge = createModbusBridge(options);
  return {
    modbusBusy: bridge.modbusBusy,
    modbusStatusText: bridge.modbusStatusText,
    modbusStatusClass: bridge.modbusStatusClass,
    waveformChannelLabels: bridge.waveformChannelLabels,
    writeSourceInput: bridge.writeSourceInput,
    writeSourceName: bridge.writeSourceName,
    master: bridge.master,
    toggleWaveformSourceMode: () => bridge.toggleWaveformSourceMode(),
    readAll: () => bridge.readAll(),
    readRow: (reg: ModbusRegister) => bridge.readRow(reg),
    sendAll: () => bridge.sendAll(),
    sendRow: (reg: ModbusRegister) => bridge.sendRow(reg),
    startReplay: (records: ModbusStreamRecord[]) => bridge.startReplay(records),
    stopReplay: () => bridge.stopReplay(),
    pickWriteSource: () => bridge.pickWriteSource(),
    loadWriteSource: (records: ModbusStreamRecord[], name: string) =>
      bridge.loadWriteSource(records, name),
    clearWriteSource: () => bridge.clearWriteSource(),
    onWriteSourcePicked: (event: Event) => bridge.onWriteSourcePicked(event),
    plotInWaveform: (reg: ModbusRegister) => bridge.plotInWaveform(reg),
  };
}

/** @deprecated Use `ModbusBridgeCreateOptions` */
export type UseSessionModbusOptions = ModbusBridgeCreateOptions;
