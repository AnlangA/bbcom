import {
  DataBits as PluginDataBits,
  StopBits as PluginStopBits,
  Parity as PluginParity,
  FlowControl as PluginFlowControl,
} from 'tauri-plugin-serialplugin-api';

/** Map a data-bits count to the serial plugin enum (unknown → 8). */
export function mapDataBits(n: number): PluginDataBits {
  switch (n) {
    case 5:
      return PluginDataBits.Five;
    case 6:
      return PluginDataBits.Six;
    case 7:
      return PluginDataBits.Seven;
    case 8:
    default:
      return PluginDataBits.Eight;
  }
}

/** Map a stop-bits count to the serial plugin enum (unknown → 1). */
export function mapStopBits(n: number): PluginStopBits {
  switch (n) {
    case 2:
      return PluginStopBits.Two;
    case 1:
    default:
      return PluginStopBits.One;
  }
}

/** Map a parity string to the serial plugin enum (unknown → none). */
export function mapParity(p: string): PluginParity {
  switch (p) {
    case 'odd':
      return PluginParity.Odd;
    case 'even':
      return PluginParity.Even;
    case 'none':
    default:
      return PluginParity.None;
  }
}

/** Map a flow-control string to the serial plugin enum (unknown → none). */
export function mapFlowControl(f: string): PluginFlowControl {
  switch (f) {
    case 'software':
      return PluginFlowControl.Software;
    case 'hardware':
      return PluginFlowControl.Hardware;
    case 'none':
    default:
      return PluginFlowControl.None;
  }
}
