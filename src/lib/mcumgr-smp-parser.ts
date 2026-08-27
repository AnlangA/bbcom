import { base64ToBytes } from './base64';
import {
  cborInteger,
  cborMapValue,
  cborText,
  decodeBoundedSmpCbor,
  type CborNode,
} from './mcumgr-smp-cbor';
import {
  expectedResponseOp,
  isKnownSmpCommand,
  smpCommandName,
  smpCommandNameZh,
  smpGroupName,
  smpGroupNameZh,
  smpOpName,
  smpOpNameZh,
  smpRequestResponse,
  type SmpRequestResponse,
} from './mcumgr-smp-metadata';
import type { SmpParserTransport } from './protocol-parser';

export const SMP_HEADER_BYTES = 8;
export const SMP_CONSOLE_INITIAL_MARKER = Object.freeze([0x06, 0x09] as const);
export const SMP_CONSOLE_CONTINUATION_MARKER = Object.freeze([0x04, 0x14] as const);
export const DEFAULT_SMP_MAX_PENDING_REQUESTS = 256;
export const DEFAULT_SMP_REQUEST_TIMEOUT_MS = 30_000;

export interface McumgrSmpParserConfig {
  transport: SmpParserTransport;
  maxPacketBytes: number;
  reassemblyTimeoutMs: number;
}

export interface SmpTrafficChunk {
  direction: 'TX' | 'RX';
  data: Uint8Array;
  timestamp: number;
  captureSeq?: number;
}

export interface SmpDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  offset?: number;
  length?: number;
}

export interface SmpByteRange {
  offset: number;
  length: number;
}

export interface SmpHeader {
  version: number;
  versionBits: number;
  op: number;
  opName: string;
  opNameZh: string;
  requestResponse: SmpRequestResponse;
  flags: number;
  dataLength: number;
  group: number;
  groupName: string;
  groupNameZh: string;
  sequence: number;
  command: number;
  commandName: string;
  commandNameZh: string;
}

export interface SmpRecord {
  kind: 'smp';
  id: string;
  direction: 'TX' | 'RX';
  timestamp: number;
  captureSeq?: number;
  /** Canonical SMP message bytes; transport errors use the offending wire bytes. */
  data: Uint8Array;
  length: number;
  /** Direction-local byte offset at which the transport unit started. */
  offset: number;
  endOffset: number;
  status: 'ok' | 'warning' | 'error' | 'pending';
  summary: string;
  diagnostics: SmpDiagnostic[];
  transport: SmpParserTransport;
  crcStatus: 'valid' | 'invalid' | 'not-applicable' | 'unknown';
  transportData?: Uint8Array;
  header?: SmpHeader;
  cbor?: CborNode;
  requestId?: string;
  responseId?: string;
  rttMs?: number;
  ranges: {
    transport?: SmpByteRange;
    header?: SmpByteRange;
    payload?: SmpByteRange;
  };
}

interface ConsoleAssembly {
  expectedBytes: number;
  body: Uint8Array;
  wireParts: Uint8Array[];
  timestamp: number;
  captureSeq?: number;
  offset: number;
  lastTimestamp: number;
}

interface DirectionState {
  inputOffset: number;
  lineBuffer: Uint8Array;
  lineBufferOffset: number;
  lineTimestamp: number;
  lineCaptureSeq?: number;
  lineLastTimestamp: number;
  console: ConsoleAssembly | null;
  rawBuffer: Uint8Array;
  rawOffset: number;
  rawTimestamp: number;
  rawCaptureSeq?: number;
  rawLastTimestamp: number;
  rawSegments: RawSegment[];
}

interface RawSegment {
  endOffset: number;
  timestamp: number;
  captureSeq?: number;
}

interface PendingRequest {
  record: SmpRecord;
  expectedOp: number;
  expiresAt: number;
}

interface TransportContext {
  direction: 'TX' | 'RX';
  timestamp: number;
  captureSeq?: number;
  offset: number;
  transportData?: Uint8Array;
  crcStatus: SmpRecord['crcStatus'];
  diagnostics: SmpDiagnostic[];
}

const KNOWN_GROUPS = new Set([0, 1, 2, 3, 8, 9, 10, 11, 63]);
const ASCII = new TextDecoder('ascii');

export class McumgrSmpParser {
  readonly config: McumgrSmpParserConfig;

  private readonly states: Record<'TX' | 'RX', DirectionState> = {
    TX: createDirectionState(),
    RX: createDirectionState(),
  };
  private readonly pendingRequests: PendingRequest[] = [];
  private nextRecordNumber = 1;

