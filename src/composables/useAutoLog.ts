import { save } from '@tauri-apps/plugin-dialog';
import { useSessionStore } from '../stores/sessions';
import { useAppStore } from '../stores/app';
import { invokeAppendLog } from '../lib/ipc';
import { formatFrameData, formatLogLine } from '../lib/format';
import { logger } from '../lib/logger';
import type { DataFrame } from '../types';

// Per-session promise chain. Appends are serialized so log lines land in arrival
// order, but each call returns immediately — the chain drains in the background
// and never blocks the serial RX/TX path. The Rust append_log command is itself
// stateless (open/write/close per call), so a crash loses at most the in-flight
// line and there is no file handle to leak.
const pendingAppends = new Map<string, Promise<void>>();

export function useAutoLog() {
  const sessionStore = useSessionStore();
  const appStore = useAppStore();

  /**
   * Prompt for a log file and start auto-logging TX/RX frames to it. Returns
   * the chosen path on success, or null if the user dismissed the dialog.
   */
  async function enable(sessionId: string): Promise<string | null> {
    const path = await save({
      filters: [{ name: 'TXT', extensions: ['txt'] }],
    });
    if (!path) return null;
    sessionStore.setAutoLogTarget(sessionId, path);
    return path;
  }

  /** Stop auto-logging. Already-queued writes drain in the background. */
  function disable(sessionId: string) {
    sessionStore.setAutoLogTarget(sessionId, null);
  }

  /**
   * Append a frame to the session's log if auto-logging is active. Data is
   * formatted with the current display mode (HEX / ASCII / UTF-8 / ANSI) so the
   * logged line matches what the user sees on screen. No-op when disabled.
   */
  function appendFrame(sessionId: string, frame: DataFrame) {
    const session = sessionStore.sessions.find((s) => s.id === sessionId);
    const path = session?.logPath;
    if (!session?.autoLogEnabled || !path) return;

    const dataText = formatFrameData(frame.data, appStore.displayMode);
    const line = `${formatLogLine(frame.timestamp, frame.direction, dataText)}\n`;

    const prev = pendingAppends.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => invokeAppendLog(path, line))
      .catch((e) => {
        logger.warn('auto-log append failed for', sessionId, e);
      });
    pendingAppends.set(sessionId, next);
  }

  return { enable, disable, appendFrame };
}
