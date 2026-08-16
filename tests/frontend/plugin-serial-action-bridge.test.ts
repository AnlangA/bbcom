import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PLUGIN_SERIAL_ACTION_EVENT,
  PLUGIN_SERIAL_ACTION_RESULT_COMMAND,
  PluginSerialActionBridge,
} from '../../src/features/plugins';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

describe('PluginSerialActionBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauri.isTauri.mockReturnValue(true);
    tauri.listen.mockResolvedValue(tauri.unlisten);
    tauri.invoke.mockResolvedValue(undefined);
  });

  test('executes on the resident session runtime and returns the real outcome', async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    tauri.listen.mockImplementation(async (_event, next) => {
      handler = next;
      return tauri.unlisten;
    });
    const sendBytes = vi.fn(async () => ({
      outcome: 'partial' as const,
      requestedBytes: 3,
      sentBytes: 2,
    }));
    const bridge = new PluginSerialActionBridge((sessionId) =>
      sessionId === 'session-1' ? { sendBytes } : undefined,
    );
    await bridge.start();
    expect(tauri.listen).toHaveBeenCalledWith(PLUGIN_SERIAL_ACTION_EVENT, expect.any(Function));

    handler?.({ payload: action() });
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledOnce());
    expect(sendBytes).toHaveBeenCalledWith(Uint8Array.from([1, 2, 3]));
    expect(tauri.invoke).toHaveBeenCalledWith(PLUGIN_SERIAL_ACTION_RESULT_COMMAND, {
      request: {
        correlationId: 'correlation-1',
        runtime: action().runtime,
        outcome: 'partial',
        requestedBytes: 3,
        sentBytes: 2,
      },
    });
    bridge.stop();
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  test('returns failed when a session runtime no longer exists and rejects malformed events', async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    tauri.listen.mockImplementation(async (_event, next) => {
      handler = next;
      return tauri.unlisten;
    });
    const bridge = new PluginSerialActionBridge(() => undefined);
    await bridge.start();
    handler?.({ payload: { ...action(), bytes: [256] } });
    await Promise.resolve();
    expect(tauri.invoke).not.toHaveBeenCalled();

    handler?.({ payload: action() });
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledOnce());
    expect(tauri.invoke).toHaveBeenCalledWith(PLUGIN_SERIAL_ACTION_RESULT_COMMAND, {
      request: expect.objectContaining({ outcome: 'failed', requestedBytes: 3, sentBytes: 0 }),
    });
  });
});

function action() {
  return {
    correlationId: 'correlation-1',
    proposalId: 'proposal-1',
    operationId: 'operation-1',
    sessionId: 'session-1',
    runtime: {
      workspaceId: '11111111-1111-1111-1111-111111111111',
      pluginId: 'dev.bbcom.fixture',
      instanceId: 1,
      generation: 2,
    },
    bytes: [1, 2, 3],
  };
}