  constructor(config: McumgrSmpParserConfig) {
    if (config.transport !== 'serial-console' && config.transport !== 'raw-uart') {
      throw new RangeError('unsupported SMP transport');
    }
    if (!Number.isInteger(config.maxPacketBytes) || config.maxPacketBytes < SMP_HEADER_BYTES) {
      throw new RangeError('SMP maxPacketBytes must be at least 8');
    }
    if (!Number.isInteger(config.reassemblyTimeoutMs) || config.reassemblyTimeoutMs < 1) {
      throw new RangeError('SMP reassemblyTimeoutMs must be positive');
    }
    this.config = { ...config };
  }

  feed(chunk: SmpTrafficChunk): SmpRecord[] {
    if (chunk.data.length === 0) return this.flushExpired(chunk.timestamp);

    const expired = this.flushExpired(chunk.timestamp);
    const state = this.states[chunk.direction];
    const chunkOffset = state.inputOffset;
    state.inputOffset += chunk.data.length;
    const decoded =
      this.config.transport === 'serial-console'
        ? this.feedConsole(state, chunk, chunkOffset)
        : this.feedRaw(state, chunk, chunkOffset);
    return expired.concat(decoded);
  }

  flushExpired(now: number): SmpRecord[] {
    const records: SmpRecord[] = [];
    for (const direction of ['TX', 'RX'] as const) {
      const state = this.states[direction];
      const console = state.console;
      const partialLine = hasPotentialConsoleMarker(state.lineBuffer);
      const consoleLastTimestamp = partialLine ? state.lineLastTimestamp : console?.lastTimestamp;
      if (
        (console || partialLine) &&
        consoleLastTimestamp !== undefined &&
        now - consoleLastTimestamp >= this.config.reassemblyTimeoutMs
      ) {
        const wire = console
          ? concatBytes(partialLine ? [...console.wireParts, state.lineBuffer] : console.wireParts)
          : sliceCopy(state.lineBuffer);
        records.push(
          this.transportErrorRecord(
            direction,
            console?.timestamp ?? state.lineTimestamp,
            console?.captureSeq ?? state.lineCaptureSeq,
            console?.offset ?? state.lineBufferOffset,
            wire,
            'smp.console.timeout',
            'Serial Console packet reassembly timed out',
          ),
        );
        state.console = null;
        if (partialLine) resetConsoleLineState(state);
      }
      if (
        state.rawBuffer.length > 0 &&
        now - state.rawLastTimestamp >= this.config.reassemblyTimeoutMs
      ) {
        records.push(
          this.transportErrorRecord(
            direction,
            state.rawTimestamp,
            state.rawCaptureSeq,
            state.rawOffset,
            state.rawBuffer,
            'smp.raw.timeout',
            'Raw UART packet reassembly timed out',
          ),
        );
        resetRawState(state);
      }
    }

    this.expirePendingRequests(now);
    return records;
  }

  /** Earliest wall/capture timestamp at which parser state needs expiry work. */
  nextExpiryTimestamp(): number | null {
    let next: number | null = null;
    for (const direction of ['TX', 'RX'] as const) {
      const state = this.states[direction];
      const partialLine = hasPotentialConsoleMarker(state.lineBuffer);
      const consoleLastTimestamp = partialLine
        ? state.lineLastTimestamp
        : state.console?.lastTimestamp;
      if ((state.console || partialLine) && consoleLastTimestamp !== undefined) {
        next = earlierTimestamp(next, consoleLastTimestamp + this.config.reassemblyTimeoutMs);
      }
      if (state.rawBuffer.length > 0) {
        next = earlierTimestamp(next, state.rawLastTimestamp + this.config.reassemblyTimeoutMs);
      }
    }
    for (const pending of this.pendingRequests) {
      next = earlierTimestamp(next, pending.expiresAt);
    }
    return next;
  }

  reset(): void {
    this.states.TX = createDirectionState();
    this.states.RX = createDirectionState();
    this.pendingRequests.length = 0;
    this.nextRecordNumber = 1;
  }

  /** Emit a parser-runtime diagnostic through the same record model as wire errors. */
  diagnostic(input: {
    direction: 'TX' | 'RX';
    timestamp: number;
    captureSeq?: number;
    code: string;
    message: string;
    severity?: SmpDiagnostic['severity'];
    data?: Uint8Array;
  }): SmpRecord {
    const state = this.states[input.direction];
    return this.transportErrorRecord(
      input.direction,
      input.timestamp,
      input.captureSeq,
      state.inputOffset,
      input.data ?? new Uint8Array(0),
      input.code,
      input.message,
      input.severity ?? 'warning',
    );
  }

