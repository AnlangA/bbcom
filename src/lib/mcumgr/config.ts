import type { McumgrClientConfig, McumgrSmpVersion, McumgrTransportMode } from '../../types/mcumgr';

export const MCUMGR_SHELL_HISTORY_LIMIT = 50;

export const DEFAULT_MCUMGR_CONFIG: McumgrClientConfig = {
  transport: 'console',
  lineLength: 127,
  mtu: 512,
  timeoutMs: 10_000,
  firstChunkTimeoutMs: 60_000,
  subsequentTimeoutMs: 3_000,
  retries: 1,
  smpVersion: 2,
  shellHistory: [],
};

export const MCUMGR_CONFIG_KEYS = [
  'transport',
  'lineLength',
  'mtu',
  'timeoutMs',
  'firstChunkTimeoutMs',
  'subsequentTimeoutMs',
  'retries',
  'smpVersion',
  'shellHistory',
] as const;

export function cloneMcumgrConfig(config: McumgrClientConfig): McumgrClientConfig {
  return {
    ...config,
    shellHistory: [...config.shellHistory],
  };
}

export function normalizeMcumgrConfig(raw: unknown): McumgrClientConfig {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    transport: normalizeTransport(source.transport),
    lineLength: clampInt(source.lineLength, 16, 8192, DEFAULT_MCUMGR_CONFIG.lineLength),
    mtu: clampInt(source.mtu, 64, 65_535, DEFAULT_MCUMGR_CONFIG.mtu),
    timeoutMs: clampInt(source.timeoutMs, 100, 120_000, DEFAULT_MCUMGR_CONFIG.timeoutMs),
    firstChunkTimeoutMs: clampInt(
      source.firstChunkTimeoutMs,
      100,
      180_000,
      DEFAULT_MCUMGR_CONFIG.firstChunkTimeoutMs,
    ),
    subsequentTimeoutMs: clampInt(
      source.subsequentTimeoutMs,
      100,
      60_000,
      DEFAULT_MCUMGR_CONFIG.subsequentTimeoutMs,
    ),
    retries: clampInt(source.retries, 0, 5, DEFAULT_MCUMGR_CONFIG.retries),
    smpVersion: normalizeVersion(source.smpVersion),
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
  if (normalized.transport !== config.transport) throw new TypeError(`${field}.transport`);
  if (normalized.lineLength !== config.lineLength) throw new TypeError(`${field}.lineLength`);
  if (normalized.mtu !== config.mtu) throw new TypeError(`${field}.mtu`);
  if (normalized.timeoutMs !== config.timeoutMs) throw new TypeError(`${field}.timeoutMs`);
  if (normalized.firstChunkTimeoutMs !== config.firstChunkTimeoutMs) {
    throw new TypeError(`${field}.firstChunkTimeoutMs`);
  }
  if (normalized.subsequentTimeoutMs !== config.subsequentTimeoutMs) {
    throw new TypeError(`${field}.subsequentTimeoutMs`);
  }
  if (normalized.retries !== config.retries) throw new TypeError(`${field}.retries`);
  if (normalized.smpVersion !== config.smpVersion) throw new TypeError(`${field}.smpVersion`);
}

export function appendShellHistory(history: readonly string[], command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [...history];
  const next = history.filter((item) => item !== trimmed);
  next.push(trimmed);
  return next.slice(-MCUMGR_SHELL_HISTORY_LIMIT);
}

function normalizeTransport(raw: unknown): McumgrTransportMode {
  return raw === 'raw-uart' ? 'raw-uart' : 'console';
}

function normalizeVersion(raw: unknown): McumgrSmpVersion {
  return raw === 1 ? 1 : 2;
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
