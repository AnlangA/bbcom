import { isBitFc } from './modbus-core';
import {
  encodeModbusCoilWriteValues,
  encodeModbusRegisterWriteValues,
  type ModbusReadBatch,
  type ModbusWriteBatch,
} from './modbus-batches';
import {
  readRequest,
  writeMultipleCoilsRequest,
  writeMultipleRegistersRequest,
  writeSingleCoilRequest,
  writeSingleRegisterRequest,
  type ModbusTransport,
} from './modbus-transport';

export interface ModbusWireRequest {
  wire: Uint8Array;
  /** Expected PDU response length; undefined for self-framing RTU. */
  expectedLen?: number;
}

export function buildModbusReadWireRequest(
  transport: ModbusTransport,
  batch: ModbusReadBatch,
): ModbusWireRequest {
  return {
    wire: readRequest(transport, batch.slave, batch.fc, batch.start, batch.count),
    expectedLen: expectedReadResponseLength(batch, transport),
  };
}

export function buildModbusWriteWireRequest(
  transport: ModbusTransport,
  batch: ModbusWriteBatch,
): ModbusWireRequest {
  return {
    wire: writeRequest(transport, batch),
    expectedLen: expectedWriteResponseLength(transport),
  };
}

export function expectedReadResponseLength(
  batch: ModbusReadBatch,
  transport: ModbusTransport,
): number | undefined {
  // RTU frames itself via CRC; only PDU transport needs an explicit length.
  if (transport === 'rtu') return undefined;
  if (isBitFc(batch.fc)) {
    // [fc][byteCount][data...] for PDU, because slave address is out-of-band.
    const byteCount = Math.ceil(batch.count / 8);
    return 2 + byteCount;
  }
  return 2 + batch.count * 2;
}

export function expectedWriteResponseLength(transport: ModbusTransport): number | undefined {
  if (transport === 'rtu') return undefined;
  // write-ack echo: [fc][startHi][startLo][countHi][countLo] = 5 (PDU, no addr).
  return 5;
}

function writeRequest(transport: ModbusTransport, batch: ModbusWriteBatch): Uint8Array {
  if (batch.kind === 'coil') {
    const bits = encodeModbusCoilWriteValues(batch);
    return batch.fc === 0x05
      ? writeSingleCoilRequest(transport, batch.slave, batch.start, bits[0])
      : writeMultipleCoilsRequest(transport, batch.slave, batch.start, bits);
  }

  const values = encodeModbusRegisterWriteValues(batch);
  return batch.fc === 0x06
    ? writeSingleRegisterRequest(transport, batch.slave, batch.start, values[0])
    : writeMultipleRegistersRequest(transport, batch.slave, batch.start, values);
}