  private feedConsole(
    state: DirectionState,
    chunk: SmpTrafficChunk,
    chunkOffset: number,
  ): SmpRecord[] {
    if (state.lineBuffer.length === 0) {
      state.lineBufferOffset = chunkOffset;
      state.lineTimestamp = chunk.timestamp;
      state.lineCaptureSeq = chunk.captureSeq;
    }
    state.lineLastTimestamp = chunk.timestamp;
    state.lineBuffer = concatBytes([state.lineBuffer, chunk.data]);

    const records: SmpRecord[] = [];
    while (true) {
      const newline = state.lineBuffer.indexOf(0x0a);
      if (newline < 0) break;

      const lineOffset = state.lineBufferOffset;
      const lineTimestamp = state.lineTimestamp;
      const lineCaptureSeq = state.lineCaptureSeq;
      const lineWithLf = sliceCopy(state.lineBuffer, 0, newline + 1);
      let line = lineWithLf.subarray(0, newline);
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      state.lineBuffer = sliceCopy(state.lineBuffer, newline + 1);
      state.lineBufferOffset = lineOffset + newline + 1;
      state.lineTimestamp = chunk.timestamp;
      state.lineCaptureSeq = chunk.captureSeq;

      records.push(
        ...this.consumeConsoleLine(
          state,
          line,
          lineWithLf,
          lineOffset,
          lineTimestamp,
          lineCaptureSeq,
          chunk.timestamp,
        ),
      );
    }

    const maxBufferedLine = Math.max(8_192, this.config.maxPacketBytes * 2);
    if (state.lineBuffer.length > maxBufferedLine) {
      const marker = findLastMarkerPrefix(state.lineBuffer);
      const discarded = sliceCopy(state.lineBuffer, 0, state.lineBuffer.length - marker.length);
      state.lineBuffer = marker;
      state.lineBufferOffset = state.inputOffset - marker.length;
      if (discarded.length > 0) {
        records.push(
          this.transportErrorRecord(
            chunk.direction,
            state.lineTimestamp,
            state.lineCaptureSeq,
            lineOffsetForChunk(chunkOffset, chunk.data.length, discarded.length),
            discarded,
            'smp.console.line-overflow',
            'Serial Console line exceeded the parser limit',
          ),
        );
      }
    }
    return records;
  }

