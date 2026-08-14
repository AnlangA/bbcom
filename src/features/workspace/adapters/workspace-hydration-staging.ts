import type {
  HydrateWorkspaceAiMessagesRequest,
  HydrateWorkspaceAiMessagesResponse,
  HydrateWorkspaceCollectionsRequest,
  HydrateWorkspaceCollectionsResponse,
  HydrateWorkspaceFramesRequest,
  HydrateWorkspaceFramesResponse,
  HydrateWorkspaceSessionsRequest,
  HydrateWorkspaceSessionsResponse,
  HydrateWorkspaceWaveformRequest,
  HydrateWorkspaceWaveformResponse,
  WorkspaceAiMessage,
  WorkspaceHydratedFrame,
  WorkspaceSessionSnapshot,
  WorkspaceWaveformChannel,
  WorkspaceWaveformSample,
} from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import {
  WorkspaceAdapterLimitError,
  WorkspaceAdapterValidationError,
} from './workspace-adapter-errors';
import { validateWorkspaceIdentifier } from './workspace-adapter-security';
import {
  hydrateWorkspaceSession,
  type HydratedWorkspaceSession,
} from './workspace-session-adapter';

export interface WorkspaceHydrationPort {
  hydrateSessions(
    request: HydrateWorkspaceSessionsRequest,
  ): Promise<HydrateWorkspaceSessionsResponse>;
  hydrateFrames(request: HydrateWorkspaceFramesRequest): Promise<HydrateWorkspaceFramesResponse>;
  hydrateCollections(
    request: HydrateWorkspaceCollectionsRequest,
  ): Promise<HydrateWorkspaceCollectionsResponse>;
  hydrateAiMessages(
    request: HydrateWorkspaceAiMessagesRequest,
  ): Promise<HydrateWorkspaceAiMessagesResponse>;
  hydrateWaveform(
    request: HydrateWorkspaceWaveformRequest,
  ): Promise<HydrateWorkspaceWaveformResponse>;
}

export interface StageWorkspaceHydrationOptions {
  readonly port: WorkspaceHydrationPort;
  readonly workspaceId: string;
  readonly revision: number;
  readonly activeSessionId?: string;
  readonly requestId?: () => string;
  readonly sessionPageSize?: number;
  readonly framePageSize?: number;
  readonly aiPageSize?: number;
  readonly waveformPageSize?: number;
  readonly concurrency?: number;
}

export interface WorkspaceHydrationStaging {
  readonly workspaceId: string;
  readonly revision: number;
  readonly activeSessionId: string | null;
  readonly sessions: readonly HydratedWorkspaceSession[];
}

interface SessionParts {
  readonly frames: WorkspaceHydratedFrame[];
  readonly collections: HydrateWorkspaceCollectionsResponse['collections'];
  readonly aiMessages: WorkspaceAiMessage[];
  readonly waveformChannels: WorkspaceWaveformChannel[];
  readonly waveformSamples: WorkspaceWaveformSample[];
}

/**
 * Fully stage a workspace without touching live renderer state. All page calls
 * must correlate to one revision; any rejection or malformed cursor discards
 * the local staging graph by rejecting this promise.
 */
export async function stageWorkspaceHydration(
  options: StageWorkspaceHydrationOptions,
): Promise<WorkspaceHydrationStaging> {
  const workspaceId = validateWorkspaceIdentifier(options.workspaceId, 'workspaceId');
  const revision = nonNegativeInteger(options.revision, 'revision');
  const requestId = options.requestId ?? (() => crypto.randomUUID());
  const sessionPageSize = boundedInteger(options.sessionPageSize ?? 64, 1, 64, 'sessionPageSize');
  const framePageSize = boundedInteger(options.framePageSize ?? 256, 1, 256, 'framePageSize');
  const aiPageSize = boundedInteger(options.aiPageSize ?? 256, 1, 256, 'aiPageSize');
  const waveformPageSize = boundedInteger(
    options.waveformPageSize ?? 4_096,
    1,
    4_096,
    'waveformPageSize',
  );
  const concurrency = boundedInteger(options.concurrency ?? 3, 1, 16, 'concurrency');

  const snapshots = await hydrateAllSessionSnapshots(
    options.port,
    workspaceId,
    revision,
    requestId,
    sessionPageSize,
  );
  assertLimit('workspaceSessions', IPC_LIMITS.MAX_WORKSPACE_SESSIONS, snapshots.length);
  const sessionIds = new Set<string>();
  for (const snapshot of snapshots) {
    const sessionId = validateWorkspaceIdentifier(snapshot.id, 'snapshot.id');
    if (sessionIds.has(sessionId)) throw new WorkspaceAdapterValidationError('snapshot.id');
    sessionIds.add(sessionId);
  }

  const hydrated = await mapConcurrent(snapshots, concurrency, async (snapshot) => {
    const parts = await hydrateSessionParts(
      options.port,
      workspaceId,
      revision,
      snapshot.id,
      requestId,
      framePageSize,
      aiPageSize,
      waveformPageSize,
    );
    return hydrateWorkspaceSession(snapshot, parts);
  });

  const totalFrames = hydrated.reduce((total, entry) => total + entry.session.frames.length, 0);
  const totalCaptureBytes = hydrated.reduce(
    (total, entry) =>
      total + entry.session.frames.reduce((sum, frame) => sum + frame.data.byteLength, 0),
    0,
  );
  assertLimit('workspaceFrames', IPC_LIMITS.MAX_WORKSPACE_FRAMES, totalFrames);
  assertLimit('workspaceCaptureBytes', IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES, totalCaptureBytes);

  const activeSessionId = options.activeSessionId
    ? validateWorkspaceIdentifier(options.activeSessionId, 'activeSessionId')
    : null;
  if (activeSessionId !== null && !sessionIds.has(activeSessionId)) {
    throw new WorkspaceAdapterValidationError('activeSessionId');
  }
  return Object.freeze({
    workspaceId,
    revision,
    activeSessionId,
    sessions: Object.freeze(hydrated),
  });
}

