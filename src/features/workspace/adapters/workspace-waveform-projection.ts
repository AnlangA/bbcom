import type {
  WorkspaceWaveformChannel,
  WorkspaceWaveformChannelsPayload,
  WorkspaceWaveformSample,
} from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import type { SerialSession, SessionWaveformFrameCursor } from '@/types';
import {
  WorkspaceAdapterLimitError,
  WorkspaceAdapterValidationError,
} from './workspace-adapter-errors';
import { assertSafeWorkspaceValue } from './workspace-adapter-security';
import {
  WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES,
  WORKSPACE_SESSION_PROJECTION_VERSION,
  assertExactKeys,
  boundedInteger,
  expectBoolean,
  expectVersion,
  jsonByteLength,
  validNonNegativeInteger,
} from './workspace-validation';

/**
 * Waveform projection and hydration for the workspace session adapter.
 *
 * Owns everything that maps between the runtime waveform sidecar (channels,
 * samples, text-ingest cursor, display-only channel visibility) and the
 * durable workspace rows, including the byte-budgeted sample chunking used to
 * stream `append-waveform-samples` mutations within IPC batch limits.
 */

export interface WorkspaceWaveformChannelProjection {
  readonly channelIndex: number;
  readonly config: Record<string, unknown>;
}

export interface WorkspaceWaveformSampleProjection {
  readonly channelIndex: number;
  readonly seq: number;
  readonly timestampMs: number;
  readonly value: number;
}

export function projectWorkspaceWaveformPreferences(
  session: Pick<SerialSession, 'waveformSourceMode'>,
  frameCursor?: SessionWaveformFrameCursor,
  channels?: readonly Readonly<{
    channelIndex: number;
    config?: Readonly<Record<string, unknown>>;
    visible?: boolean;
  }>[],
): Record<string, unknown> {
  if (session.waveformSourceMode !== 'text' && session.waveformSourceMode !== 'register') {
    throw new WorkspaceAdapterValidationError('session.waveformSourceMode');
  }
  if (frameCursor && !isWorkspaceWaveformFrameCursor(frameCursor)) {
    throw new WorkspaceAdapterValidationError('session.waveformFrameCursor');
  }
  const channelVisibility = channels?.map((channel) => ({
    channelIndex: boundedInteger(channel.channelIndex, 0, 7, 'waveform.channelIndex'),
    visible:
      channel.visible ??
      (channel.config?.visible === undefined
        ? true
        : expectBoolean(channel.config.visible, 'waveform.channel.visible')),
  }));
  if (
    channelVisibility &&
    new Set(channelVisibility.map((channel) => channel.channelIndex)).size !==
      channelVisibility.length
  ) {
    throw new WorkspaceAdapterValidationError('waveform.channelIndex');
  }
  return {
    schemaVersion: WORKSPACE_SESSION_PROJECTION_VERSION,
    sourceMode: session.waveformSourceMode,
    ...(frameCursor
      ? { frameCursor: { consumed: frameCursor.consumed, lastFrameId: frameCursor.lastFrameId } }
      : {}),
    ...(channelVisibility ? { channelVisibility } : {}),
  };
}