  private consumeConsoleLine(
    state: DirectionState,
    line: Uint8Array,
    wireLine: Uint8Array,
    lineOffset: number,
    lineTimestamp: number,
    lineCaptureSeq: number | undefined,
    now: number,
    recoveryDepth = 0,
  ): SmpRecord[] {
    const marker = findConsoleMarker(line);
    if (!marker) return [];

    const records: SmpRecord[] = [];
    if (marker.kind === 'initial' && state.console) {
      records.push(
        this.transportErrorRecord(
          markerDirection(state, this.states),
          state.console.timestamp,
          state.console.captureSeq,
          state.console.offset,
          concatBytes(state.console.wireParts),
          'smp.console.restarted',
          'A new Serial Console packet started before the previous packet completed',
        ),
      );
      state.console = null;
    }

    let fragment: Uint8Array;
    try {
      const encoded = ASCII.decode(line.subarray(marker.index + 2)).replace(/\s+/g, '');
      fragment = base64ToBytes(encoded);
    } catch {
      records.push(
        this.transportErrorRecord(
          markerDirection(state, this.states),
          lineTimestamp,
          lineCaptureSeq,
          lineOffset + marker.index,
          wireLine,
          'smp.console.base64',
          'Serial Console fragment contains invalid Base64',
        ),
      );
      state.console = null;
      records.push(
        ...this.recoverNextConsoleInitial(
          state,
          line,
          wireLine,
          lineOffset,
          lineTimestamp,
          lineCaptureSeq,
          now,
          marker.index + 2,
          recoveryDepth,
        ),
      );
      return records;
    }

    if (marker.kind === 'initial') {
      if (fragment.length < 2) {
        records.push(
          this.transportErrorRecord(
            markerDirection(state, this.states),
            lineTimestamp,
            lineCaptureSeq,
            lineOffset + marker.index,
            wireLine,
            'smp.console.length-missing',
            'Serial Console initial fragment does not contain the packet length',
          ),
        );
        records.push(
          ...this.recoverNextConsoleInitial(
            state,
            line,
            wireLine,
            lineOffset,
            lineTimestamp,
            lineCaptureSeq,
            now,
            marker.index + 2,
            recoveryDepth,
          ),
        );
        return records;
      }
      const expectedBytes = readU16(fragment, 0);
      if (expectedBytes < SMP_HEADER_BYTES + 2 || expectedBytes > this.config.maxPacketBytes + 2) {
        records.push(
          this.transportErrorRecord(
            markerDirection(state, this.states),
            lineTimestamp,
            lineCaptureSeq,
            lineOffset + marker.index,
            wireLine,
            'smp.console.length-invalid',
            `Serial Console packet length ${expectedBytes} is outside the configured limit`,
          ),
        );
        records.push(
          ...this.recoverNextConsoleInitial(
            state,
            line,
            wireLine,
            lineOffset,
            lineTimestamp,
            lineCaptureSeq,
            now,
            marker.index + 2,
            recoveryDepth,
          ),
        );
        return records;
      }
      state.console = {
        expectedBytes,
        body: sliceCopy(fragment, 2),
        wireParts: [wireLine],
        timestamp: lineTimestamp,
        captureSeq: lineCaptureSeq,
        offset: lineOffset + marker.index,
        lastTimestamp: now,
      };
    } else {
      if (!state.console) {
        records.push(
          this.transportErrorRecord(
            markerDirection(state, this.states),
            lineTimestamp,
            lineCaptureSeq,
            lineOffset + marker.index,
            wireLine,
            'smp.console.orphan-continuation',
            'Serial Console continuation fragment has no initial fragment',
          ),
        );
        records.push(
          ...this.recoverNextConsoleInitial(
            state,
            line,
            wireLine,
            lineOffset,
            lineTimestamp,
            lineCaptureSeq,
            now,
            marker.index + 2,
            recoveryDepth,
          ),
        );
        return records;
      }
      state.console.body = concatBytes([state.console.body, fragment]);
      state.console.wireParts.push(wireLine);
      state.console.lastTimestamp = now;
    }

    const assembly = state.console;
    if (!assembly || assembly.body.length < assembly.expectedBytes) return records;

    const wireData = concatBytes(assembly.wireParts);
    const extraBytes = assembly.body.length - assembly.expectedBytes;
    const framed = assembly.body.subarray(0, assembly.expectedBytes);
    const packet = sliceCopy(framed, 0, framed.length - 2);
    const expectedCrc = readU16(framed, framed.length - 2);
    const actualCrc = crc16Xmodem(packet);
    const transportDiagnostics: SmpDiagnostic[] = [];
    if (extraBytes > 0) {
      transportDiagnostics.push({
        code: 'smp.console.trailing-bytes',
        severity: 'error',
        message: `Serial Console packet contains ${extraBytes} trailing decoded byte(s)`,
      });
    }
    if (actualCrc !== expectedCrc) {
      transportDiagnostics.push({
        code: 'smp.console.crc',
        severity: 'error',
        message: `CRC16-XMODEM mismatch (expected 0x${hex16(expectedCrc)}, calculated 0x${hex16(actualCrc)})`,
      });
    }
    state.console = null;

    records.push(
      ...this.decodeTransportPacket(packet, {
        direction: markerDirection(state, this.states),
        timestamp: assembly.timestamp,
        captureSeq: assembly.captureSeq,
        offset: assembly.offset,
        transportData: wireData,
        crcStatus: actualCrc === expectedCrc ? 'valid' : 'invalid',
        diagnostics: transportDiagnostics,
      }),
    );
    return records;
  }

  private recoverNextConsoleInitial(
    state: DirectionState,
    line: Uint8Array,
    wireLine: Uint8Array,
    lineOffset: number,
    lineTimestamp: number,
    lineCaptureSeq: number | undefined,
    now: number,
    searchStart: number,
    recoveryDepth: number,
  ): SmpRecord[] {
    // Bound adversarial lines containing thousands of marker pairs while still
    // recovering through ordinary log/noise corruption.
    if (recoveryDepth >= 32) return [];
    const next = findConsoleInitialMarker(line, searchStart);
    if (next < 0) return [];
    return this.consumeConsoleLine(
      state,
      line.subarray(next),
      wireLine.subarray(next),
      lineOffset + next,
      lineTimestamp,
      lineCaptureSeq,
      now,
      recoveryDepth + 1,
    );
  }

