/**
 * MCUMgr per-session configuration helpers. The protocol itself runs in the
 * Rust command layer (`mcumgr-toolkit`); the frontend only persists transport
 * tuning plus the shell history and forwards it with each invoke.
 */

import type { McumgrClientConfig } from '../types/mcumgr';

export const MCUMGR_SHELL_HISTORY_LIMIT = 50;

export const DEFAULT_MCUMGR_CONFIG: McumgrClientConfig = {
  autoFrameSize: true,
  frameSize: 512,
  timeoutMs: 10_000,
  retries: 3,
  shellHistory: [],
};

export const MCUMGR_CONFIG_KEYS = [
  'autoFrameSize',
  'frameSize',
  'timeoutMs',
  'retries',
  'shellHistory',
] as const;

/**
 * Legacy keys from the removed TypeScript SMP stack. Persisted sessions may
 * still carry them; hydration tolerates and drops them.
 */
export const MCUMGR_LEGACY_CONFIG_KEYS = [
  'transport',
  'lineLength',
  'mtu',
  'smpVersion',
  'firstChunkTimeoutMs',
  'subsequentTimeoutMs',
] as const;

export function cloneMcumgrConfig(config: McumgrClientConfig): McumgrClientConfig {
  return {
    ...config,
    shellHistory: [...config.shellHistory],
  };
}

export function normalizeMcumgrConfig(raw: unknown): McumgrClientConfig {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  // The legacy `mtu` field was the SMP body budget (default 512); it seeds the
  // manual frame size so tuned setups keep their value across the migration.
  const frameSeed = source.frameSize ?? source.mtu;
  return {
    autoFrameSize: typeof source.autoFrameSize === 'boolean' ? source.autoFrameSize : true,
    frameSize: clampInt(frameSeed, 64, 65_535, DEFAULT_MCUMGR_CONFIG.frameSize),
    timeoutMs: clampInt(source.timeoutMs, 100, 120_000, DEFAULT_MCUMGR_CONFIG.timeoutMs),
    retries: clampInt(source.retries, 0, 16, DEFAULT_MCUMGR_CONFIG.retries),
    shellHistory: normalizeHistory(source.shellHistory),
  };
}

export function persistableMcumgrConfig(config: McumgrClientConfig): McumgrClientConfig {
  return {
    ...cloneMcumgrConfig(config),
    shellHistory: config.shellHistory.slice(-MCUMGR_SHELL_HISTORY_LIMIT),
  };
}

export function validateMcumgrConfig(config: McumgrClientConfig, field: string): void {
  const normalized = persistableMcumgrConfig(normalizeMcumgrConfig(config));
  for (const key of MCUMGR_CONFIG_KEYS) {
    if (!(key in config)) throw new TypeError(`${field}.${key} is required`);
  }
  if (normalized.autoFrameSize !== config.autoFrameSize) {
    throw new TypeError(`${field}.autoFrameSize`);
  }
  if (normalized.frameSize !== config.frameSize) throw new TypeError(`${field}.frameSize`);
  if (normalized.timeoutMs !== config.timeoutMs) throw new TypeError(`${field}.timeoutMs`);
  if (normalized.retries !== config.retries) throw new TypeError(`${field}.retries`);
}

export function appendShellHistory(history: readonly string[], command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [...history];
  const next = history.filter((item) => item !== trimmed);
  next.push(trimmed);
  return next.slice(-MCUMGR_SHELL_HISTORY_LIMIT);
}

function normalizeHistory(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(-MCUMGR_SHELL_HISTORY_LIMIT);
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}