export function projectWaveformSamples(input: {
  readonly channels: readonly WorkspaceWaveformChannelProjection[];
  readonly samples: readonly WorkspaceWaveformSampleProjection[];
}): {
  channels: WorkspaceWaveformChannelsPayload;
  samples: WorkspaceWaveformSample[];
} {
  if (!Array.isArray(input.channels) || !Array.isArray(input.samples)) {
    throw new WorkspaceAdapterValidationError('waveform');
  }
  const seenChannels = new Set<number>();
  const channels = input.channels.map((channel) => {
    assertExactKeys(channel, ['channelIndex', 'config'], 'waveform.channel');
    const channelIndex = boundedInteger(channel.channelIndex, 0, 7, 'waveform.channelIndex');
    if (seenChannels.has(channelIndex)) {
      throw new WorkspaceAdapterValidationError('waveform.channelIndex');
    }
    seenChannels.add(channelIndex);
    assertSafeWorkspaceValue(channel.config, 'waveform.channelConfig');
    return { channelIndex, config: structuredClone(channel.config) };
  });
  const seenSamples = new Set<string>();
  const samples = input.samples.map((sample) => {
    assertExactKeys(sample, ['channelIndex', 'seq', 'timestampMs', 'value'], 'waveform.sample');
    const channelIndex = boundedInteger(sample.channelIndex, 0, 7, 'waveform.channelIndex');
    if (!seenChannels.has(channelIndex)) {
      throw new WorkspaceAdapterValidationError('waveform.sample.channelIndex');
    }
    const sequence = validNonNegativeInteger(sample.seq, 'waveform.seq');
    const sampleKey = `${channelIndex}:${sequence}`;
    if (seenSamples.has(sampleKey)) {
      throw new WorkspaceAdapterValidationError('waveform.sample.seq');
    }
    seenSamples.add(sampleKey);
    if (!Number.isFinite(sample.value)) throw new WorkspaceAdapterValidationError('waveform.value');
    return {
      channelIndex,
      seq: sequence,
      timestampMs: validNonNegativeInteger(sample.timestampMs, 'waveform.timestampMs'),
      value: sample.value,
    };
  });
  return { channels: { channels }, samples };
}

export function hydrateWaveformPreferences(value: Record<string, unknown>): {
  readonly sourceMode: SerialSession['waveformSourceMode'];
  readonly frameCursor: SessionWaveformFrameCursor | null;
  readonly channelVisibility: ReadonlyMap<number, boolean>;
} {
  const keys = ['schemaVersion', 'sourceMode'];
  if (value.frameCursor !== undefined) keys.push('frameCursor');
  if (value.channelVisibility !== undefined) keys.push('channelVisibility');
  assertExactKeys(value, keys, 'waveformPreferences');
  expectVersion(value.schemaVersion, 'waveformPreferences.schemaVersion');
  if (value.sourceMode !== 'text' && value.sourceMode !== 'register') {
    throw new WorkspaceAdapterValidationError('waveformPreferences.sourceMode');
  }
  let frameCursor: SessionWaveformFrameCursor | null = null;
  if (value.frameCursor !== undefined) {
    if (
      !value.frameCursor ||
      typeof value.frameCursor !== 'object' ||
      Array.isArray(value.frameCursor)
    ) {
      throw new WorkspaceAdapterValidationError('waveformPreferences.frameCursor');
    }
    const cursor = value.frameCursor as Record<string, unknown>;
    assertExactKeys(cursor, ['consumed', 'lastFrameId'], 'waveformPreferences.frameCursor');
    if (!isWorkspaceWaveformFrameCursor(cursor)) {
      throw new WorkspaceAdapterValidationError('waveformPreferences.frameCursor');
    }
    frameCursor = Object.freeze({
      consumed: cursor.consumed,
      lastFrameId: cursor.lastFrameId,
    });
  }
  const channelVisibility = new Map<number, boolean>();
  if (value.channelVisibility !== undefined) {
    if (!Array.isArray(value.channelVisibility) || value.channelVisibility.length > 8) {
      throw new WorkspaceAdapterValidationError('waveformPreferences.channelVisibility');
    }
    for (const entry of value.channelVisibility) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new WorkspaceAdapterValidationError('waveformPreferences.channelVisibility');
      }
      const channel = entry as Record<string, unknown>;
      assertExactKeys(
        channel,
        ['channelIndex', 'visible'],
        'waveformPreferences.channelVisibility',
      );
      const channelIndex = boundedInteger(
        channel.channelIndex,
        0,
        7,
        'waveformPreferences.channelIndex',
      );
      if (channelVisibility.has(channelIndex)) {
        throw new WorkspaceAdapterValidationError('waveformPreferences.channelIndex');
      }
      channelVisibility.set(
        channelIndex,
        expectBoolean(channel.visible, 'waveformPreferences.channel.visible'),
      );
    }
  }
  return Object.freeze({
    sourceMode: value.sourceMode,
    frameCursor,
    channelVisibility,
  });
}