  private feedRaw(state: DirectionState, chunk: SmpTrafficChunk, chunkOffset: number): SmpRecord[] {
    if (state.rawBuffer.length === 0) {
      state.rawOffset = chunkOffset;
      state.rawTimestamp = chunk.timestamp;
      state.rawCaptureSeq = chunk.captureSeq;
    }
    state.rawSegments.push({
      endOffset: chunkOffset + chunk.data.length,
      timestamp: chunk.timestamp,
      captureSeq: chunk.captureSeq,
    });
    state.rawLastTimestamp = chunk.timestamp;
    state.rawBuffer = concatBytes([state.rawBuffer, chunk.data]);

    // Raw UART has no outer packet envelope. Each SMP header and its declared
    // data length is therefore one stream boundary; multi-message alignment is
    // handled only by decodeTransportPacket when a transport supplies a total
    // packet length (for example Serial Console).
    const records: SmpRecord[] = [];
    while (state.rawBuffer.length >= SMP_HEADER_BYTES) {
      if (!isPlausibleRawHeader(state.rawBuffer, this.config.maxPacketBytes)) {
        const next = findPlausibleRawHeader(state.rawBuffer, this.config.maxPacketBytes, 1);
        const discard = next >= 0 ? next : Math.max(1, state.rawBuffer.length - 7);
        const noise = sliceCopy(state.rawBuffer, 0, discard);
        records.push(
          this.transportErrorRecord(
            chunk.direction,
            state.rawTimestamp,
            state.rawCaptureSeq,
            state.rawOffset,
            noise,
            'smp.raw.resync',
            `Raw UART discarded ${discard} byte(s) while searching for an SMP header`,
            'warning',
          ),
        );
        consumeRawBytes(state, discard);
        continue;
      }

      const messageLength = SMP_HEADER_BYTES + readU16(state.rawBuffer, 2);
      if (state.rawBuffer.length < messageLength) break;
      const message = sliceCopy(state.rawBuffer, 0, messageLength);
      const context: TransportContext = {
        direction: chunk.direction,
        timestamp: state.rawTimestamp,
        captureSeq: state.rawCaptureSeq,
        offset: state.rawOffset,
        transportData: message,
        crcStatus: 'not-applicable',
        diagnostics: [],
      };
      consumeRawBytes(state, messageLength);
      records.push(...this.decodeTransportPacket(message, context));
    }
    return records;
  }

  private decodeTransportPacket(packet: Uint8Array, context: TransportContext): SmpRecord[] {
    const records: SmpRecord[] = [];
    let packetOffset = 0;

    while (packetOffset < packet.length) {
      if (packet.length - packetOffset < SMP_HEADER_BYTES) {
        records.push(
          this.transportErrorRecord(
            context.direction,
            context.timestamp,
            context.captureSeq,
            context.offset + packetOffset,
            sliceCopy(packet, packetOffset),
            'smp.packet.trailing-bytes',
            `SMP packet ends with ${packet.length - packetOffset} byte(s), shorter than a header`,
          ),
        );
        break;
      }

      const dataLength = readU16(packet, packetOffset + 2);
      const messageLength = SMP_HEADER_BYTES + dataLength;
      if (
        messageLength > this.config.maxPacketBytes ||
        packetOffset + messageLength > packet.length
      ) {
        records.push(
          this.transportErrorRecord(
            context.direction,
            context.timestamp,
            context.captureSeq,
            context.offset + packetOffset,
            sliceCopy(packet, packetOffset),
            'smp.packet.length',
            `SMP message length ${messageLength} exceeds the available or configured packet length`,
          ),
        );
        break;
      }

      const message = sliceCopy(packet, packetOffset, packetOffset + messageLength);
      records.push(this.decodeMessage(message, context, packetOffset));
      packetOffset += messageLength;
      if (packetOffset >= packet.length) break;

      const aligned = Math.min(packet.length, (packetOffset + 3) & ~3);
      if (aligned > packetOffset) {
        const padding = packet.subarray(packetOffset, aligned);
        if (padding.some((byte) => byte !== 0)) {
          records.at(-1)?.diagnostics.push({
            code: 'smp.packet.padding',
            severity: 'warning',
            message: 'SMP multi-message alignment padding is non-zero',
            offset: packetOffset,
            length: padding.length,
          });
          const previous = records.at(-1);
          if (previous) previous.status = statusFor(previous.diagnostics, previous.status);
        }
        packetOffset = aligned;
      }
    }

    return records;
  }

