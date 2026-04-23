export interface DataFrame {
  id: string;
  direction: 'TX' | 'RX';
  timestamp: string;
  data: number[];
}

export interface PortConfig {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'odd' | 'even';
  flowControl: 'none' | 'software' | 'hardware';
}

export interface SendHistoryEntry {
  data: string;
  isHex: boolean;
}

export interface SerialSession {
  id: string;
  portName: string;
  portConfig: PortConfig;
  isConnected: boolean;
  frames: DataFrame[];
  txBytes: number;
  rxBytes: number;
  txFrames: number;
  rxFrames: number;
  startTime: number | null;
  sendHistory: SendHistoryEntry[];
}

export type ChecksumType = 'CHECKSUM' | 'CRC8' | 'CRC16' | 'CRC32';
