/** Display, view, and filter primitive types shared across the terminal UI. */

/** How raw bytes are rendered in the packet list / export. */
export type DisplayMode = 'HEX' | 'HEXASCII' | 'ASCII' | 'ANSI' | 'UTF8';

/** Direction filter for searches and exports ('ALL' = both directions). */
export type DirectionFilter = 'ALL' | 'TX' | 'RX';

/** Frame direction — received from the device (RX) or sent to it (TX). */
export type { Direction } from '../generated/ipc-contracts';

/** Match scope for the packet search box: decoded text or raw hex bytes. */
export type SearchMode = 'TEXT' | 'HEX';

/** Packet list layout: one row per frame, or consecutive same-direction runs merged. */
export type PacketViewMode = 'FRAME' | 'MERGED';

/** Line-ending normalization applied on send (mirrors the send-panel selector). */
export type LineEnding = 'none' | 'CR' | 'LF' | 'CRLF';
