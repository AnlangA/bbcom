import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  PluginDetachedSurfaceEventRequestV2,
  PluginDetachedSurfaceSnapshotRequestV2,
  PluginDetachedSurfaceViewV2,
  PluginDetachedTaskCancelRequestV2,
  PluginSurfaceEventV2,
} from '../../generated/ipc-contracts';

export const PLUGIN_DETACHED_SURFACE_SNAPSHOT_COMMAND_V2 = 'plugin_detached_surface_snapshot_v2';
export const PLUGIN_DETACHED_EMIT_SURFACE_EVENT_COMMAND_V2 =
  'plugin_detached_emit_surface_event_v2';
export const PLUGIN_DETACHED_CANCEL_TASK_COMMAND_V2 = 'plugin_detached_cancel_task_v2';
export const PLUGIN_DETACHED_SURFACE_UPDATE_EVENT_V2 = 'plugin-detached-surface-update-v2';

/** Native transport owned by the plugins feature boundary, never by Vue UI. */
export class TauriPluginDetachedWindowPort {
  snapshot(token: string): Promise<PluginDetachedSurfaceViewV2> {
    return invoke<PluginDetachedSurfaceViewV2>(PLUGIN_DETACHED_SURFACE_SNAPSHOT_COMMAND_V2, {
      request: { token } satisfies PluginDetachedSurfaceSnapshotRequestV2,
    });
  }

  subscribe(listener: (view: PluginDetachedSurfaceViewV2) => void): Promise<() => void> {
    return listen<PluginDetachedSurfaceViewV2>(
      PLUGIN_DETACHED_SURFACE_UPDATE_EVENT_V2,
      ({ payload }) => listener(payload),
    );
  }

  emitSurfaceEvent(token: string, event: PluginSurfaceEventV2): Promise<void> {
    const request: PluginDetachedSurfaceEventRequestV2 = {
      token,
      surfaceRevision: event.revision,
      nodeId: event.nodeId,
      event: event.event,
      ...(event.value === undefined ? {} : { value: event.value }),
    };
    return invoke<void>(PLUGIN_DETACHED_EMIT_SURFACE_EVENT_COMMAND_V2, { request });
  }

  cancelTask(token: string, taskId: string): Promise<void> {
    const request: PluginDetachedTaskCancelRequestV2 = { token, taskId };
    return invoke<void>(PLUGIN_DETACHED_CANCEL_TASK_COMMAND_V2, { request });
  }
}
