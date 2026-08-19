import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PluginSerialCapabilityInboundV2 } from '../../src/generated/ipc-contracts';
import {
  PLUGIN_SERIAL_CAPABILITY_EVENT_V2,
  PLUGIN_SERIAL_PORT_CATALOG_CHANGED_COMMAND_V2,
  PLUGIN_SERIAL_CAPABILITY_REPLY_COMMAND_V2,
  TauriPluginSerialCapabilityTransport,
} from '../../src/features/plugins/tauri-plugin-serial-capability-transport';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  listen: tauri.listen,
}));

describe('TauriPluginSerialCapabilityTransport', () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.isTauri.mockReset();
    tauri.listen.mockReset();
  });

  test('listens on the fixed v2 event and replies with the generated request wrapper', async () => {
    tauri.isTauri.mockReturnValue(true);
    const unlisten = vi.fn();
    let nativeListener: ((event: { payload: PluginSerialCapabilityInboundV2 }) => void) | null =
      null;
    tauri.listen.mockImplementation(async (_name, listener) => {
      nativeListener = listener;
      return unlisten;
    });
    tauri.invoke.mockResolvedValue(undefined);
    const listener = vi.fn();
    const transport = new TauriPluginSerialCapabilityTransport();

    await expect(transport.listen(listener)).resolves.toBe(unlisten);
    expect(tauri.listen).toHaveBeenCalledWith(
      PLUGIN_SERIAL_CAPABILITY_EVENT_V2,
      expect.any(Function),
    );
    const inbound: PluginSerialCapabilityInboundV2 = { kind: 'revoke-all' };
    nativeListener?.({ payload: inbound });
    expect(listener).toHaveBeenCalledWith(inbound);

    const outbound = {
      kind: 'cancel-result' as const,
      context: {
        workspaceId: 'workspace-1',
        pluginId: 'dev.bbcom.fixture',
        instanceId: '1',
        generation: 1,
      },
      targetMessageId: 2,
      ok: true,
    };
    await transport.respond(outbound);
    expect(tauri.invoke).toHaveBeenCalledWith(PLUGIN_SERIAL_CAPABILITY_REPLY_COMMAND_V2, {
      request: { event: outbound },
    });

    await transport.notifyPortCatalogChanged();
    expect(tauri.invoke).toHaveBeenCalledWith(PLUGIN_SERIAL_PORT_CATALOG_CHANGED_COMMAND_V2);
  });

  test('does not attach a native listener in a browser-only shell', async () => {
    tauri.isTauri.mockReturnValue(false);
    const transport = new TauriPluginSerialCapabilityTransport();
    const unlisten = await transport.listen(vi.fn());
    unlisten();
    await transport.notifyPortCatalogChanged();
    expect(tauri.listen).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
