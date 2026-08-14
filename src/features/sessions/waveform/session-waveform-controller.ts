import type {
  SessionWaveformChannel,
  SessionWaveformFrameCursor,
  SessionWaveformSample,
  SessionWaveformSampleInput,
  SessionWaveformState,
} from '../../../types';
import { SESSION_WAVEFORM_MAX_GROUPS } from '../../../types';

export type SessionWaveformChangeEvent =
  | Readonly<{
      kind: 'waveform-replaced';
      sessionId: string;
      waveform: SessionWaveformState;
    }>
  | Readonly<{
      kind: 'waveform-samples-appended';
      sessionId: string;
      samples: readonly SessionWaveformSample[];
    }>
  | Readonly<{
      kind: 'waveform-cursor-changed';
      sessionId: string;
      cursor: SessionWaveformFrameCursor;
    }>
  | Readonly<{
      kind: 'waveform-channel-config-changed';
      sessionId: string;
      waveform: SessionWaveformState;
    }>
  | Readonly<{
      kind: 'waveform-frame-ingested';
      sessionId: string;
      mode: 'append' | 'replace';
      waveform: SessionWaveformState;
      samples: readonly SessionWaveformSample[];
    }>;

export type SessionWaveformStateBySessionId = Readonly<Record<string, SessionWaveformState>>;

interface SessionWaveformControllerDependencies {
  readonly hasSession: (sessionId: string) => boolean;
  readonly canMutateUserState: () => boolean;
  readonly canCaptureRuntimeEvents: () => boolean;
  readonly onStateChanged: (state: SessionWaveformStateBySessionId) => void;
  readonly onChange: (event: SessionWaveformChangeEvent) => void;
}

export interface SessionWaveformController {
  readonly snapshot: () => SessionWaveformStateBySessionId;
  readonly snapshotSession: (sessionId: string) => SessionWaveformState;
  readonly prepareReplacement: (
    entries: readonly Readonly<{ sessionId: string; waveform: SessionWaveformState }>[],
  ) => SessionWaveformStateBySessionId;
  readonly replacePrepared: (state: SessionWaveformStateBySessionId) => void;
  readonly replaceWithEmptySessions: (sessionIds: readonly string[]) => void;
  readonly addEmptySessions: (sessionIds: readonly string[]) => void;
  readonly addEmptySession: (sessionId: string) => void;
  readonly restoreSession: (sessionId: string, state: SessionWaveformState) => void;
  readonly removeSession: (sessionId: string) => void;
  readonly appendSessionWaveformSamples: (
    sessionId: string,
    inputs: readonly SessionWaveformSampleInput[],
  ) => boolean;
  readonly replaceSessionWaveformSamples: (
    sessionId: string,
    inputs: readonly SessionWaveformSampleInput[],
  ) => boolean;
  readonly setSessionWaveformChannelVisible: (
    sessionId: string,
    channelIndex: number,
    visible: boolean,
  ) => boolean;
  readonly clearSessionWaveform: (sessionId: string) => boolean;
  readonly resetSessionWaveform: (
    sessionId: string,
    cursor: SessionWaveformFrameCursor,
    force?: boolean,
  ) => boolean;
  readonly setSessionWaveformFrameCursor: (
    sessionId: string,
    cursor: SessionWaveformFrameCursor,
  ) => boolean;
  readonly commitSessionWaveformFrameIngest: (
    sessionId: string,
    mode: 'append' | 'replace',
    inputs: readonly SessionWaveformSampleInput[],
    cursor: SessionWaveformFrameCursor,
  ) => boolean;
}