  private decodeMessage(
    message: Uint8Array,
    context: TransportContext,
    packetOffset: number,
  ): SmpRecord {
    const byte0 = message[0];
    const reserved = byte0 >>> 5;
    const versionBits = (byte0 >>> 3) & 0x03;
    const op = byte0 & 0x07;
    const group = readU16(message, 4);
    const header: SmpHeader = {
      version: versionBits + 1,
      versionBits,
      op,
      opName: smpOpName(op),
      opNameZh: smpOpNameZh(op),
      requestResponse: smpRequestResponse(op),
      flags: message[1],
      dataLength: readU16(message, 2),
      group,
      groupName: smpGroupName(group),
      groupNameZh: smpGroupNameZh(group),
      sequence: message[6],
      command: message[7],
      commandName: smpCommandName(group, message[7]),
      commandNameZh: smpCommandNameZh(group, message[7]),
    };
    const diagnostics = context.diagnostics.map((diagnostic) => ({ ...diagnostic }));
    if (reserved !== 0) {
      diagnostics.push({
        code: 'smp.header.reserved',
        severity: 'warning',
        message: `SMP reserved bits are non-zero (${reserved})`,
        offset: 0,
        length: 1,
      });
    }
    if (versionBits > 1) {
      diagnostics.push({
        code: 'smp.header.version',
        severity: 'warning',
        message: `SMP version bits ${versionBits} are reserved`,
        offset: 0,
        length: 1,
      });
    }
    if (op > 3) {
      diagnostics.push({
        code: 'smp.header.op',
        severity: 'warning',
        message: `SMP operation ${op} is unknown`,
        offset: 0,
        length: 1,
      });
    }
    if (header.flags !== 0) {
      diagnostics.push({
        code: 'smp.header.flags',
        severity: 'warning',
        message: `SMP flags 0x${header.flags.toString(16).padStart(2, '0')} are not defined`,
        offset: 1,
        length: 1,
      });
    }
    if (!KNOWN_GROUPS.has(group)) {
      diagnostics.push({
        code: group >= 64 ? 'smp.header.custom-group' : 'smp.header.unknown-group',
        severity: 'warning',
        message: group >= 64 ? `SMP user group ${group}` : `SMP group ${group} is unknown`,
        offset: 4,
        length: 2,
      });
    } else if (!isKnownSmpCommand(group, header.command)) {
      diagnostics.push({
        code: 'smp.header.unknown-command',
        severity: 'warning',
        message: `SMP command ${header.command} is unknown for group ${group}`,
        offset: 7,
        length: 1,
      });
    }

    const payload = message.subarray(SMP_HEADER_BYTES);
    let cbor: CborNode | undefined;
    if (payload.length > 0) {
      const decoded = decodeBoundedSmpCbor(payload);
      if (decoded.ok) {
        cbor = decoded.value;
      } else {
        diagnostics.push({
          code: 'smp.cbor.invalid',
          severity: group >= 64 ? 'warning' : 'error',
          message: `CBOR decode failed: ${decoded.reason}`,
          offset: SMP_HEADER_BYTES,
          length: payload.length,
        });
      }
    }

    const remoteError = describeRemoteError(cbor);
    if (remoteError) {
      diagnostics.push({
        code: 'smp.remote-error',
        severity: 'error',
        message: remoteError,
        offset: SMP_HEADER_BYTES,
        length: payload.length,
      });
    }

    const record: SmpRecord = {
      kind: 'smp',
      id: `smp-${this.nextRecordNumber++}`,
      direction: context.direction,
      timestamp: context.timestamp,
      ...(context.captureSeq === undefined ? {} : { captureSeq: context.captureSeq }),
      data: message,
      length: message.length,
      offset: context.offset + packetOffset,
      endOffset: context.offset + packetOffset + message.length,
      status: statusFor(diagnostics),
      summary: `${context.direction} ${header.opName} · ${header.groupName}/${header.commandName} · seq ${header.sequence}${remoteError ? ` · ${remoteError}` : ''}`,
      diagnostics,
      transport: this.config.transport,
      crcStatus: context.crcStatus,
      ...(context.transportData ? { transportData: context.transportData } : {}),
      header,
      ...(cbor === undefined ? {} : { cbor }),
      ranges: {
        ...(context.transportData
          ? { transport: { offset: 0, length: context.transportData.length } }
          : {}),
        header: { offset: 0, length: SMP_HEADER_BYTES },
        payload: { offset: SMP_HEADER_BYTES, length: payload.length },
      },
    };
    if (
      context.crcStatus !== 'invalid' &&
      !context.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ) {
      this.correlate(record);
    }
    return record;
  }

