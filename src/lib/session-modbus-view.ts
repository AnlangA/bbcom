import type { ModbusRegister } from '@/types';

export interface SessionModbusStatus {
  kind: string;
  code?: number;
  count?: number;
  remaining?: number;
  message?: string;
  scope?: string;
  key?: string;
  delayMs?: number;
  consecutiveFailures?: number;
}

export type SessionTranslate = (key: string, params?: Record<string, string | number>) => string;

export function snapshotModbusStatus(status: SessionModbusStatus): SessionModbusStatus {
  return {
    kind: status.kind,
    code: status.code,
    count: status.count,
    remaining: status.remaining,
    message: status.message,
    scope: status.scope,
    key: status.key,
    delayMs: status.delayMs,
    consecutiveFailures: status.consecutiveFailures,
  };
}

export function formatSessionModbusStatus(
  status: SessionModbusStatus,
  translate: SessionTranslate,
): string {
  if (status.kind === 'polling') {
    return translate('modbus.status.polling', { count: status.count ?? 0 });
  }
  if (status.kind === 'writing') {
    return translate('modbus.status.writing', { count: status.count ?? 0 });
  }
  if (status.kind === 'timeout') return translate('modbus.status.timeout');
  if (status.kind === 'exception') {
    return translate('modbus.status.exception', { code: status.code ?? 0 });
  }
  if (status.kind === 'crc-error') return translate('modbus.status.crcError');
  if (status.kind === 'replaying') {
    return translate('modbus.status.replaying', { remaining: status.remaining ?? 0 });
  }
  if (status.kind === 'backoff') {
    return translate('modbus.status.backoff', {
      scope:
        status.scope === 'write'
          ? translate('modbus.status.scopeWrite')
          : translate('modbus.status.scopeRead'),
      delay: status.delayMs ?? 0,
      count: status.consecutiveFailures ?? 0,
    });
  }
  if (status.kind === 'error') {
    return translate('modbus.status.error', { message: status.message ?? '' });
  }
  return translate('modbus.status.idle');
}

export function buildModbusWaveformChannelLabels(
  registers: readonly Pick<ModbusRegister, 'name' | 'waveformChannel'>[],
): Record<number, string> {
  const labels: Record<number, string> = {};
  for (const reg of registers) {
    if (reg.waveformChannel !== null && reg.waveformChannel >= 0) {
      labels[reg.waveformChannel] = reg.name;
    }
  }
  return labels;
}

export function findAvailableModbusWaveformChannel(
  registers: readonly Pick<ModbusRegister, 'waveformChannel'>[],
  channelCount = 8,
): number | null {
  const used = new Set(
    registers
      .map((reg) => reg.waveformChannel)
      .filter(
        (channel): channel is number =>
          channel !== null && Number.isInteger(channel) && channel >= 0 && channel < channelCount,
      ),
  );
  for (let channel = 0; channel < channelCount; channel += 1) {
    if (!used.has(channel)) return channel;
  }
  return null;
}
