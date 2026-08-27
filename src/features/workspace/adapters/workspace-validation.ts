import type { WorkspaceMutation } from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import type { ModbusMasterConfig, SerialShellConfig } from '@/types';
import {
  MAX_SMP_PARSER_MAX_PACKET_BYTES,
  MAX_SMP_REASSEMBLY_TIMEOUT_MS,
  MIN_SMP_PARSER_MAX_PACKET_BYTES,
  MIN_SMP_REASSEMBLY_TIMEOUT_MS,
} from '@/lib/protocol-parser';
import {
  WorkspaceAdapterLimitError,
  WorkspaceAdapterValidationError,
} from './workspace-adapter-errors';
import { utf8ByteLength } from './workspace-adapter-security';

/**
 * Generic validation primitives shared by the workspace adapters.
 *
 * Every helper here is domain-agnostic (field-name driven, no session or row
 * knowledge) so sibling adapters can reuse the same fail-closed guards. The
 * one workspace-specific constant is the projection schema version: it is
 * stamped into every projected feature-state payload and verified on hydration
 * by `expectVersion`, so it lives with the guard that enforces it.
 */

/** Schema version stamped into every projected session feature state. */
export const WORKSPACE_SESSION_PROJECTION_VERSION = 2 as const;

export const WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES = 2_048;

export function assertMutationSize(mutation: WorkspaceMutation): void {
  const actual = jsonByteLength(mutation) + WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES;
  if (actual > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES) {
    throw new WorkspaceAdapterLimitError(
      'workspaceBatchBytes',
      IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES,
      actual,
    );
  }
}

export function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new WorkspaceAdapterValidationError('json');
  return utf8ByteLength(serialized);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new WorkspaceAdapterValidationError('json');
  return serialized;
}

export function validateParserConfig(config: Record<string, unknown>): void {
  if (config.kind === 'mcumgr-smp') {
    assertExactKeys(
      config,
      ['kind', 'transport', 'maxPacketBytes', 'reassemblyTimeoutMs'],
      'parser.config',
    );
    if (config.transport !== 'serial-console' && config.transport !== 'raw-uart') {
      throw new WorkspaceAdapterValidationError('parser.config.transport');
    }
    boundedInteger(
      config.maxPacketBytes,
      MIN_SMP_PARSER_MAX_PACKET_BYTES,
      MAX_SMP_PARSER_MAX_PACKET_BYTES,
      'parser.config.maxPacketBytes',
    );
    boundedInteger(
      config.reassemblyTimeoutMs,
      MIN_SMP_REASSEMBLY_TIMEOUT_MS,
      MAX_SMP_REASSEMBLY_TIMEOUT_MS,
      'parser.config.reassemblyTimeoutMs',
    );
    return;
  }
  if (config.kind === 'delimiter') {
    assertExactKeys(config, ['kind', 'delimiter', 'includeDelimiter'], 'parser.config');
    if (
      !Array.isArray(config.delimiter) ||
      config.delimiter.length === 0 ||
      config.delimiter.length > 256 ||
      config.delimiter.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      throw new WorkspaceAdapterValidationError('parser.config.delimiter');
    }
    expectBoolean(config.includeDelimiter, 'parser.config.includeDelimiter');
    return;
  }
  if (config.kind === 'fixed') {
    assertExactKeys(config, ['kind', 'frameSize'], 'parser.config');
    boundedInteger(config.frameSize, 1, 65_535, 'parser.config.frameSize');
    return;
  }
  if (config.kind === 'length') {
    assertExactKeys(
      config,
      ['kind', 'lengthOffset', 'lengthSize', 'bigEndian', 'lengthAdjust'],
      'parser.config',
    );
    boundedInteger(config.lengthOffset, 0, 255, 'parser.config.lengthOffset');
    if (config.lengthSize !== 1 && config.lengthSize !== 2 && config.lengthSize !== 4) {
      throw new WorkspaceAdapterValidationError('parser.config.lengthSize');
    }
    expectBoolean(config.bigEndian, 'parser.config.bigEndian');
    boundedInteger(config.lengthAdjust, 0, 65_535, 'parser.config.lengthAdjust');
    return;
  }
  throw new WorkspaceAdapterValidationError('parser.config.kind');
}