  private correlate(record: SmpRecord): void {
    const header = record.header;
    if (!header) return;
    this.expirePendingRequests(record.timestamp);

    const expectedOp = expectedResponseOp(header.op);
    if (expectedOp !== null) {
      if (record.status === 'ok') record.status = 'pending';
      this.pendingRequests.push({
        record,
        expectedOp,
        expiresAt: record.timestamp + DEFAULT_SMP_REQUEST_TIMEOUT_MS,
      });
      while (this.pendingRequests.length > DEFAULT_SMP_MAX_PENDING_REQUESTS) {
        const evicted = this.pendingRequests.shift();
        if (evicted)
          markRequestUnmatched(evicted.record, 'Request correlation table limit reached');
      }
      return;
    }

    if (header.requestResponse !== 'response') return;
    const matchIndex = this.pendingRequests.findIndex(
      ({ record: request, expectedOp: responseOp }) => {
        const requestHeader = request.header;
        return (
          request.direction !== record.direction &&
          responseOp === header.op &&
          requestHeader?.sequence === header.sequence &&
          requestHeader.group === header.group &&
          requestHeader.command === header.command
        );
      },
    );
    if (matchIndex < 0) {
      record.diagnostics.push({
        code: 'smp.transaction.orphan-response',
        severity: 'warning',
        message: 'No matching outstanding SMP request was found',
      });
      record.status = statusFor(record.diagnostics, record.status);
      return;
    }

    const request = this.pendingRequests.splice(matchIndex, 1)[0].record;
    const rttMs = Math.max(0, record.timestamp - request.timestamp);
    request.responseId = record.id;
    request.rttMs = rttMs;
    request.status = statusFor(request.diagnostics);
    record.requestId = request.id;
    record.rttMs = rttMs;
  }

  private expirePendingRequests(now: number): void {
    for (let index = this.pendingRequests.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingRequests[index];
      if (pending.expiresAt > now) continue;
      this.pendingRequests.splice(index, 1);
      markRequestUnmatched(pending.record, 'SMP request timed out before a matching response');
    }
  }

  private transportErrorRecord(
    direction: 'TX' | 'RX',
    timestamp: number,
    captureSeq: number | undefined,
    offset: number,
    data: Uint8Array,
    code: string,
    message: string,
    severity: SmpDiagnostic['severity'] = 'error',
  ): SmpRecord {
    const diagnostics: SmpDiagnostic[] = [{ code, severity, message }];
    return {
      kind: 'smp',
      id: `smp-${this.nextRecordNumber++}`,
      direction,
      timestamp,
      ...(captureSeq === undefined ? {} : { captureSeq }),
      data: sliceCopy(data),
      length: data.length,
      offset,
      endOffset: offset + data.length,
      status: statusFor(diagnostics),
      summary: message,
      diagnostics,
      transport: this.config.transport,
      crcStatus: this.config.transport === 'raw-uart' ? 'not-applicable' : 'unknown',
      transportData: sliceCopy(data),
      ranges: { transport: { offset: 0, length: data.length } },
    };
  }
}

function createDirectionState(): DirectionState {
  return {
    inputOffset: 0,
    lineBuffer: new Uint8Array(0),
    lineBufferOffset: 0,
    lineTimestamp: 0,
    lineLastTimestamp: 0,
    console: null,
    rawBuffer: new Uint8Array(0),
    rawOffset: 0,
    rawTimestamp: 0,
    rawLastTimestamp: 0,
    rawSegments: [],
  };
}

function resetConsoleLineState(state: DirectionState): void {
  state.lineBuffer = new Uint8Array(0);
  state.lineCaptureSeq = undefined;
  state.lineLastTimestamp = 0;
}

function hasPotentialConsoleMarker(bytes: Uint8Array): boolean {
  return Boolean(findConsoleMarker(bytes) || findLastMarkerPrefix(bytes).length > 0);
}

function earlierTimestamp(current: number | null, candidate: number): number {
  return current === null || candidate < current ? candidate : current;
}

function resetRawState(state: DirectionState): void {
  state.rawBuffer = new Uint8Array(0);
  state.rawCaptureSeq = undefined;
  state.rawLastTimestamp = 0;
  state.rawSegments = [];
}