async function hydrateAllSessionSnapshots(
  port: WorkspaceHydrationPort,
  workspaceId: string,
  revision: number,
  requestId: () => string,
  limit: number,
): Promise<WorkspaceSessionSnapshot[]> {
  const sessions: WorkspaceSessionSnapshot[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const id = nextRequestId(requestId);
    const response = await port.hydrateSessions({
      requestId: id,
      workspaceId,
      offset,
      limit,
    });
    assertResponse(response, { requestId: id, workspaceId, revision });
    assertExactKeys(
      response,
      ['requestId', 'workspaceId', 'revision', 'sessions', 'nextOffset'],
      'sessions.response',
    );
    if (!Array.isArray(response.sessions) || response.sessions.length > limit) {
      throw new WorkspaceAdapterValidationError('sessions.page');
    }
    sessions.push(...response.sessions);
    assertLimit('workspaceSessions', IPC_LIMITS.MAX_WORKSPACE_SESSIONS, sessions.length);
    if (response.nextOffset === undefined) {
      hasMore = false;
    } else {
      const next = nonNegativeInteger(response.nextOffset, 'sessions.nextOffset');
      if (
        response.sessions.length === 0 ||
        next <= offset ||
        next !== offset + response.sessions.length
      ) {
        throw new WorkspaceAdapterValidationError('sessions.nextOffset');
      }
      offset = next;
    }
  }
  return sessions;
}

async function hydrateSessionParts(
  port: WorkspaceHydrationPort,
  workspaceId: string,
  revision: number,
  sessionId: string,
  requestId: () => string,
  frameLimit: number,
  aiLimit: number,
  waveformLimit: number,
): Promise<SessionParts> {
  const collectionsId = nextRequestId(requestId);
  const [collections, frames, aiMessages, waveform] = await Promise.all([
    port
      .hydrateCollections({ requestId: collectionsId, workspaceId, sessionId })
      .then((response) => {
        assertResponse(response, {
          requestId: collectionsId,
          workspaceId,
          sessionId,
          revision,
        });
        assertExactKeys(
          response,
          ['requestId', 'workspaceId', 'sessionId', 'revision', 'collections'],
          'collections.response',
        );
        return response.collections;
      }),
    hydrateAllFrames(port, workspaceId, revision, sessionId, requestId, frameLimit),
    hydrateAllAiMessages(port, workspaceId, revision, sessionId, requestId, aiLimit),
    hydrateAllWaveform(port, workspaceId, revision, sessionId, requestId, waveformLimit),
  ]);
  return {
    collections,
    frames,
    aiMessages,
    waveformChannels: waveform.channels,
    waveformSamples: waveform.samples,
  };
}

async function hydrateAllFrames(
  port: WorkspaceHydrationPort,
  workspaceId: string,
  revision: number,
  sessionId: string,
  requestId: () => string,
  limit: number,
): Promise<WorkspaceHydratedFrame[]> {
  const frames: WorkspaceHydratedFrame[] = [];
  let fromSeq = 0;
  let previousSeq = -1;
  let hasMore = true;
  while (hasMore) {
    const id = nextRequestId(requestId);
    const response = await port.hydrateFrames({
      requestId: id,
      workspaceId,
      sessionId,
      fromSeq,
      limit,
    });
    assertResponse(response, { requestId: id, workspaceId, sessionId, revision });
    assertExactKeys(
      response,
      ['requestId', 'workspaceId', 'sessionId', 'revision', 'frames', 'nextSeq'],
      'frames.response',
    );
    if (!Array.isArray(response.frames) || response.frames.length > limit) {
      throw new WorkspaceAdapterValidationError('frames.page');
    }
    for (const frame of response.frames) {
      const seq = nonNegativeInteger(frame.seq, 'frames.seq');
      if (seq < fromSeq || seq <= previousSeq) {
        throw new WorkspaceAdapterValidationError('frames.seq');
      }
      previousSeq = seq;
    }
    frames.push(...response.frames);
    assertLimit('sessionFrames', IPC_LIMITS.MAX_WORKSPACE_FRAMES_PER_SESSION, frames.length);
    if (response.nextSeq === undefined) {
      hasMore = false;
    } else {
      const next = nonNegativeInteger(response.nextSeq, 'frames.nextSeq');
      if (response.frames.length === 0 || next <= previousSeq) {
        throw new WorkspaceAdapterValidationError('frames.nextSeq');
      }
      fromSeq = next;
    }
  }
  return frames;
}

