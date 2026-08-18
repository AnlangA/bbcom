import { invoke, isTauri } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type {
  PluginCapturedFrame,
  PluginSessionQuery,
  PluginSessionQueryResult,
  PluginSessionSummary,
} from '../../generated/ipc-contracts';
import { listenNativeEvent } from '../native';

export const PLUGIN_SESSION_QUERY_EVENT = 'plugin-session-query';
export const PLUGIN_SESSION_QUERY_RESULT_COMMAND = 'plugin_session_query_result';

const MAX_CAPTURE_PAGE_FRAMES = 256;
const MAX_CAPTURE_PAGE_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

export interface PluginSessionSnapshotSource {
  /** Sessions visible to plugins: id, port name, kind, connection, counters. */
  listSessions(): readonly PluginSessionSummary[];
  /**
   * One bounded capture page for a session. Returns null when the session is
   * unknown; the result mirrors the plugin capture-page contract.
   */
  readCapture(request: {
    sessionId: string;
    fromSequence: number;
    maxFrames: number;
    maxBytes: number;
  }): { frames: readonly PluginCapturedFrame[]; nextSequence: number | null } | null;
}

/**
 * Main-window bridge answering G43 plugin session/capture queries from the
 * renderer-owned session catalog. Answers always return to native code — a
 * failed lookup becomes a domain error, never a dropped query (the sidecar
 * call is parked waiting).
 */
export class PluginSessionQueryBridge {
  private unlisten: UnlistenFn | null = null;
  private readonly active = new Set<string>();

  constructor(private readonly source: PluginSessionSnapshotSource) {}

  async start(): Promise<void> {
    if (this.unlisten || !isTauri()) return;
    this.unlisten = await listenNativeEvent<unknown>(PLUGIN_SESSION_QUERY_EVENT, ({ payload }) => {
      const query = validateQuery(payload);
      if (!query || this.active.has(query.queryId)) return;
      this.active.add(query.queryId);
      void this.answer(query).finally(() => this.active.delete(query.queryId));
    });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.active.clear();
  }

  private async answer(query: PluginSessionQuery): Promise<void> {
    const result = this.buildResult(query);
    try {
      await invoke(PLUGIN_SESSION_QUERY_RESULT_COMMAND, { result });
    } catch {
      // The native 10s bound resolves the parked call when IPC fails.
    }
  }

  private buildResult(query: PluginSessionQuery): PluginSessionQueryResult {
    // `kind` is flattened onto the query object (tagged union), so the
    // discriminant and the capture fields live on the query itself.
    if (query.kind === 'list') {
      return okResult(query.queryId, { sessions: this.source.listSessions() });
    }
    const captureQuery = query as unknown as {
      queryId: string;
      sessionId: string;
      fromSequence: number;
      maxFrames: number;
      maxBytes: number;
    };
    const maxFrames = clampPageSize(captureQuery.maxFrames);
    const maxBytes = clampPageSize(captureQuery.maxBytes);
    const page = this.source.readCapture({
      sessionId: captureQuery.sessionId,
      fromSequence: captureQuery.fromSequence,
      maxFrames,
      maxBytes,
    });
    if (!page) return errorResult(query.queryId, 'not-found');
    return okResult(query.queryId, {
      frames: page.frames,
      nextSequence: page.nextSequence ?? 0,
      hasMore: page.nextSequence !== null,
    });
  }
}

function okResult(
  queryId: string,
  data: {
    sessions?: readonly PluginSessionSummary[];
    frames?: readonly PluginCapturedFrame[];
    nextSequence?: number;
    hasMore?: boolean;
  },
): PluginSessionQueryResult {
  return {
    queryId,
    ok: true,
    sessions: data.sessions ? [...data.sessions] : [],
    frames: data.frames ? [...data.frames] : [],
    nextSequence: data.nextSequence ?? 0,
    hasMore: data.hasMore ?? false,
  };
}

function errorResult(queryId: string, errorCode: string): PluginSessionQueryResult {
  return {
    queryId,
    ok: false,
    errorCode,
    sessions: [],
    frames: [],
    nextSequence: 0,
    hasMore: false,
  };
}

function clampPageSize(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 1;
  return Math.min(Math.floor(requested), MAX_CAPTURE_PAGE_FRAMES);
}

function validateQuery(value: unknown): PluginSessionQuery | null {
  if (!isRecord(value)) return null;
  if (!validIdentity(value.queryId) || !validIdentity(value.pluginId)) return null;
  if (value.kind === 'list') return value as unknown as PluginSessionQuery;
  if (value.kind !== 'capture') return null;
  const fromSequence = value.fromSequence;
  const maxFrames = value.maxFrames;
  const maxBytes = value.maxBytes;
  if (
    !validIdentity(value.sessionId) ||
    typeof fromSequence !== 'number' ||
    !Number.isSafeInteger(fromSequence) ||
    fromSequence < 0 ||
    typeof maxFrames !== 'number' ||
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > MAX_CAPTURE_PAGE_FRAMES ||
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_CAPTURE_PAGE_BYTES
  ) {
    return null;
  }
  return value as unknown as PluginSessionQuery;
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const PLUGIN_CAPTURE_PAGE_LIMITS = {
  maxFrames: MAX_CAPTURE_PAGE_FRAMES,
  maxBytes: MAX_CAPTURE_PAGE_BYTES,
  maxFrameBytes: MAX_FRAME_BYTES,
} as const;
