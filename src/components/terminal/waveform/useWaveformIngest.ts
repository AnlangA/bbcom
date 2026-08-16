import { computed, ref, watch } from 'vue';
import type {
  DataFrame,
  SessionWaveformFrameCursor,
  SessionWaveformSampleInput,
  SessionWaveformState,
} from '../../../types';
import { SESSION_WAVEFORM_MAX_GROUPS } from '../../../types';
import {
  channelStats,
  createBuffer,
  ensureWaveformChannels,
  ingestWaveformTextFrames,
  planWaveformFrameIngest,
  pushRegisterWaveformSample,
  pushSample,
  waveformFrameCursorAtEnd,
  type ChannelStats,
  type WaveformChannelState,
  type WaveformFrameCursor,
} from '../../../lib/waveform';

export interface RegisterWaveformSampleInput {
  channel: number;
  value: number;
  timestamp?: number;
}

export interface WaveformFrameIngestCommit {
  mode: 'append' | 'replace';
  samples: readonly SessionWaveformSampleInput[];
  cursor: SessionWaveformFrameCursor;
}

export interface WaveformIngestOptions {
  frames(): readonly DataFrame[];
  framesVersion(): number | undefined;
  mode(): 'text' | 'register' | undefined;
  direction(): DataFrame['direction'] | undefined;
  canAppend(): boolean | undefined;
  canEdit(): boolean | undefined;
  waveform(): SessionWaveformState;
  onAppendSamples(samples: readonly SessionWaveformSampleInput[]): void;
  onCommitFrameIngest(ingest: Readonly<WaveformFrameIngestCommit>): void;
  onUpdateFrameCursor(cursor: SessionWaveformFrameCursor): void;
  onClear(cursor: SessionWaveformFrameCursor): void;
  /** Keep the time viewport pinned after new samples landed (viewport hook). */
  syncViewportAfterSampleChange(previousTimestamps: readonly number[]): void;
  /** Reset the viewport (and hover cursor) after a buffer clear (viewport hook). */
  resetViewport(): void;
  scheduleRender(): void;
}

/**
 * Frame ingest state for the waveform panel: the bounded sample buffer,
 * channel state, the durable frame cursor, and the Wave-1 dirty-check that
 * skips full re-hydration when the durable waveform only advanced its cursor.
 */