async function hydrateAllAiMessages(
  port: WorkspaceHydrationPort,
  workspaceId: string,
  revision: number,
  sessionId: string,
  requestId: () => string,
  limit: number,
): Promise<WorkspaceAiMessage[]> {
  const messages: WorkspaceAiMessage[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const id = nextRequestId(requestId);
    const response = await port.hydrateAiMessages({
      requestId: id,
      workspaceId,
      sessionId,
      offset,
      limit,
    });
    assertResponse(response, { requestId: id, workspaceId, sessionId, revision });
    assertExactKeys(
      response,
      ['requestId', 'workspaceId', 'sessionId', 'revision', 'messages', 'nextOffset'],
      'aiMessages.response',
    );
    if (!Array.isArray(response.messages) || response.messages.length > limit) {
      throw new WorkspaceAdapterValidationError('aiMessages.page');
    }
    messages.push(...response.messages);
    assertLimit('aiMessages', IPC_LIMITS.MAX_WORKSPACE_AI_MESSAGES, messages.length);
    if (response.nextOffset === undefined) {
      hasMore = false;
    } else {
      const next = nonNegativeInteger(response.nextOffset, 'aiMessages.nextOffset');
      if (next <= offset || next !== offset + response.messages.length) {
        throw new WorkspaceAdapterValidationError('aiMessages.nextOffset');
      }
      offset = next;
    }
  }
  return messages;
}

async function hydrateAllWaveform(
  port: WorkspaceHydrationPort,
  workspaceId: string,
  revision: number,
  sessionId: string,
  requestId: () => string,
  limit: number,
): Promise<{ channels: WorkspaceWaveformChannel[]; samples: WorkspaceWaveformSample[] }> {
  const channelMap = new Map<number, WorkspaceWaveformChannel>();
  const samples: WorkspaceWaveformSample[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const id = nextRequestId(requestId);
    const response = await port.hydrateWaveform({
      requestId: id,
      workspaceId,
      sessionId,
      offset,
      limit,
    });
    assertResponse(response, { requestId: id, workspaceId, sessionId, revision });
    assertExactKeys(
      response,
      ['requestId', 'workspaceId', 'sessionId', 'revision', 'channels', 'samples', 'nextOffset'],
      'waveform.response',
    );
    if (
      !Array.isArray(response.channels) ||
      !Array.isArray(response.samples) ||
      response.samples.length > limit
    ) {
      throw new WorkspaceAdapterValidationError('waveform.page');
    }
    for (const channel of response.channels) {
      const existing = channelMap.get(channel.channelIndex);
      if (existing && JSON.stringify(existing) !== JSON.stringify(channel)) {
        throw new WorkspaceAdapterValidationError('waveform.channels');
      }
      channelMap.set(channel.channelIndex, channel);
    }
    samples.push(...response.samples);
    if (response.nextOffset === undefined) {
      hasMore = false;
    } else {
      const next = nonNegativeInteger(response.nextOffset, 'waveform.nextOffset');
      if (next <= offset || next !== offset + response.samples.length) {
        throw new WorkspaceAdapterValidationError('waveform.nextOffset');
      }
      offset = next;
    }
  }
  return { channels: Array.from(channelMap.values()), samples };
}

function assertResponse(
  response: {
    requestId: string;
    workspaceId: string;
    sessionId?: string;
    revision: number;
  },
  expected: {
    requestId: string;
    workspaceId: string;
    sessionId?: string;
    revision: number;
  },
): void {
  if (
    response.requestId !== expected.requestId ||
    response.workspaceId !== expected.workspaceId ||
    response.revision !== expected.revision ||
    (expected.sessionId !== undefined && response.sessionId !== expected.sessionId)
  ) {
    throw new WorkspaceAdapterValidationError('hydrate.responseEnvelope');
  }
}

async function mapConcurrent<T, R>(
  input: readonly T[],
  concurrency: number,
  project: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(input.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= input.length) return;
      results[index] = await project(input[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function nextRequestId(factory: () => string): string {
  return validateWorkspaceIdentifier(factory(), 'requestId');
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new WorkspaceAdapterValidationError(field);
  return value;
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return value;
}

function assertLimit(field: string, limit: number, actual: number): void {
  if (actual > limit) throw new WorkspaceAdapterLimitError(field, limit, actual);
}

function assertExactKeys(value: unknown, allowed: readonly string[], field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceAdapterValidationError(field);
  }
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new WorkspaceAdapterValidationError(field);
  }
}
