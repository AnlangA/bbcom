import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  PluginSerialCapabilityInboundV2,
  PluginSerialCapabilityOutboundV2,
  PluginSerialCapabilityReplyRequestV2,
} from '../../generated/ipc-contracts';
import { listenNativeEvent } from '../native';
import type { PluginSerialCapabilityTransport } from './application/plugin-serial-capability-gateway';

export const PLUGIN_SERIAL_CAPABILITY_EVENT_V2 = 'plugin-serial-capability-v2';
export const PLUGIN_SERIAL_CAPABILITY_REPLY_COMMAND_V2 = 'plugin_serial_capability_reply_v2';
export const PLUGIN_SERIAL_PORT_CATALOG_CHANGED_COMMAND_V2 =
  'plugin_notify_port_catalog_changed_v2';

/** Main-WebView-only native transport for the generated protocol-v2 serial projection. */
export class TauriPluginSerialCapabilityTransport implements PluginSerialCapabilityTransport {
  listen(listener: (event: unknown) => void): Promise<() => void> {
    if (!isTauri()) return Promise.resolve(() => undefined);
    return listenNativeEvent<PluginSerialCapabilityInboundV2>(
      PLUGIN_SERIAL_CAPABILITY_EVENT_V2,
      (event) => listener(event.payload),
    );
  }

  respond(event: PluginSerialCapabilityOutboundV2): Promise<void> {
    const request: PluginSerialCapabilityReplyRequestV2 = { event };
    return invoke<void>(PLUGIN_SERIAL_CAPABILITY_REPLY_COMMAND_V2, { request });
  }

  /**
   * Signals membership only. Native code derives authorized active runtimes;
   * renderer-controlled port IDs and system paths never cross this command.
   */
  notifyPortCatalogChanged(): Promise<void> {
    if (!isTauri()) return Promise.resolve();
    return invoke<void>(PLUGIN_SERIAL_PORT_CATALOG_CHANGED_COMMAND_V2);
  }
}
