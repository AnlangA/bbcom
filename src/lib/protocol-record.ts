import type { SmpRecord } from './mcumgr-smp-parser';
import type { ByteParserConfig } from './protocol-parser';

export type ByteFrameParserKind = ByteParserConfig['kind'];

export interface ByteFrameRecord {
  kind: 'bytes';
  /** Byte-framing strategy that produced this record. */
  parserKind: ByteFrameParserKind;
  id: string;
  direction: 'RX';
  timestamp: number;
  captureSeq?: number;
  data: Uint8Array;
  length: number;
  offset: number;
  endOffset: number;
  status: 'ok';
  diagnostics: [];
  summary: string;
}

/** Records exposed by the resident protocol runtime to the parser inspector. */
export type DisplayProtocolRecord = ByteFrameRecord | SmpRecord;

export function isSmpRecord(record: DisplayProtocolRecord): record is SmpRecord {
  return 'kind' in record && record.kind === 'smp';
}
