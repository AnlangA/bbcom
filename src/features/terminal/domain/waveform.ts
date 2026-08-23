/** How the waveform sources its samples: free-text RX parsing or Modbus regs. */
export type WaveformSourceMode = 'text' | 'register';

/** One durable sequence is one plotted row; UI and workspace retain this many. */
export const SESSION_WAVEFORM_MAX_GROUPS = 600;

/** Persistable display configuration for one of the eight waveform channels. */
export interface SessionWaveformChannel {
  readonly channelIndex: number;
  readonly config: Readonly<Record<string, unknown>>;
}

/** One scalar sample in the workspace waveform table. */
export interface SessionWaveformSample {
  readonly channelIndex: number;
  readonly seq: number;
  readonly timestampMs: number;
  readonly value: number;
}

/**
 * Runtime input accepted by the session-owned waveform aggregate. Inputs with
 * the same `group` receive the same durable sequence number, allowing a
 * multi-channel text row to round-trip as one plotted sample.
 */
export interface SessionWaveformSampleInput {
  readonly channelIndex: number;
  readonly group: number;
  readonly timestampMs: number;
  readonly value: number;
}

/** Cursor used to consume shallow frame arrays exactly once across restarts. */
export interface SessionWaveformFrameCursor {
  readonly consumed: number;
  readonly lastFrameId: string | null;
}

/**
 * Session/application-owned waveform state. The cursor is persisted with the
 * text/register source preference so frames captured while this panel is not
 * mounted are deterministically derived after the next open.
 */
export interface SessionWaveformState {
  readonly channels: readonly SessionWaveformChannel[];
  readonly samples: readonly SessionWaveformSample[];
  readonly frameCursor: SessionWaveformFrameCursor;
}