function consumeRawBytes(state: DirectionState, count: number): void {
  state.rawBuffer = sliceCopy(state.rawBuffer, count);
  state.rawOffset += count;
  if (state.rawBuffer.length === 0) {
    state.rawCaptureSeq = undefined;
    state.rawLastTimestamp = 0;
    state.rawSegments = [];
    return;
  }
  while (state.rawSegments[0]?.endOffset <= state.rawOffset) state.rawSegments.shift();
  const segment = state.rawSegments[0];
  if (segment) {
    state.rawTimestamp = segment.timestamp;
    state.rawCaptureSeq = segment.captureSeq;
    state.rawLastTimestamp = state.rawSegments.at(-1)?.timestamp ?? segment.timestamp;
  }
}

function isPlausibleRawHeader(bytes: Uint8Array, maxPacketBytes: number): boolean {
  if (bytes.length < SMP_HEADER_BYTES) return false;
  const byte0 = bytes[0];
  if (byte0 >>> 5 !== 0 || (byte0 & 0x07) > 3) return false;
  const messageLength = rawMessageLength(bytes);
  return messageLength >= SMP_HEADER_BYTES && messageLength <= maxPacketBytes;
}

function rawMessageLength(bytes: Uint8Array): number {
  return SMP_HEADER_BYTES + readU16(bytes, 2);
}

function findPlausibleRawHeader(bytes: Uint8Array, maxPacketBytes: number, start: number): number {
  for (let index = start; index + SMP_HEADER_BYTES <= bytes.length; index += 1) {
    if (isPlausibleRawHeader(bytes.subarray(index), maxPacketBytes)) return index;
  }
  return -1;
}

function findConsoleMarker(
  line: Uint8Array,
): { kind: 'initial' | 'continuation'; index: number } | null {
  for (let index = 0; index + 1 < line.length; index += 1) {
    if (
      line[index] === SMP_CONSOLE_INITIAL_MARKER[0] &&
      line[index + 1] === SMP_CONSOLE_INITIAL_MARKER[1]
    ) {
      return { kind: 'initial', index };
    }
    if (
      line[index] === SMP_CONSOLE_CONTINUATION_MARKER[0] &&
      line[index + 1] === SMP_CONSOLE_CONTINUATION_MARKER[1]
    ) {
      return { kind: 'continuation', index };
    }
  }
  return null;
}

function findConsoleInitialMarker(line: Uint8Array, start: number): number {
  for (let index = start; index + 1 < line.length; index += 1) {
    if (
      line[index] === SMP_CONSOLE_INITIAL_MARKER[0] &&
      line[index + 1] === SMP_CONSOLE_INITIAL_MARKER[1]
    ) {
      return index;
    }
  }
  return -1;
}

function findLastMarkerPrefix(bytes: Uint8Array): Uint8Array {
  const last = bytes.at(-1);
  return last === SMP_CONSOLE_INITIAL_MARKER[0] || last === SMP_CONSOLE_CONTINUATION_MARKER[0]
    ? Uint8Array.of(last)
    : new Uint8Array(0);
}

function markerDirection(
  state: DirectionState,
  states: Record<'TX' | 'RX', DirectionState>,
): 'TX' | 'RX' {
  return states.TX === state ? 'TX' : 'RX';
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function sliceCopy(bytes: Uint8Array, start = 0, end = bytes.length): Uint8Array {
  return bytes.slice(start, end);
}

function statusFor(
  diagnostics: readonly SmpDiagnostic[],
  fallback: SmpRecord['status'] = 'ok',
): SmpRecord['status'] {
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return 'error';
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'warning')) return 'warning';
  return fallback === 'pending' ? 'pending' : 'ok';
}

function markRequestUnmatched(record: SmpRecord, message: string): void {
  record.diagnostics.push({
    code: 'smp.transaction.unmatched-request',
    severity: 'warning',
    message,
  });
  record.status = statusFor(record.diagnostics);
}

function describeRemoteError(cbor: CborNode | undefined): string | null {
  const err = cborMapValue(cbor, 'err');
  const group = cborInteger(cborMapValue(err, 'group'));
  const groupRc = cborInteger(cborMapValue(err, 'rc'));
  if (groupRc !== undefined && groupRc !== 0 && groupRc !== 0n) {
    return `Remote group error${group === undefined ? '' : ` group=${String(group)}`} rc=${String(groupRc)}`;
  }

  const rc = cborInteger(cborMapValue(cbor, 'rc'));
  if (rc === undefined || rc === 0 || rc === 0n) return null;
  const reason = cborText(cborMapValue(cbor, 'rsn'));
  return `Remote error rc=${String(rc)}${reason ? ` (${reason})` : ''}`;
}

function hex16(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

function lineOffsetForChunk(chunkOffset: number, chunkLength: number, discarded: number): number {
  return Math.max(0, chunkOffset + chunkLength - discarded);
}
