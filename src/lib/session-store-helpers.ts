import type { DataFrame, SendHistoryEntry, SerialSession } from '../types';

export const SESSION_FRAME_TRIM_THRESHOLD = 500;

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
  trimThreshold = SESSION_FRAME_TRIM_THRESHOLD,
): void {
  const target = session.capturePaused ? session.pausedFrames : session.frames;
  target.push(frame);
  trimFrameBuffer(target, maxFrames, trimThreshold);

  if (frame.direction === 'TX') {
    session.txBytes += frame.data.length;
    session.txFrames += 1;
  } else {
    session.rxBytes += frame.data.length;
    session.rxFrames += 1;
  }
}

export function flushPausedFramesToLive(
  session: SerialSession,
  maxFrames: number,
  trimThreshold = SESSION_FRAME_TRIM_THRESHOLD,
): void {
  if (session.pausedFrames.length === 0) return;
  for (const held of session.pausedFrames) session.frames.push(held);
  session.pausedFrames = [];
  trimFrameBuffer(session.frames, maxFrames, trimThreshold);
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
