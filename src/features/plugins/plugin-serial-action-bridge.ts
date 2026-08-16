import { invoke, isTauri } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type {
  PluginSerialAction,
  PluginSerialActionResultRequest,
  SerialSendResult,
} from '../../generated/ipc-contracts';
import { listenNativeEvent } from '../native';

export const PLUGIN_SERIAL_ACTION_EVENT = 'plugin-serial-action';
export const PLUGIN_SERIAL_ACTION_RESULT_COMMAND = 'plugin_serial_action_result';

export interface PluginSerialRuntime {
  sendBytes(payload: Uint8Array): Promise<SerialSendResult>;
}

/**
 * Main-window bridge from an approved native plugin action to the existing
 * application-owned session runtime. It never receives a port path or serial
 * handle and always returns the concrete scheduler outcome to native code.
 */
export class PluginSerialActionBridge {
  private unlisten: UnlistenFn | null = null;
  private readonly active = new Set<string>();

  constructor(
    private readonly runtimeForSession: (sessionId: string) => PluginSerialRuntime | undefined,
  ) {}

  async start(): Promise<void> {
    if (this.unlisten || !isTauri()) return;
    this.unlisten = await listenNativeEvent<unknown>(PLUGIN_SERIAL_ACTION_EVENT, ({ payload }) => {
      const action = validateAction(payload);
      if (!action || this.active.has(action.correlationId)) return;
      this.active.add(action.correlationId);
      void this.execute(action).finally(() => this.active.delete(action.correlationId));
    });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.active.clear();
  }

  private async execute(action: PluginSerialAction): Promise<void> {
    const runtime = this.runtimeForSession(action.sessionId);
    let result: SerialSendResult;
    if (!runtime) {
      result = failedResult(action.bytes.length);
    } else {
      try {
        result = await runtime.sendBytes(Uint8Array.from(action.bytes));
      } catch {
        result = failedResult(action.bytes.length);
      }
    }
    const request: PluginSerialActionResultRequest = {
      correlationId: action.correlationId,
      runtime: { ...action.runtime },
      outcome: result.outcome,
      requestedBytes: result.requestedBytes,
      sentBytes: result.sentBytes,
    };
    try {
      await invoke(PLUGIN_SERIAL_ACTION_RESULT_COMMAND, { request });
    } catch {
      // Native timeout remains authoritative when the result cannot cross IPC.
    }
  }
}

function validateAction(value: unknown): PluginSerialAction | null {
  if (!isRecord(value)) return null;
  const runtime = value.runtime;
  const bytes = value.bytes;
  if (
    !validIdentity(value.correlationId) ||
    !validIdentity(value.proposalId) ||
    !validIdentity(value.operationId) ||
    !validIdentity(value.sessionId) ||
    !isRecord(runtime) ||
    !validIdentity(runtime.workspaceId) ||
    !validIdentity(runtime.pluginId) ||
    typeof runtime.instanceId !== 'number' ||
    !Number.isSafeInteger(runtime.instanceId) ||
    runtime.instanceId < 1 ||
    typeof runtime.generation !== 'number' ||
    !Number.isSafeInteger(runtime.generation) ||
    runtime.generation < 1 ||
    !Array.isArray(bytes) ||
    bytes.length === 0 ||
    bytes.length > 1024 * 1024 ||
    !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return null;
  }
  return value as unknown as PluginSerialAction;
}

function failedResult(requestedBytes: number): SerialSendResult {
  return { outcome: 'failed', requestedBytes, sentBytes: 0 };
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