export function createSessionWaveformController(
  dependencies: SessionWaveformControllerDependencies,
): SessionWaveformController {
  let stateBySessionId: SessionWaveformStateBySessionId = Object.freeze({});

  function commitState(next: SessionWaveformStateBySessionId): void {
    stateBySessionId = Object.freeze({ ...next });
    dependencies.onStateChanged(stateBySessionId);
  }

  function updateSession(sessionId: string, state: SessionWaveformState): void {
    commitState({ ...stateBySessionId, [sessionId]: state });
  }

  function prepareReplacement(
    entries: readonly Readonly<{ sessionId: string; waveform: SessionWaveformState }>[],
  ): SessionWaveformStateBySessionId {
    return Object.freeze(
      Object.fromEntries(
        entries.map(({ sessionId, waveform }) => [sessionId, cloneWaveformState(waveform)]),
      ),
    );
  }

  function replaceWithEmptySessions(sessionIds: readonly string[]): void {
    commitState(
      Object.fromEntries(sessionIds.map((sessionId) => [sessionId, emptyWaveformState()])),
    );
  }

  function addEmptySessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    commitState({
      ...stateBySessionId,
      ...Object.fromEntries(sessionIds.map((sessionId) => [sessionId, emptyWaveformState()])),
    });
  }

  function addEmptySession(sessionId: string): void {
    updateSession(sessionId, emptyWaveformState());
  }

  function restoreSession(sessionId: string, state: SessionWaveformState): void {
    updateSession(sessionId, cloneWaveformState(state));
  }

  function removeSession(sessionId: string): void {
    const next = { ...stateBySessionId };
    delete next[sessionId];
    commitState(next);
  }

  function appendSessionWaveformSamples(
    sessionId: string,
    inputs: readonly SessionWaveformSampleInput[],
  ): boolean {
    if (
      !dependencies.canCaptureRuntimeEvents() ||
      !dependencies.hasSession(sessionId) ||
      inputs.length === 0
    ) {
      return false;
    }
    const current = stateBySessionId[sessionId] ?? emptyWaveformState();
    const appended = buildWaveformAppend(current, inputs);
    if (!appended) return false;
    const unboundedSamples = [...current.samples, ...appended.samples];
    const nextSamples = retainLatestWaveformGroups(unboundedSamples);
    const overflowed = nextSamples.length !== unboundedSamples.length;
    const next = freezeWaveformState({
      channels: appended.channels,
      samples: nextSamples,
      frameCursor: current.frameCursor,
    });
    updateSession(sessionId, next);
    dependencies.onChange(
      overflowed || appended.channelsChanged
        ? Object.freeze({
            kind: 'waveform-frame-ingested',
            sessionId,
            mode: 'replace',
            waveform: next,
            samples: next.samples,
          })
        : Object.freeze({
            kind: 'waveform-samples-appended',
            sessionId,
            samples: appended.samples,
          }),
    );
    return true;
  }

  function replaceSessionWaveformSamples(
    sessionId: string,
    inputs: readonly SessionWaveformSampleInput[],
  ): boolean {
    if (!dependencies.canCaptureRuntimeEvents() || !dependencies.hasSession(sessionId)) {
      return false;
    }
    const current = stateBySessionId[sessionId] ?? emptyWaveformState();
    const empty = freezeWaveformState({
      channels: inputs.length > 0 ? current.channels : [],
      samples: [],
      frameCursor: current.frameCursor,
    });
    const rebuilt = inputs.length === 0 ? null : buildWaveformAppend(empty, inputs);
    if (inputs.length > 0 && !rebuilt) return false;
    const next = freezeWaveformState({
      channels: rebuilt?.channels ?? [],
      samples: retainLatestWaveformGroups(rebuilt?.samples ?? []),
      frameCursor: current.frameCursor,
    });
    updateSession(sessionId, next);
    dependencies.onChange(
      Object.freeze({
        kind: 'waveform-frame-ingested',
        sessionId,
        mode: 'replace',
        waveform: next,
        samples: next.samples,
      }),
    );
    return true;
  }

  function setSessionWaveformChannelVisible(
    sessionId: string,
    channelIndex: number,
    visible: boolean,
  ): boolean {
    if (!dependencies.canMutateUserState() || !dependencies.hasSession(sessionId)) return false;
    const current = stateBySessionId[sessionId];
    if (!current || !isWaveformChannelIndex(channelIndex)) return false;
    let changed = false;
    const channels = current.channels.map((channel) => {
      if (channel.channelIndex !== channelIndex) return channel;
      if (channel.config.visible === visible) return channel;
      changed = true;
      return Object.freeze({
        channelIndex,
        config: Object.freeze({ ...channel.config, visible }),
      });
    });
    if (!changed) return false;
    const next = freezeWaveformState({ ...current, channels });
    updateSession(sessionId, next);
    dependencies.onChange(
      Object.freeze({ kind: 'waveform-channel-config-changed', sessionId, waveform: next }),
    );
    return true;
  }

  function clearSessionWaveform(sessionId: string): boolean {
    const current = stateBySessionId[sessionId] ?? emptyWaveformState();
    return resetSessionWaveform(sessionId, current.frameCursor);
  }

  function resetSessionWaveform(
    sessionId: string,
    cursor: SessionWaveformFrameCursor,
    force = false,
  ): boolean {
    if (
      !dependencies.canMutateUserState() ||
      !dependencies.hasSession(sessionId) ||
      !isWaveformFrameCursor(cursor)
    ) {
      return false;
    }
    const current = stateBySessionId[sessionId] ?? emptyWaveformState();
    if (
      !force &&
      current.channels.length === 0 &&
      current.samples.length === 0 &&
      current.frameCursor.consumed === cursor.consumed &&
      current.frameCursor.lastFrameId === cursor.lastFrameId
    ) {
      return true;
    }
    const next = freezeWaveformState({ channels: [], samples: [], frameCursor: cursor });
    updateSession(sessionId, next);
    dependencies.onChange(
      Object.freeze({
        kind: 'waveform-frame-ingested',
        sessionId,
        mode: 'replace',
        waveform: next,
        samples: Object.freeze([]),
      }),
    );
    return true;
  }

  function setSessionWaveformFrameCursor(
    sessionId: string,
    cursor: SessionWaveformFrameCursor,
  ): boolean {
    if (
      !dependencies.canCaptureRuntimeEvents() ||
      !dependencies.hasSession(sessionId) ||
      !isWaveformFrameCursor(cursor)
    ) {
      return false;
    }
    const current = stateBySessionId[sessionId] ?? emptyWaveformState();
    if (
      current.frameCursor.consumed === cursor.consumed &&
      current.frameCursor.lastFrameId === cursor.lastFrameId
    ) {
      return true;
    }
    const nextCursor = Object.freeze({ ...cursor });
    updateSession(sessionId, freezeWaveformState({ ...current, frameCursor: nextCursor }));
    dependencies.onChange(
      Object.freeze({ kind: 'waveform-cursor-changed', sessionId, cursor: nextCursor }),
    );
    return true;
  }

  function commitSessionWaveformFrameIngest(
    sessionId: string,
    mode: 'append' | 'replace',
    inputs: readonly SessionWaveformSampleInput[],
    cursor: SessionWaveformFrameCursor,
  ): boolean {
    if (
      !dependencies.canCaptureRuntimeEvents() ||
      !dependencies.hasSession(sessionId) ||
      !isWaveformFrameCursor(cursor)
    ) {
      return false;
    }
    const current = stateBySessionId[sessionId] ?? emptyWaveformState();
    if (
      mode === 'append' &&
      inputs.length === 0 &&
      current.frameCursor.consumed === cursor.consumed &&
      current.frameCursor.lastFrameId === cursor.lastFrameId
    ) {
      return true;
    }
    let nextChannels: readonly SessionWaveformChannel[] = current.channels;
    let nextSamples: readonly SessionWaveformSample[] = current.samples;
    let committedSamples: readonly SessionWaveformSample[] = [];
    let persistedMode = mode;

    if (mode === 'replace') {
      const empty = freezeWaveformState({
        channels: inputs.length > 0 ? current.channels : [],
        samples: [],
        frameCursor: current.frameCursor,
      });
      const rebuilt = inputs.length === 0 ? null : buildWaveformAppend(empty, inputs);
      if (inputs.length > 0 && !rebuilt) return false;
      nextChannels = rebuilt?.channels ?? [];
      nextSamples = retainLatestWaveformGroups(rebuilt?.samples ?? []);
      committedSamples = nextSamples;
    } else if (inputs.length > 0) {
      const appended = buildWaveformAppend(current, inputs);
      if (!appended) return false;
      nextChannels = appended.channels;
      const unboundedSamples = [...current.samples, ...appended.samples];
      nextSamples = retainLatestWaveformGroups(unboundedSamples);
      committedSamples = appended.samples;
      if (appended.channelsChanged || nextSamples.length !== unboundedSamples.length) {
        persistedMode = 'replace';
        committedSamples = nextSamples;
      }
    }

    const next = freezeWaveformState({
      channels: nextChannels,
      samples: nextSamples,
      frameCursor: Object.freeze({ ...cursor }),
    });
    updateSession(sessionId, next);
    dependencies.onChange(
      Object.freeze({
        kind: 'waveform-frame-ingested',
        sessionId,
        mode: persistedMode,
        waveform: next,
        samples: Object.freeze([...committedSamples]),
      }),
    );
    return true;
  }

  return Object.freeze({
    snapshot: () => stateBySessionId,
    snapshotSession: (sessionId: string) =>
      cloneWaveformState(stateBySessionId[sessionId] ?? emptyWaveformState()),
    prepareReplacement,
    replacePrepared: commitState,
    replaceWithEmptySessions,
    addEmptySessions,
    addEmptySession,
    restoreSession,
    removeSession,
    appendSessionWaveformSamples,
    replaceSessionWaveformSamples,
    setSessionWaveformChannelVisible,
    clearSessionWaveform,
    resetSessionWaveform,
    setSessionWaveformFrameCursor,
    commitSessionWaveformFrameIngest,
  });
}

