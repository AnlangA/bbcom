const MCUBOOT_MAGIC = 0x96f3b83d;
const IMAGE_HEADER_SIZE = 32;
const IMAGE_TLV_INFO_MAGIC = 0x6907;
const IMAGE_TLV_PROT_INFO_MAGIC = 0x6908;
const IMAGE_TLV_SHA256 = 0x10;

export interface McubootImageInfo {
  magicOk: boolean;
  headerSize: number;
  imageSize: number;
  version: string;
  sha256?: Uint8Array;
}

export function parseMcubootImage(bytes: Uint8Array): McubootImageInfo {
  if (bytes.length < IMAGE_HEADER_SIZE) {
    return { magicOk: false, headerSize: 0, imageSize: 0, version: '' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const headerSize = view.getUint16(8, true);
  const protectTlvSize = view.getUint16(10, true);
  const imageSize = view.getUint32(12, true);
  const version = [
    view.getUint8(20),
    view.getUint8(21),
    view.getUint16(22, true),
    view.getUint32(24, true),
  ].join('.');
  if (magic !== MCUBOOT_MAGIC) {
    return { magicOk: false, headerSize, imageSize, version };
  }
  const tlvStart = headerSize + imageSize;
  return {
    magicOk: true,
    headerSize,
    imageSize,
    version,
    sha256: extractSha256Tlv(bytes, tlvStart, protectTlvSize),
  };
}

function extractSha256Tlv(
  bytes: Uint8Array,
  start: number,
  protectTlvSize: number,
): Uint8Array | undefined {
  let offset = start;
  if (protectTlvSize > 0) offset += protectTlvSize;
  if (offset + 4 > bytes.length) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint16(offset, true);
  if (magic !== IMAGE_TLV_INFO_MAGIC && magic !== IMAGE_TLV_PROT_INFO_MAGIC) return undefined;
  const total = view.getUint16(offset + 2, true);
  const end = Math.min(bytes.length, offset + total);
  offset += 4;
  while (offset + 4 <= end) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + length > end) break;
    if (type === IMAGE_TLV_SHA256 && length === 32) {
      return bytes.slice(offset, offset + 32);
    }
    offset += length;
  }
  return undefined;
}
