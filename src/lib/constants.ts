export const BAUD_RATES = [
  { label: '9600', value: 9600 },
  { label: '19200', value: 19200 },
  { label: '38400', value: 38400 },
  { label: '57600', value: 57600 },
  { label: '115200', value: 115200 },
  { label: '230400', value: 230400 },
  { label: '460800', value: 460800 },
  { label: '921600', value: 921600 },
];

export const DATA_BITS_OPTIONS = [
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
];

export const STOP_BITS_OPTIONS = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
];

export const PARITY_OPTIONS = [
  { label: '无', value: 'none' },
  { label: '奇校验', value: 'odd' },
  { label: '偶校验', value: 'even' },
];

export const FLOW_CONTROL_OPTIONS = [
  { label: '无', value: 'none' },
  { label: '硬件', value: 'hardware' },
  { label: '软件', value: 'software' },
];
