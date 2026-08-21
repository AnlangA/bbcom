/**
 * CRC-16/XMODEM used by SMP-over-console.
 * Polynomial 0x1021, init 0, no reflection, xorout 0.
 */

export function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function crc16XmodemFoldByte(crc: number, byte: number): number {
  crc ^= (byte & 0xff) << 8;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
