import type { DataFrame, SendHistoryEntry, SerialSession } from '../types';

export const SESSION_FRAME_TRIM_THRESHOLD = 500;
export const MAX_SESSION_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_GLOBAL_FRAME_BYTES = 256 * 1024 * 1024;

export interface FrameBufferTrimResult {
  retainedBytes: number;
  droppedBytes: number;
  droppedFrames: number;
}

export interface FrameBufferLimits {
  trimThreshold?: number;
  maxBytes?: number;
  currentBytes?: number;
}

export function trimFrameBuffer<T>(
  frames: T[],
  maxFrames: number,
  trimThreshold = SESSION_FRAME_TRIM_THRESHOLD,
): boolean {
  if (frames.length <= maxFrames + trimThreshold) return false;
  frames.splice(0, frames.length - maxFrames);
  return true;
}

/**
 * Append a frame to the session's live (or paused) buffer, trim to the cap,
 * and bump the direction byte/frame counters.
 *
 * Accepts the session either as a plain object or a Vue reactive proxy, but
 * for the high-frequency RX/TX path callers should pass the raw target (Vue's
 * `toRaw`): bumping `rxBytes`/`txBytes`/`rxFrames`/`txFrames` through a
 * `shallowReactive` proxy triggers its setter on every frame, which dominates
 * the per-frame cost during a sustained capture. The caller's reactivity
 * channel (e.g. `notifyFramesChanged`) refreshes the consumers that read these
 * counters, so the per-write trigger is redundant.
 */
export function appendFrameToSession(
  session: SerialSession,
  frame: DataFrame,
  maxFrames: number,
  limits: FrameBufferLimits = {},
): FrameBufferTrimResult {
  const target = session.capturePaused ? session.pausedFrames : session.frames;
  target.push(frame);

  const trimThreshold = limits.trimThreshold ?? SESSION_FRAME_TRIM_THRESHOLD;
  let retainedBytes =
    (limits.currentBytes ?? frameBuffersByteLength(session) - frame.data.length) +
    frame.data.length;
  let droppedBytes = 0;
  let droppedFrames = 0;

  if (target.length > maxFrames + trimThreshold) {
    const count = target.length - maxFrames;
    for (let index = 0; index < count; index += 1) {
      // SQLite trims by append sequence. Even while capture is paused, the
      // renderer must evict that same per-session prefix instead of trimming
      // only pausedFrames and retaining different content after restart.
      const dropped = shiftOldestSessionFrame(session);
      if (!dropped) break;
      droppedBytes += dropped.data.length;
      droppedFrames += 1;
    }
    retainedBytes -= droppedBytes;
  }

  const maxBytes = limits.maxBytes ?? MAX_SESSION_FRAME_BYTES;
  while (retainedBytes > maxBytes) {
    const dropped = shiftOldestSessionFrame(session);
    if (!dropped) break;
    retainedBytes -= dropped.data.length;
    droppedBytes += dropped.data.length;
    droppedFrames += 1;
  }

  if (frame.direction === 'TX') {
    session.txBytes += frame.data.length;
    session.txFrames += 1;
  } else {
    session.rxBytes += frame.data.length;
    session.rxFrames += 1;
  }

  return { retainedBytes, droppedBytes, droppedFrames };
}

export function flushPausedFramesToLive(
  session: SerialSession,
  maxFrames: number,
  limits: number | FrameBufferLimits = {},
): FrameBufferTrimResult {
  const normalizedLimits = typeof limits === 'number' ? { trimThreshold: limits } : limits;
  const currentBytes = normalizedLimits.currentBytes ?? frameBuffersByteLength(session);
  if (session.pausedFrames.length === 0) {
    return { retainedBytes: currentBytes, droppedBytes: 0, droppedFrames: 0 };
  }
  for (const held of session.pausedFrames) session.frames.push(held);
  session.pausedFrames = [];
  const trimThreshold = normalizedLimits.trimThreshold ?? SESSION_FRAME_TRIM_THRESHOLD;
  let retainedBytes = currentBytes;
  let droppedBytes = 0;
  let droppedFrames = 0;
  if (session.frames.length > maxFrames + trimThreshold) {
    const removed = session.frames.splice(0, session.frames.length - maxFrames);
    for (const dropped of removed) droppedBytes += dropped.data.length;
    droppedFrames = removed.length;
    retainedBytes -= droppedBytes;
  }

  const maxBytes = normalizedLimits.maxBytes ?? MAX_SESSION_FRAME_BYTES;
  while (retainedBytes > maxBytes) {
    const dropped = session.frames.shift();
    if (!dropped) break;
    retainedBytes -= dropped.data.length;
    droppedBytes += dropped.data.length;
    droppedFrames += 1;
  }
  return { retainedBytes, droppedBytes, droppedFrames };
}