export function useWaveformIngest(options: WaveformIngestOptions) {
  const CAPACITY = SESSION_WAVEFORM_MAX_GROUPS;
  const buffer = createBuffer(CAPACITY);
  const waveformVersion = ref(0);
  const channelState = ref<WaveformChannelState[]>([]);
  // When paused, new frames are still consumed (so the offset stays aligned)
  // but their samples are dropped — freezing the plot at its last position.
  const paused = ref(false);

  let frameCursor: WaveformFrameCursor = { ...options.waveform().frameCursor };

  const sampleCountView = computed(() => {
    void waveformVersion.value;
    return buffer.samples.length;
  });

  const statsView = computed<ChannelStats[]>(() => {
    void waveformVersion.value;
    return channelStats(buffer, channelState.value.length);
  });

  function ingestNewFrames(): boolean {
    // Register mode is fed imperatively by the master (pushRegisterSample); the
    // text-parsing path only runs in text mode.
    if ((options.mode() ?? 'text') === 'register') {
      frameCursor = waveformFrameCursorAtEnd(options.frames());
      if (options.canAppend() !== false) options.onUpdateFrameCursor(frameCursor);
      return false;
    }

    if (options.canAppend() === false) return false;

    const previousChannelCount = channelState.value.length;
    const previousTimestamps = buffer.timestamps.slice();
    const plan = planWaveformFrameIngest(options.frames(), frameCursor);
    frameCursor = plan.nextCursor;
    if (plan.reset) resetWaveformBuffer({ clearChannels: true });
    if (plan.startIndex >= options.frames().length) {
      options.onCommitFrameIngest({
        mode: plan.reset ? 'replace' : 'append',
        samples: [],
        cursor: frameCursor,
      });
      return plan.reset;
    }

    const result = ingestWaveformTextFrames(buffer, options.frames(), {
      startIndex: plan.startIndex,
      direction: options.direction() ?? 'RX',
      paused: paused.value,
      channels: channelState.value,
    });
    channelState.value = result.channels;
    frameCursor = waveformFrameCursorAtEnd(options.frames());
    options.onCommitFrameIngest({
      mode: plan.reset ? 'replace' : 'append',
      samples:
        result.pushedSamples > 0
          ? plan.reset
            ? waveformInputsFromRows(0)
            : waveformInputsFromRecentRows(result.pushedSamples)
          : [],
      cursor: frameCursor,
    });
    if (!plan.reset && result.pushedSamples > 0) {
      options.syncViewportAfterSampleChange(previousTimestamps);
    }
    return (
      plan.reset || result.pushedSamples > 0 || result.channels.length !== previousChannelCount
    );
  }

  /** Push decoded register values onto channels (register mode), called by the
   * Modbus master on each poll tick. Grows the channel list to fit the channel
   * index and updates the legend readout. */
  function pushRegisterSamples(samples: readonly RegisterWaveformSampleInput[]) {
    if (samples.length === 0 || options.canAppend() === false) return;
    const previousTimestamps = buffer.timestamps.slice();
    let channels = channelState.value;
    let pushedSamples = 0;
    for (const sample of samples) {
      if (!Number.isInteger(sample.channel) || sample.channel < 0 || sample.channel > 7) continue;
      const result = pushRegisterWaveformSample(
        buffer,
        channels,
        sample.channel,
        sample.value,
        paused.value,
        sample.timestamp,
      );
      channels = result.channels;
      if (result.pushed) pushedSamples += 1;
    }
    channelState.value = channels;
    if (pushedSamples > 0) {
      options.onAppendSamples(waveformInputsFromRecentRows(pushedSamples));
      options.syncViewportAfterSampleChange(previousTimestamps);
      invalidateWaveform();
    }
  }

  function pushRegisterSample(channel: number, value: number, timestamp = Date.now()) {
    pushRegisterSamples([{ channel, value, timestamp }]);
  }

  function clearBuffer() {
    if (options.canEdit() === false) return;
    frameCursor = waveformFrameCursorAtEnd(options.frames());
    options.onClear(frameCursor);
    resetWaveformBuffer({ clearChannels: true });
    invalidateWaveform();
  }

  function resetWaveformBuffer(resetOptions: { clearChannels: boolean }) {
    buffer.samples.length = 0;
    buffer.timestamps.length = 0;
    buffer.originTimestamp = null;
    buffer.totalDroppedSamples = 0;
    options.resetViewport();
    if (resetOptions.clearChannels) {
      channelState.value = [];
    } else {
      channelState.value = channelState.value.map((channel) => ({ ...channel, latest: null }));
    }
  }

  function waveformInputsFromRecentRows(rowCount: number): SessionWaveformSampleInput[] {
    return waveformInputsFromRows(Math.max(0, buffer.samples.length - rowCount));
  }

  function waveformInputsFromRows(startIndex: number): SessionWaveformSampleInput[] {
    const inputs: SessionWaveformSampleInput[] = [];
    for (let rowIndex = Math.max(0, startIndex); rowIndex < buffer.samples.length; rowIndex += 1) {
      const row = buffer.samples[rowIndex];
      const timestampMs = Math.max(0, Math.round(buffer.timestamps[rowIndex] ?? 0));
      const group = rowIndex - Math.max(0, startIndex);
      for (let channelIndex = 0; channelIndex < Math.min(row.length, 8); channelIndex += 1) {
        const value = row[channelIndex];
        if (!Number.isFinite(value)) continue;
        inputs.push({ channelIndex, group, timestampMs, value });
      }
    }
    return inputs;
  }

  /** Rebuild the bounded canvas cache from the session-owned durable rows. */
  function hydrateSharedWaveform(): void {
    resetWaveformBuffer({ clearChannels: true });
    const waveform = options.waveform();
    frameCursor = { ...waveform.frameCursor };
    const maximumChannel = waveform.channels.reduce(
      (maximum, channel) => Math.max(maximum, channel.channelIndex),
      -1,
    );
    let channels = ensureWaveformChannels([], maximumChannel + 1);
    for (const persisted of waveform.channels) {
      const fallback = channels[persisted.channelIndex];
      if (!fallback) continue;
      const color =
        typeof persisted.config.color === 'string' && persisted.config.color.length > 0
          ? persisted.config.color
          : fallback.color;
      channels[persisted.channelIndex] = {
        color,
        latest: null,
        visible: persisted.config.visible !== false,
      };
    }

    const orderedSamples = [...waveform.samples].sort(
      (left, right) =>
        left.seq - right.seq ||
        left.timestampMs - right.timestampMs ||
        left.channelIndex - right.channelIndex,
    );
    const latest = Array.from({ length: channels.length }, () => 0);
    const sampledChannels = new Set<number>();
    for (let offset = 0; offset < orderedSamples.length;) {
      const sequence = orderedSamples[offset].seq;
      const groupTimestamp = orderedSamples[offset].timestampMs;
      const row = latest.slice();
      while (
        offset < orderedSamples.length &&
        orderedSamples[offset].seq === sequence &&
        orderedSamples[offset].timestampMs === groupTimestamp
      ) {
        const sample = orderedSamples[offset];
        row[sample.channelIndex] = sample.value;
        latest[sample.channelIndex] = sample.value;
        sampledChannels.add(sample.channelIndex);
        offset += 1;
      }
      pushSample(buffer, row, groupTimestamp);
    }
    channels = channels.map((channel, channelIndex) => ({
      ...channel,
      latest: sampledChannels.has(channelIndex) ? (latest[channelIndex] ?? null) : null,
    }));
    channelState.value = channels;
    waveformVersion.value += 1;
    options.scheduleRender();
  }

  function invalidateWaveform() {
    waveformVersion.value += 1;
    options.scheduleRender();
  }

  watch(
    () => options.waveform(),
    (next, prev) => {
      // Cursor-only ticks (the common streaming case: the UI advanced the durable
      // frame cursor without parsing new samples) reuse the exact channel and
      // sample arrays, so reference equality proves no plotted data changed.
      // Skip the full re-hydration (sort + rebuild + canvas buffer reset) and
      // only refresh the local cursor that consumes `props.frames` exactly once.
      if (prev && next.channels === prev.channels && next.samples === prev.samples) {
        frameCursor = { ...next.frameCursor };
        return;
      }
      hydrateSharedWaveform();
    },
  );

  watch(
    () => [options.framesVersion(), options.frames().length] as const,
    () => {
      if (ingestNewFrames()) invalidateWaveform();
    },
  );

  watch(
    () => [options.mode() ?? 'text', options.direction() ?? 'RX'] as const,
    () => {
      frameCursor = waveformFrameCursorAtEnd(options.frames());
      if (options.canEdit() !== false) options.onClear(frameCursor);
      resetWaveformBuffer({ clearChannels: true });
      invalidateWaveform();
    },
  );

  return {
    buffer,
    waveformVersion,
    channelState,
    paused,
    sampleCountView,
    statsView,
    ingestNewFrames,
    pushRegisterSample,
    pushRegisterSamples,
    clearBuffer,
    hydrateSharedWaveform,
    invalidateWaveform,
  };
}

export type WaveformIngest = ReturnType<typeof useWaveformIngest>;
export type WaveformBuffer = ReturnType<typeof createBuffer>;
