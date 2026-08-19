import { invoke, isTauri } from '@tauri-apps/api/core';
import type { PluginHostContextUpdateRequestV2 } from '../../generated/ipc-contracts';

export const PLUGIN_UPDATE_HOST_CONTEXT_V2_COMMAND = 'plugin_update_host_context_v2';

/** Main-window-only projection of hydrated appearance and session summaries. */
export class TauriPluginHostContextTransport {
  update(request: PluginHostContextUpdateRequestV2): Promise<void> {
    if (!isTauri()) return Promise.resolve();
    return invoke<void>(PLUGIN_UPDATE_HOST_CONTEXT_V2_COMMAND, { request });
  }
}