function emptyWaveformState(): SessionWaveformState {
  return freezeWaveformState({
    channels: [],
    samples: [],
    frameCursor: { consumed: 0, lastFrameId: null },
  });
}

function cloneWaveformState(state: SessionWaveformState): SessionWaveformState {
  return freezeWaveformState({
    ...state,
    samples: retainLatestWaveformGroups(state.samples),
  });
}

function freezeWaveformState(state: SessionWaveformState): SessionWaveformState {
  if (!isWaveformFrameCursor(state.frameCursor)) throw new Error('invalid waveform frame cursor');
  const channelIds = new Set<number>();
  const channels = state.channels.map((channel) => {
    if (
      !isWaveformChannelIndex(channel.channelIndex) ||
      channelIds.has(channel.channelIndex) ||
      !channel.config ||
      typeof channel.config !== 'object' ||
      Array.isArray(channel.config)
    ) {
      throw new Error('invalid waveform channel');
    }
    channelIds.add(channel.channelIndex);
    return Object.freeze({
      channelIndex: channel.channelIndex,
      config: Object.freeze(structuredClone(channel.config)),
    });
  });
  channels.sort((left, right) => left.channelIndex - right.channelIndex);
  const sampleKeys = new Set<string>();
  const samples = state.samples.map((sample) => {
    const key = `${sample.channelIndex}:${sample.seq}`;
    if (
      !channelIds.has(sample.channelIndex) ||
      !Number.isSafeInteger(sample.seq) ||
      sample.seq < 0 ||
      !Number.isSafeInteger(sample.timestampMs) ||
      sample.timestampMs < 0 ||
      !Number.isFinite(sample.value) ||
      sampleKeys.has(key)
    ) {
      throw new Error('invalid waveform sample');
    }
    sampleKeys.add(key);
    return Object.freeze({ ...sample });
  });
  samples.sort(
    (left, right) =>
      left.seq - right.seq ||
      left.timestampMs - right.timestampMs ||
      left.channelIndex - right.channelIndex,
  );
  return Object.freeze({
    channels: Object.freeze(channels),
    samples: Object.freeze(samples),
    frameCursor: Object.freeze({ ...state.frameCursor }),
  });
}