export function frameBuffersByteLength(
  session: Pick<SerialSession, 'frames' | 'pausedFrames'>,
): number {
  let total = 0;
  for (const frame of session.frames) total += frame.data.length;
  for (const frame of session.pausedFrames) total += frame.data.length;
  return total;
}

export interface GlobalFrameTrimResult {
  retainedBytes: number;
  droppedBytesBySession: Map<string, number>;
  droppedFramesBySession: Map<string, number>;
}

/** Drop the globally oldest retained frames until the aggregate byte cap fits. */
export function trimSessionsToGlobalByteLimit(
  sessions: readonly SerialSession[],
  currentBytes: number,
  maxBytes = MAX_GLOBAL_FRAME_BYTES,
): GlobalFrameTrimResult {
  let retainedBytes = currentBytes;
  const droppedBytesBySession = new Map<string, number>();
  const droppedFramesBySession = new Map<string, number>();

  while (retainedBytes > maxBytes) {
    let oldestSession: SerialSession | null = null;
    let oldestBuffer: DataFrame[] | null = null;
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (const session of sessions) {
      // Only the first frame in persisted sequence order is eligible for a
      // per-session trim. Comparing paused and live timestamps here could
      // select a non-prefix row that the count-based SQLite mutation cannot
      // represent.
      const buffer = oldestSessionBuffer(session);
      const candidate = buffer?.[0];
      if (!candidate) continue;
      const timestamp = Number.isFinite(candidate.timestamp) ? candidate.timestamp : 0;
      if (timestamp >= oldestTimestamp) continue;
      oldestTimestamp = timestamp;
      oldestSession = session;
      oldestBuffer = buffer;
    }

    if (!oldestSession || !oldestBuffer) {
      retainedBytes = 0;
      break;
    }
    const dropped = oldestBuffer.shift();
    if (!dropped) continue;
    retainedBytes -= dropped.data.length;
    droppedBytesBySession.set(
      oldestSession.id,
      (droppedBytesBySession.get(oldestSession.id) ?? 0) + dropped.data.length,
    );
    droppedFramesBySession.set(
      oldestSession.id,
      (droppedFramesBySession.get(oldestSession.id) ?? 0) + 1,
    );
  }

  return { retainedBytes, droppedBytesBySession, droppedFramesBySession };
}

function oldestSessionBuffer(session: SerialSession): DataFrame[] | null {
  // pausedFrames are appended only after all currently retained live frames;
  // resuming appends them back to the live tail. This is therefore the exact
  // persisted sequence order, independent of wall-clock timestamp skew.
  if (session.frames.length > 0) return session.frames;
  return session.pausedFrames.length > 0 ? session.pausedFrames : null;
}

function shiftOldestSessionFrame(session: SerialSession): DataFrame | undefined {
  return oldestSessionBuffer(session)?.shift();
}

export function resetSessionFrames(session: SerialSession): void {
  session.frames = [];
  session.pausedFrames = [];
  session.capturePaused = false;
  session.txBytes = 0;
  session.rxBytes = 0;
  session.txFrames = 0;
  session.rxFrames = 0;
}

export function upsertSendHistory(
  history: readonly SendHistoryEntry[],
  entry: SendHistoryEntry,
  maxHistory: number,
): SendHistoryEntry[] {
  const next = history.filter((item) => !(item.data === entry.data && item.isHex === entry.isHex));
  next.unshift(entry);
  return next.length > maxHistory ? next.slice(0, maxHistory) : next;
}

export function appendIdentifiedItem<T extends { id: string }>(
  items: T[],
  item: Omit<T, 'id'>,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const id = createId();
  items.push({ ...item, id } as T);
  return id;
}

export function patchIdentifiedItem<T extends { id: string }>(
  items: T[],
  id: string,
  patch: Partial<Omit<T, 'id'>>,
): boolean {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return false;
  items[index] = { ...items[index], ...patch, id: items[index].id };
  return true;
}

export function removeIdentifiedItem<T extends { id: string }>(
  items: readonly T[],
  id: string,
): T[] {
  return items.filter((item) => item.id !== id);
}

export function normalizeLogAiFrameLimit(limit: number): number {
  return Math.max(20, Math.min(2000, Math.floor(limit || 200)));
}
