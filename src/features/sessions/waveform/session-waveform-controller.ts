import type {
  SessionWaveformChannel,
  SessionWaveformFrameCursor,
  SessionWaveformSample,
  SessionWaveformSampleInput,
  SessionWaveformState,
} from '@/types';
import { SESSION_WAVEFORM_MAX_GROUPS } from '@/types';

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

/**
 * Incremental view of one session's durable sample list for the O(1)
 * group-retention check: the total sample count plus the sample count per
 * group (`seq`). `retainLatestWaveformGroups` trims exactly when the distinct
 * group count exceeds `SESSION_WAVEFORM_MAX_GROUPS`, so
 * `samplesByGroup.size` decides that question without walking the list.
 */
interface WaveformRetentionCounters {
  totalSamples: number;
  samplesByGroup: Map<number, number>;
}

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

  /**
   * Largest assigned sample sequence per session, maintained incrementally on
   * the hot append path so `buildWaveformAppend` never reduces over the whole
   * bounded sample list. Kept in lockstep with `stateBySessionId` and rebuilt
   * wholesale by every wholesale state replacement; `trackedMaxSequence`
   * validates the pairing before trusting it.
   */
  let lastSequenceBySessionId = new Map<string, number>();

  /**
   * Group-retention counters per session, maintained incrementally on the hot
   * append path (O(appended) per tick) so a no-overflow append can skip the
   * O(total) Set+sort inside `retainLatestWaveformGroups`. Kept in lockstep
   * with `stateBySessionId` exactly like `lastSequenceBySessionId`: rebuilt
   * wholesale by every full-state replacement and validated by the same
   * identity guard before being trusted (`trackedRetention`).
   */
  let retentionBySessionId = new Map<string, WaveformRetentionCounters>();

  function commitState(next: SessionWaveformStateBySessionId): void {
    stateBySessionId = Object.freeze({ ...next });
    dependencies.onStateChanged(stateBySessionId);
  }

  function trackedMaxSequence(sessionId: string, current: SessionWaveformState): number {
    const tracked = lastSequenceBySessionId.get(sessionId);
    if (tracked !== undefined && stateBySessionId[sessionId] === current) return tracked;
    return sampleListMaxSequence(current.samples, -1);
  }

  function replaceLastSequenceIndex(state: SessionWaveformStateBySessionId): void {
    const next = new Map<string, number>();
    for (const [sessionId, waveform] of Object.entries(state)) {
      next.set(sessionId, sampleListMaxSequence(waveform.samples, -1));
    }
    lastSequenceBySessionId = next;
  }

  function trackedRetention(
    sessionId: string,
    current: SessionWaveformState,
  ): WaveformRetentionCounters {
    const tracked = retentionBySessionId.get(sessionId);
    if (tracked !== undefined && stateBySessionId[sessionId] === current) return tracked;
    return countWaveformSamples(current.samples);
  }

  function replaceRetentionCounters(state: SessionWaveformStateBySessionId): void {
    const next = new Map<string, WaveformRetentionCounters>();
    for (const [sessionId, waveform] of Object.entries(state)) {
      next.set(sessionId, countWaveformSamples(waveform.samples));
    }
    retentionBySessionId = next;
  }

  /**
   * Merge one append tail under the group-retention bound. While the tracked
   * counters show at most `SESSION_WAVEFORM_MAX_GROUPS` distinct groups, the
   * merged list provably survives `retainLatestWaveformGroups` unchanged, so
   * the O(total) Set+sort trim is skipped for `current.samples.concat(tail)`.
   * Once the bound is exceeded the existing full trim runs once and the
   * counters are rebuilt from its result, keeping the next append exact.
   */
  function appendSamplesWithRetention(
    sessionId: string,
    current: SessionWaveformState,
    appended: readonly SessionWaveformSample[],
  ): Readonly<{ samples: readonly SessionWaveformSample[]; overflowed: boolean }> {
    const counters = trackedRetention(sessionId, current);
    counters.totalSamples += appended.length;
    for (const sample of appended) {
      counters.samplesByGroup.set(sample.seq, (counters.samplesByGroup.get(sample.seq) ?? 0) + 1);
    }
    if (counters.samplesByGroup.size <= SESSION_WAVEFORM_MAX_GROUPS) {
      retentionBySessionId.set(sessionId, counters);
      return { samples: current.samples.concat(appended), overflowed: false };
    }
    const unboundedSamples = [...current.samples, ...appended];
    const nextSamples = retainLatestWaveformGroups(unboundedSamples);
    retentionBySessionId.set(sessionId, countWaveformSamples(nextSamples));
    return {
      samples: nextSamples,
      overflowed: nextSamples.length !== unboundedSamples.length,
    };
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

  function replacePrepared(state: SessionWaveformStateBySessionId): void {
    replaceLastSequenceIndex(state);
    replaceRetentionCounters(state);
    commitState(state);
  }

  function replaceWithEmptySessions(sessionIds: readonly string[]): void {
    lastSequenceBySessionId = new Map(sessionIds.map((sessionId) => [sessionId, -1]));
    retentionBySessionId = new Map(
      sessionIds.map((sessionId) => [sessionId, emptyRetentionCounters()]),
    );
    commitState(
      Object.fromEntries(sessionIds.map((sessionId) => [sessionId, emptyWaveformState()])),
    );
  }

  function addEmptySessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    for (const sessionId of sessionIds) {
      lastSequenceBySessionId.set(sessionId, -1);
      retentionBySessionId.set(sessionId, emptyRetentionCounters());
    }
    commitState({
      ...stateBySessionId,
      ...Object.fromEntries(sessionIds.map((sessionId) => [sessionId, emptyWaveformState()])),
    });
  }

  function addEmptySession(sessionId: string): void {
    lastSequenceBySessionId.set(sessionId, -1);
    retentionBySessionId.set(sessionId, emptyRetentionCounters());
    updateSession(sessionId, emptyWaveformState());
  }

  function restoreSession(sessionId: string, state: SessionWaveformState): void {
    const cloned = cloneWaveformState(state);
    lastSequenceBySessionId.set(sessionId, sampleListMaxSequence(cloned.samples, -1));
    retentionBySessionId.set(sessionId, countWaveformSamples(cloned.samples));
    updateSession(sessionId, cloned);
  }

  function removeSession(sessionId: string): void {
    const next = { ...stateBySessionId };
    delete next[sessionId];
    lastSequenceBySessionId.delete(sessionId);
    retentionBySessionId.delete(sessionId);
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
    const maxSequence = trackedMaxSequence(sessionId, current);
    const appended = buildWaveformAppend(current.channels, inputs, maxSequence);
    if (!appended) return false;
    const merged = appendSamplesWithRetention(sessionId, current, appended.samples);
    const next = freezeAppendedWaveformState({
      channels: appended.channels,
      samples: merged.samples,
      frameCursor: current.frameCursor,
    });
    lastSequenceBySessionId.set(sessionId, sampleListMaxSequence(appended.samples, maxSequence));
    updateSession(sessionId, next);
    dependencies.onChange(
      merged.overflowed || appended.channelsChanged
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
    const rebuilt = inputs.length === 0 ? null : buildWaveformAppend(empty.channels, inputs, -1);
    if (inputs.length > 0 && !rebuilt) return false;
    const next = freezeWaveformState({
      channels: rebuilt?.channels ?? [],
      samples: retainLatestWaveformGroups(rebuilt?.samples ?? []),
      frameCursor: current.frameCursor,
    });
    lastSequenceBySessionId.set(sessionId, sampleListMaxSequence(next.samples, -1));
    retentionBySessionId.set(sessionId, countWaveformSamples(next.samples));
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
    lastSequenceBySessionId.set(sessionId, -1);
    retentionBySessionId.set(sessionId, emptyRetentionCounters());
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
    updateSession(sessionId, freezeAppendedWaveformState({ ...current, frameCursor: nextCursor }));
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
      const rebuilt = inputs.length === 0 ? null : buildWaveformAppend(empty.channels, inputs, -1);
      if (inputs.length > 0 && !rebuilt) return false;
      nextChannels = rebuilt?.channels ?? [];
      nextSamples = retainLatestWaveformGroups(rebuilt?.samples ?? []);
      committedSamples = nextSamples;
    } else if (inputs.length > 0) {
      const maxSequence = trackedMaxSequence(sessionId, current);
      const appended = buildWaveformAppend(current.channels, inputs, maxSequence);
      if (!appended) return false;
      nextChannels = appended.channels;
      const merged = appendSamplesWithRetention(sessionId, current, appended.samples);
      nextSamples = merged.samples;
      committedSamples = appended.samples;
      lastSequenceBySessionId.set(sessionId, sampleListMaxSequence(appended.samples, maxSequence));
      if (appended.channelsChanged || merged.overflowed) {
        persistedMode = 'replace';
        committedSamples = nextSamples;
      }
    }

    // Both append ticks (cursor-only and sample-bearing) reuse lists whose
    // invariants hold by construction; only `replace` rebuilds from untrusted
    // inputs and therefore needs the validating freeze.
    const next =
      mode === 'replace'
        ? freezeWaveformState({
            channels: nextChannels,
            samples: nextSamples,
            frameCursor: Object.freeze({ ...cursor }),
          })
        : freezeAppendedWaveformState({
            channels: nextChannels,
            samples: nextSamples,
            frameCursor: Object.freeze({ ...cursor }),
          });
    if (mode === 'replace') {
      lastSequenceBySessionId.set(sessionId, sampleListMaxSequence(next.samples, -1));
      retentionBySessionId.set(sessionId, countWaveformSamples(next.samples));
    }
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
    replacePrepared,
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

/**
 * Append-path freeze. Cursor-only and append-tail commits reuse channel and
 * sample lists that were either already validated by a previous full freeze or
 * constructed by `buildWaveformAppend`, which validates every input and assigns
 * strictly increasing sequence numbers above the current maximum. The merged
 * list therefore stays sorted, key-unique and channel-valid BY CONSTRUCTION —
 * re-walking up to SESSION_WAVEFORM_MAX_GROUPS x 8 samples on every streaming
 * tick would only re-prove those invariants. Replace, reset and hydrate paths
 * keep the full `freezeWaveformState` validation.
 */
function freezeAppendedWaveformState(state: SessionWaveformState): SessionWaveformState {
  if (!isWaveformFrameCursor(state.frameCursor)) throw new Error('invalid waveform frame cursor');
  return Object.freeze({
    channels: state.channels,
    samples: state.samples,
    frameCursor: Object.freeze({ ...state.frameCursor }),
  });
}

/** Largest sequence in an ascending-ordered sample list, or `fallback` if empty. */
function sampleListMaxSequence(
  samples: readonly SessionWaveformSample[],
  fallback: number,
): number {
  return samples.length > 0 ? samples[samples.length - 1].seq : fallback;
}

function emptyRetentionCounters(): WaveformRetentionCounters {
  return { totalSamples: 0, samplesByGroup: new Map() };
}

/** Rebuild the incremental retention counters from a durable sample list. */
function countWaveformSamples(
  samples: readonly SessionWaveformSample[],
): WaveformRetentionCounters {
  const samplesByGroup = new Map<number, number>();
  for (const sample of samples) {
    samplesByGroup.set(sample.seq, (samplesByGroup.get(sample.seq) ?? 0) + 1);
  }
  return { totalSamples: samples.length, samplesByGroup };
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

/**
 * Build the sample/channel tail for one append. `maxSequence` is the tracked
 * largest sequence already in the state, so new groups receive strictly
 * increasing numbers above it without reducing over the whole sample list.
 */
function buildWaveformAppend(
  currentChannels: readonly SessionWaveformChannel[],
  inputs: readonly SessionWaveformSampleInput[],
  maxSequence: number,
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
  const sortedGroups = [...groups].sort((left, right) => left - right);
  if (maxSequence + sortedGroups.length > Number.MAX_SAFE_INTEGER) return null;
  const sequenceByGroup = new Map(
    sortedGroups.map((group, index) => [group, maxSequence + index + 1] as const),
  );
  const channelsByIndex = new Map(
    currentChannels.map((channel) => [channel.channelIndex, channel] as const),
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
