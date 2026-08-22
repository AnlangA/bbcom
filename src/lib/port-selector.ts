import type { ChecksumType, PortConfig } from '@/types';
import { formatHex, hexByteCount, isValidHex, parseHex } from './format';

export interface PortSessionRef {
  portName: string;
  isConnected: boolean;
}

export interface PortOption {
  label: string;
  value: string;
  disabled: boolean;
  [key: string]: unknown;
}

export interface ValueOption<T extends string | number> {
  label: string;
  value: T;
  [key: string]: unknown;
}

export interface ChecksumInputState {
  isValid: boolean;
  byteCount: number;
  status: 'error' | undefined;
}

export function connectedPortNames(sessions: readonly PortSessionRef[]): Set<string> {
  return new Set(
    sessions.filter((session) => session.isConnected).map((session) => session.portName),
  );
}

export function missingActivePorts(
  sessions: readonly PortSessionRef[],
  availablePorts: readonly string[],
): string[] {
  const available = new Set(availablePorts);
  return sessions
    .filter((session) => session.isConnected && !available.has(session.portName))
    .map((session) => session.portName);
}

export function buildPortOptions(
  ports: readonly string[],
  usedPorts: ReadonlySet<string>,
  inUseLabel: string,
): PortOption[] {
  return ports.map((port) => {
    const disabled = usedPorts.has(port);
    return {
      label: disabled ? `${port} (${inUseLabel})` : port,
      value: port,
      disabled,
    };
  });
}

export function nextSelectedPort(currentPort: string, ports: readonly string[]): string {
  return currentPort || ports[0] || currentPort;
}

export function localizeValueOptions<T extends string | number>(
  options: readonly ValueOption<T>[],
  labelForValue: (value: T, fallback: string) => string,
): ValueOption<T>[] {
  return options.map((option) => ({
    ...option,
    label: labelForValue(option.value, option.label),
  }));
}

export function localizeChecksumOptions(
  options: readonly ValueOption<ChecksumType>[],
  checksumLabel: string,
): ValueOption<ChecksumType>[] {
  return options.map((option) => ({
    ...option,
    label: option.value === 'CHECKSUM' ? checksumLabel : option.label,
  }));
}

export function serialParityCode(parity: PortConfig['parity']): 'N' | 'O' | 'E' {
  if (parity === 'odd') return 'O';
  if (parity === 'even') return 'E';
  return 'N';
}

export function serialFormatLabel(
  config: Pick<PortConfig, 'dataBits' | 'parity' | 'stopBits'>,
): string {
  return `${config.dataBits}${serialParityCode(config.parity)}${config.stopBits}`;
}

export function serialSignalSummary(
  config: Pick<PortConfig, 'dtr' | 'rts'>,
  noneLabel: string,
): string {
  const signals = [config.dtr ? 'DTR' : '', config.rts ? 'RTS' : ''].filter(Boolean);
  return signals.join('+') || noneLabel;
}

export function checksumInputState(input: string): ChecksumInputState {
  const isEmpty = input.trim().length === 0;
  const valid = isEmpty || isValidHex(input);
  return {
    isValid: valid,
    byteCount: hexByteCount(input),
    status: input && !valid ? 'error' : undefined,
  };
}

export function canCalculateChecksum(input: string): boolean {
  return input.trim().length > 0 && isValidHex(input);
}

export function normalizeChecksumInputValue(input: string): string {
  if (!canCalculateChecksum(input)) return input;
  return formatHex(parseHex(input));
}

export function isCopyableChecksumResult(result: string, failedLabel: string): boolean {
  return result.length > 0 && result !== failedLabel;
}
