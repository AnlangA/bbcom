/**
 * Transport-agnostic protocol engine interface (T3.6).
 *
 * A `ProtocolEngine` consumes an arbitrary RX byte stream and emits discrete
 * frames. It is the abstraction every protocol implementation satisfies, so the
 * frame pipeline (record/replay, the parser panel, future CAN/custom-binary
 * engines) can treat them uniformly without knowing the wire format.
 *
 * The existing {@link ProtocolParser} (delimiter / length / fixed) is the
 * reference implementation; `toProtocolEngine` adapts it to this interface so
 * call sites can depend on `ProtocolEngine` rather than the concrete class.
 *
 * Design: stateful (retains a partial frame across feeds) but pure — no DOM/Vue
 * deps, so it is fully unit-testable. `feed` is idempotent w.r.t. empty input.
 */

/** A discrete frame emitted by a protocol engine. */
export interface ProtocolFrame {
  /** Raw frame bytes. */
  data: Uint8Array;
  /** Index of the first byte of this frame within the original stream. */
  offset: number;
}

/** The contract every protocol implementation satisfies. */
export interface ProtocolEngine {
  /** Human-readable name (e.g. "delimiter:0D0A", "fixed:64", "modbus-rtu"). */
  readonly name: string;
  /** Append bytes and return any frames that became complete in this batch. */
  feed(bytes: Uint8Array): ProtocolFrame[];
  /** Drop all buffered/partial state (e.g. on a user-requested flush). */
  reset(): void;
  /** Number of bytes currently held in the partial buffer. */
  readonly pending: number;
}

/** Adapt the existing {@link ProtocolParser} to the {@link ProtocolEngine} interface. */
export function toProtocolEngine(parser: {
  feed(input: Uint8Array): { data: Uint8Array; offset: number }[];
  reset(): void;
  pending: number;
  config: unknown;
}): ProtocolEngine {
  return {
    name: parserConfigName(parser.config),
    feed: (bytes) => parser.feed(bytes),
    reset: () => parser.reset(),
    get pending() {
      return parser.pending;
    },
  };
}

/** Derive a stable name from a parser config (for the engine's `name` field). */
function parserConfigName(config: unknown): string {
  if (config && typeof config === 'object' && 'kind' in config) {
    const kind = (config as { kind: string }).kind;
    if (kind === 'fixed' && 'frameSize' in config) {
      return `fixed:${(config as { frameSize: number }).frameSize}`;
    }
    if (kind === 'delimiter' && 'delimiter' in config) {
      const delim = (config as { delimiter: number[] }).delimiter;
      return `delimiter:${delim.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
    }
    if (kind === 'length') {
      return `length:${(config as unknown as { lengthSize: number }).lengthSize}B`;
    }
    return kind;
  }
  return 'unknown';
}
