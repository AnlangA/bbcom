/** Checksum algorithm identifier (mirrors the Rust `ChecksumType` enum's
 *  SCREAMING_SNAKE_CASE serde tags and src/lib/checksum-constants.ts values). */
export type ChecksumType = 'CHECKSUM' | 'CRC8' | 'CRC16' | 'CRC16_MODBUS' | 'CRC32';