function buildWaveformAppend(
  current: SessionWaveformState,
  inputs: readonly SessionWaveformSampleInput[],
): Readonly<{
  channels: readonly SessionWaveformChannel[];
  samples: readonly SessionWaveformSample[];
  channelsChanged: boolean;
}> | null {
  const groups = new Set<number>();
  const inputKeys = new Set<string>();
  for (const input of inputs) {
    const key = `${input.group}:${input.channelIndex}`;
    if (
      !isWaveformChannelIndex(input.channelIndex) ||
      !Number.isSafeInteger(input.group) ||
      input.group < 0 ||
      !Number.isSafeInteger(input.timestampMs) ||
      input.timestampMs < 0 ||
      !Number.isFinite(input.value) ||
      inputKeys.has(key)
    ) {
      return null;
    }
    groups.add(input.group);
    inputKeys.add(key);
  }
  const maxSequence = current.samples.reduce(
    (maximum, sample) => Math.max(maximum, sample.seq),
    -1,
  );
  const sortedGroups = [...groups].sort((left, right) => left - right);
  if (maxSequence + sortedGroups.length > Number.MAX_SAFE_INTEGER) return null;
  const sequenceByGroup = new Map(
    sortedGroups.map((group, index) => [group, maxSequence + index + 1] as const),
  );
  const channelsByIndex = new Map(
    current.channels.map((channel) => [channel.channelIndex, channel] as const),
  );
  let channelsChanged = false;
  for (const input of inputs) {
    if (channelsByIndex.has(input.channelIndex)) continue;
    channelsChanged = true;
    channelsByIndex.set(
      input.channelIndex,
      Object.freeze({ channelIndex: input.channelIndex, config: Object.freeze({}) }),
    );
  }
  const channels = [...channelsByIndex.values()].sort(
    (left, right) => left.channelIndex - right.channelIndex,
  );
  const samples = inputs
    .map((input) =>
      Object.freeze({
        channelIndex: input.channelIndex,
        seq: sequenceByGroup.get(input.group)!,
        timestampMs: input.timestampMs,
        value: input.value,
      }),
    )
    .sort(
      (left, right) =>
        left.seq - right.seq ||
        left.timestampMs - right.timestampMs ||
        left.channelIndex - right.channelIndex,
    );
  return Object.freeze({
    channels: Object.freeze(channels),
    samples: Object.freeze(samples),
    channelsChanged,
  });
}

/**
 * Retain complete sample groups (one durable `seq` per plotted row). Trimming
 * by rows rather than scalar values keeps multi-channel samples atomic and
 * makes the session aggregate match the 600-row canvas cache exactly.
 */
function retainLatestWaveformGroups(
  samples: readonly SessionWaveformSample[],
): readonly SessionWaveformSample[] {
  const sequences = [...new Set(samples.map((sample) => sample.seq))].sort(
    (left, right) => left - right,
  );
  if (sequences.length <= SESSION_WAVEFORM_MAX_GROUPS) return samples;
  const retained = new Set(sequences.slice(-SESSION_WAVEFORM_MAX_GROUPS));
  return samples.filter((sample) => retained.has(sample.seq));
}

function isWaveformChannelIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 7;
}

function isWaveformFrameCursor(cursor: SessionWaveformFrameCursor): boolean {
  return Boolean(
    cursor &&
    Number.isSafeInteger(cursor.consumed) &&
    cursor.consumed >= 0 &&
    (cursor.lastFrameId === null || typeof cursor.lastFrameId === 'string'),
  );
}
