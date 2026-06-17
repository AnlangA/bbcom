// ---------------------------------------------------------------------------
// Modbus register model + master config.
//
// A register row is the user-facing unit in the register table. Its
// `functionCode` selects the FC family (read coil/input, read/write holding
// reg, …); the master composes wire requests from rows. Read rows are batched
// when contiguous. Coil writes may batch into FC0F, while register writes batch
// into FC10 only for rows explicitly configured as FC10; FC06 remains single.
// `value` is dual-purpose: in READ mode it holds the latest decoded sample
// (runtime only — never persisted); in SEND mode it holds the value to write.
// ---------------------------------------------------------------------------

/** Register/coil value encoding. 32-bit types span two 16-bit registers. */
export type ModbusValueType =
  | 'bool'
  | 'uint8'
  | 'int8'
  | 'uint16'
  | 'int16'
  | 'uint32-be'
  | 'int32-be'
  | 'float32-be'
  | 'uint32-le'
  | 'int32-le'
  | 'float32-le';

/**
 * Function-code family a row belongs to. Read FCs can be batched by contiguous
 * address; write-register rows use FC06 for single writes or explicit FC10 for
 * multi-register writes.
 * - 01 read coils (bit, ro)   02 read discrete inputs (bit, ro)
 * - 03 read holding regs (word, rw reads)   04 read input regs (word, ro)
 * - 05 write single coil (bit)   06 write single register (word)
 * - 10 write multiple registers (word)
 */
export type ModbusFunctionCode = 0x01 | 0x02 | 0x03 | 0x04 | 0x05 | 0x06 | 0x10;

/** Access class derived from the FC family — drives UI enablement. */
export type ModbusAccess = 'bit-ro' | 'bit-rw' | 'word-ro' | 'word-rw';

/** A register table row. Persisted per-session like triggers/highlights. */
export interface ModbusRegister {
  id: string;
  name: string;
  /** Slave address 1..247 (0 = broadcast for writes). */
  slaveAddress: number;
  functionCode: ModbusFunctionCode;
  /** Starting register/coil address 0..65535. */
  address: number;
  /**
   * Number of typed data values operated by FC03/FC10 rows. The master derives
   * the required 16-bit register count from this and the selected value type
   * (for example uint8 x 10 => 5 registers, uint32 x 10 => 20 registers).
   */
  quantity?: number;
  type: ModbusValueType;
  /** Physical unit label (°C, V, …) — cosmetic. */
  unit?: string;
  /** Waveform channel 0..7 this row plots, or null. */
  waveformChannel: number | null;
  /** READ: latest decoded value. SEND: value to write. Runtime-only. */
  value: number | null;
  /** Multi-register decoded/write values. Runtime-only; value mirrors values[0]. */
  values?: number[] | null;
  valueTs: number | null;
  /**
   * Whether this row participates in periodic background reads. A row with a
   * read FC (01/02/03/04) and periodicRead=true is polled each tick. Defaults
   * to true for backward compatibility with pre-existing rows.
   */
  periodicRead: boolean;
  /**
   * Whether this row participates in periodic background writes. Only honored
   * for write FCs (05/06/10); each tick advances that row's value cursor in the
   * loaded write data source (`.bbreg`) and sends the next value. Defaults to
   * false so auto-writes never start without an explicit opt-in.
   */
  periodicWrite: boolean;
}

/** Per-session Modbus master settings. Persisted (minus row values). */
export interface ModbusMasterConfig {
  /** 'rtu' = addr+PDU+CRC; 'pdu' = raw PDU bytes (TCP-style gateway). */
  transport: 'rtu' | 'pdu';
  /** Master enabled. Gates both the read and write background loops. */
  enabled: boolean;
  /** Read poll interval in ms (100..10000). */
  pollIntervalMs: number;
  /** Write interval in ms (100..10000) — cadence for periodic writes. */
  writeIntervalMs: number;
  /** Per-request response timeout in ms. */
  timeoutMs: number;
}