export function legacyWaveformFrameCursor(
  sourceMode: SerialSession['waveformSourceMode'],
  frames: readonly { readonly id: string }[],
  hasDurableSamples: boolean,
): SessionWaveformFrameCursor {
  if (sourceMode === 'register' || hasDurableSamples) {
    return Object.freeze({
      consumed: frames.length,
      lastFrameId: frames.at(-1)?.id ?? null,
    });
  }
  // Legacy projects did not persist this cursor. Force one deterministic text
  // rebuild so retained frames replace (rather than duplicate) derived rows.
  return Object.freeze({ consumed: frames.length + 1, lastFrameId: null });
}

function isWorkspaceWaveformFrameCursor(value: unknown): value is SessionWaveformFrameCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(cursor.consumed) &&
    (cursor.consumed as number) >= 0 &&
    (cursor.lastFrameId === null || typeof cursor.lastFrameId === 'string')
  );
}

export function cloneWaveformPayload(
  channelRows: readonly WorkspaceWaveformChannel[],
  sampleRows: readonly WorkspaceWaveformSample[],
): {
  readonly channels: readonly WorkspaceWaveformChannel[];
  readonly samples: readonly WorkspaceWaveformSample[];
} {
  if (!Array.isArray(channelRows) || !Array.isArray(sampleRows)) {
    throw new WorkspaceAdapterValidationError('waveform');
  }
  const channels = channelRows.map((channel, index) => {
    assertExactKeys(channel, ['channelIndex', 'config'], `waveform.channels[${index}]`);
    const channelIndex = boundedInteger(channel.channelIndex, 0, 7, `waveform.channels[${index}]`);
    assertSafeWorkspaceValue(channel.config, `waveform.channels[${index}].config`);
    return { channelIndex, config: structuredClone(channel.config) };
  });
  if (new Set(channels.map((channel) => channel.channelIndex)).size !== channels.length) {
    throw new WorkspaceAdapterValidationError('waveform.channels');
  }
  const knownChannels = new Set(channels.map((channel) => channel.channelIndex));
  const sampleKeys = new Set<string>();
  const samples = sampleRows.map((sample) => {
    assertExactKeys(sample, ['channelIndex', 'seq', 'timestampMs', 'value'], 'waveform.sample');
    const channelIndex = boundedInteger(sample.channelIndex, 0, 7, 'waveform.sample.channelIndex');
    if (!knownChannels.has(channelIndex)) {
      throw new WorkspaceAdapterValidationError('waveform.sample.channelIndex');
    }
    const sequence = validNonNegativeInteger(sample.seq, 'waveform.seq');
    const sampleKey = `${channelIndex}:${sequence}`;
    if (sampleKeys.has(sampleKey)) {
      throw new WorkspaceAdapterValidationError('waveform.sample.seq');
    }
    sampleKeys.add(sampleKey);
    if (!Number.isFinite(sample.value)) throw new WorkspaceAdapterValidationError('waveform.value');
    return {
      channelIndex,
      seq: sequence,
      timestampMs: validNonNegativeInteger(sample.timestampMs, 'waveform.timestampMs'),
      value: sample.value,
    };
  });
  return Object.freeze({ channels: Object.freeze(channels), samples: Object.freeze(samples) });
}

export function chunkWaveformSamples(
  samples: readonly WorkspaceWaveformSample[],
): { samples: WorkspaceWaveformSample[] }[] {
  const chunks: { samples: WorkspaceWaveformSample[] }[] = [];
  let current: WorkspaceWaveformSample[] = [];
  for (const sample of samples) {
    const candidate = { samples: [...current, sample] };
    if (
      current.length > 0 &&
      jsonByteLength(candidate) + WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES >
        IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES
    ) {
      chunks.push({ samples: current });
      current = [];
    }
    current.push(sample);
  }
  if (current.length > 0) {
    const actual = jsonByteLength({ samples: current }) + WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES;
    if (actual > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES) {
      throw new WorkspaceAdapterLimitError(
        'workspaceBatchBytes',
        IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES,
        actual,
      );
    }
    chunks.push({ samples: current });
  }
  return chunks;
}