export function validateModbusConfig(value: ModbusMasterConfig, field: string): void;
export function validateModbusConfig(value: Record<string, unknown>, field: string): void;
export function validateModbusConfig(
  value: ModbusMasterConfig | Record<string, unknown>,
  field: string,
): void {
  if (value.transport !== 'rtu' && value.transport !== 'pdu') {
    throw new WorkspaceAdapterValidationError(`${field}.transport`);
  }
  expectBoolean(value.enabled, `${field}.enabled`);
  boundedInteger(value.pollIntervalMs, 100, 10_000, `${field}.pollIntervalMs`);
  boundedInteger(value.writeIntervalMs, 100, 10_000, `${field}.writeIntervalMs`);
  boundedInteger(value.timeoutMs, 50, 5_000, `${field}.timeoutMs`);
}

export const SERIAL_SHELL_CONFIG_KEYS = [
  'localEcho',
  'txNewline',
  'rxNewline',
  'encoding',
  'backspace',
] as const;

/**
 * Fields written by the pre-terminal shell (input box + line history). Old
 * snapshots still carry them; hydration tolerates and drops them.
 */
export const SERIAL_SHELL_LEGACY_CONFIG_KEYS = ['inputMode', 'showTimestamp', 'history'] as const;

export function validateSerialShellConfig(value: SerialShellConfig, field: string): void;
export function validateSerialShellConfig(value: Record<string, unknown>, field: string): void;
export function validateSerialShellConfig(
  value: SerialShellConfig | Record<string, unknown>,
  field: string,
): void {
  expectBoolean(value.localEcho, `${field}.localEcho`);
  if (
    value.txNewline !== 'none' &&
    value.txNewline !== 'cr' &&
    value.txNewline !== 'lf' &&
    value.txNewline !== 'crlf'
  ) {
    throw new WorkspaceAdapterValidationError(`${field}.txNewline`);
  }
  if (
    value.rxNewline !== 'none' &&
    value.rxNewline !== 'cr' &&
    value.rxNewline !== 'lf' &&
    value.rxNewline !== 'crlf' &&
    value.rxNewline !== 'auto'
  ) {
    throw new WorkspaceAdapterValidationError(`${field}.rxNewline`);
  }
  if (value.encoding !== 'utf-8' && value.encoding !== 'gbk' && value.encoding !== 'latin1') {
    throw new WorkspaceAdapterValidationError(`${field}.encoding`);
  }
  if (value.backspace !== 'bs' && value.backspace !== 'del') {
    throw new WorkspaceAdapterValidationError(`${field}.backspace`);
  }
}

export function assertEmptyRecord(value: Record<string, unknown>, field: string): void {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new WorkspaceAdapterValidationError(field);
  }
}

export function assertExactKeys(value: unknown, allowed: readonly string[], field: string): void {
  if (!isRecord(value)) throw new WorkspaceAdapterValidationError(field);
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new WorkspaceAdapterValidationError(field);
  }
}

export function assertUniqueIds(values: readonly { id: string }[], field: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new WorkspaceAdapterValidationError(field);
    ids.add(value.id);
  }
}

export function expectVersion(value: unknown, field: string): void {
  if (value !== WORKSPACE_SESSION_PROJECTION_VERSION) {
    throw new WorkspaceAdapterValidationError(field);
  }
}

export function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new WorkspaceAdapterValidationError(field);
  return value;
}

export function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new WorkspaceAdapterValidationError(field);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function positiveInteger(value: unknown, field: string): number {
  const integer = validNonNegativeInteger(value, field);
  if (integer === 0) throw new WorkspaceAdapterValidationError(field);
  return integer;
}

export function validNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return value;
}

export function validUint32(value: unknown, field: string): number {
  return boundedInteger(value, 0, 0xffff_ffff, field);
}

export function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return value;
}

export function invalid(field: string): never {
  throw new WorkspaceAdapterValidationError(field);
}

export function assertLimit(field: string, limit: number, actual: number): void {
  if (actual > limit) throw new WorkspaceAdapterLimitError(field, limit, actual);
}
