import type {
  AiModel,
  DataFrame,
  Direction,
  DirectionFilter,
  HighlightColor,
  HighlightMatchMode,
  HighlightRule,
  LogAiContextMode,
  Macro,
  ModbusMasterConfig,
  ModbusRegister,
  PortConfig,
  SendHistoryEntry,
  SessionParserState,
  SerialSession,
  Trigger,
  WaveformSourceMode,
} from '../types';
import { MAX_HISTORY } from '../types';
import type { ParserConfig } from './protocol-parser';
import { parseHex, toContinuousHex } from './format';
import { nowMillis } from './time';
import { DEFAULT_RX_FRAME_GAP_MS, normalizeRxFrameGapMs } from './serial-framing';
import {
  DEFAULT_MODBUS_CONFIG,
  cloneModbusConfig,
  normalizeModbusConfig,
  normalizeModbusRegisters,
  persistableModbusRegisters,
} from './modbus';

export const SESSION_STORAGE_KEY = 'bbcom-session-snapshots';
export const SESSION_STORAGE_FUTURE_BACKUP_KEY = `${SESSION_STORAGE_KEY}-future-backup`;
export const SESSION_STORAGE_VERSION = 2;
/** Number of most-recently-used sessions whose capture tails are retained. */
export const MAX_PERSISTED_SESSIONS = 8;
export const MAX_PERSISTED_FRAMES_PER_SESSION = 2_000;
export const MAX_PERSISTED_BYTES_PER_SESSION = 1_000_000;

export const DEFAULT_PORT_CONFIG: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: DEFAULT_RX_FRAME_GAP_MS,
  dtr: false,
  rts: false,
};

export const DEFAULT_PARSER_STATE: SessionParserState = {
  config: {
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: false,
  },
  presetId: 'at-crlf',
};

export interface PersistedFrame {
  id: string;
  direction: Direction;
  timestamp: number;
  data: Uint8Array;
  txStatus?: DataFrame['txStatus'];
  requestedBytes?: number;
}

export interface PersistedSession {
  id: string;
  portName: string;
  portConfig: PortConfig;
  frames: PersistedFrame[];
  sendHistory: SendHistoryEntry[];
  sendDraft: string;
  quickCommands: SerialSession['quickCommands'];
  macros: Macro[];
  triggers: Trigger[];
  highlights: HighlightRule[];
  parserState: SessionParserState;
  modbusRegisters: ModbusRegister[];
  modbusConfig: ModbusMasterConfig;
  waveformSourceMode: WaveformSourceMode;
  terminalAiModel: AiModel;
  logAiModel: AiModel;
  logAiContextMode: LogAiContextMode;
  logAiFrameLimit: number;
}

export interface PersistedSessionsFile {
  version: number;
  activeSessionId: string | null;
  mruSessionIds?: string[];
  sessions: PersistedSession[];
}

/**
 * Versioned persistence migration.
 *
 * Every persisted blob carries a `version` tag. When a shape change lands, bump
 * SESSION_STORAGE_VERSION and register a step here that upgrades a blob from the
 * previous version to the new one. `migratePersistedFile` walks the chain from
 * the blob's recorded version up to the current one, then re-stamps the version.
 *
 * Future versions are rejected rather than re-stamped, preventing an older app
 * from silently overwriting data it does not understand.
 */
export type MigrationStep = (raw: PersistedSessionsFile) => PersistedSessionsFile;

/**
 * Ordered migration steps. Entry zero upgrades the original v1 shape to v2;
 * versionless legacy files take the same path after their implicit v1 stamp.
 * Add one entry and bump SESSION_STORAGE_VERSION for every later shape change.
 */
export const MIGRATION_STEPS: readonly MigrationStep[] = [
  (raw) => ({
    ...raw,
    version: 2,
    mruSessionIds: normalizePersistedMruSessionIds(
      raw.sessions,
      raw.activeSessionId,
      raw.mruSessionIds,
    ),
  }),
];

export class UnsupportedSessionStorageVersionError extends Error {
  readonly storedVersion: number;

  constructor(storedVersion: number) {
    super(
      `session storage version ${storedVersion} is newer than supported version ${SESSION_STORAGE_VERSION}`,
    );
    this.name = 'UnsupportedSessionStorageVersionError';
    this.storedVersion = storedVersion;
  }
}

/** Walk the migration chain from the blob's recorded version to the current one. */
export function migratePersistedFile(raw: unknown): PersistedSessionsFile {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const startVersion =
    typeof source.version === 'number' && Number.isInteger(source.version) && source.version >= 0
      ? source.version
      : 0;
  if (startVersion > SESSION_STORAGE_VERSION) {
    throw new UnsupportedSessionStorageVersionError(startVersion);
  }

  let current: PersistedSessionsFile = {
    version: startVersion,
    activeSessionId: typeof source.activeSessionId === 'string' ? source.activeSessionId : null,
    mruSessionIds: Array.isArray(source.mruSessionIds)
      ? source.mruSessionIds.filter((id): id is string => typeof id === 'string')
      : undefined,
    sessions: Array.isArray(source.sessions) ? ([...source.sessions] as PersistedSession[]) : [],
  };
  // Missing-version blobs are the implicit v1 shape. Migration entry zero is
  // therefore applied for both version 0 and version 1 inputs.
  const firstStep = Math.max(0, startVersion - 1);
  for (let step = firstStep; step < MIGRATION_STEPS.length; step += 1) {
    current = MIGRATION_STEPS[step](current);
  }
  return {
    ...current,
    version: SESSION_STORAGE_VERSION,
    mruSessionIds: normalizePersistedMruSessionIds(
      current.sessions,
      current.activeSessionId,
      current.mruSessionIds,
    ),
  };
}

export function normalizePersistedMruSessionIds(
  sessions: readonly Pick<PersistedSession, 'id'>[],
  activeSessionId: string | null,
  requested: readonly string[] | undefined,
): string[] {
  const validIds = new Set(sessions.map((session) => session.id));
  const seen = new Set<string>();
  const ordered: string[] = [];
  const candidates = [
    activeSessionId,
    ...(requested ?? []),
    ...sessions.map((session) => session.id),
  ];
  for (const id of candidates) {
    if (typeof id !== 'string' || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    if (ordered.length >= MAX_PERSISTED_SESSIONS) break;
  }
  return ordered;
}

interface SessionPersistenceOptions {
  createId?: () => string;
  now?: () => number;
  decorateFrame?: (frame: DataFrame) => DataFrame;
}

function createId(options: SessionPersistenceOptions): string {
  return options.createId?.() ?? crypto.randomUUID();
}

function now(options: SessionPersistenceOptions): number {
  return options.now?.() ?? nowMillis();
}

function decorateFrame(frame: DataFrame, options: SessionPersistenceOptions): DataFrame {
  return options.decorateFrame?.(frame) ?? frame;
}

export function cloneParserConfig(config: ParserConfig): ParserConfig {
  if (config.kind === 'fixed') {
    return {
      kind: 'fixed',
      frameSize: Math.max(1, Math.min(65_535, Math.floor(config.frameSize || 1))),
    };
  }
  if (config.kind === 'length') {
    const lengthSize: 1 | 2 | 4 =
      config.lengthSize === 2 || config.lengthSize === 4 ? config.lengthSize : 1;
    return {
      kind: 'length',
      lengthOffset: Math.max(0, Math.min(255, Math.floor(config.lengthOffset || 0))),
      lengthSize,
      bigEndian: config.bigEndian !== false,
      lengthAdjust: Math.max(0, Math.min(65_535, Math.floor(config.lengthAdjust || 0))),
    };
  }
  if (config.kind === 'delimiter') {
    return {
      kind: 'delimiter',
      delimiter: Array.isArray(config.delimiter)
        ? config.delimiter
            .filter((b) => Number.isFinite(b))
            .map((b) => Math.max(0, Math.min(255, Math.floor(b))))
            .slice(0, 256)
        : [0x0d, 0x0a],
      includeDelimiter: config.includeDelimiter === true,
    };
  }
  return cloneParserConfig(DEFAULT_PARSER_STATE.config);
}

export function cloneParserState(state: SessionParserState): SessionParserState {
  return {
    config: cloneParserConfig(state.config),
    presetId: typeof state.presetId === 'string' ? state.presetId : null,
  };
}

export function normalizeParserState(raw: unknown): SessionParserState {
  if (!raw || typeof raw !== 'object') return cloneParserState(DEFAULT_PARSER_STATE);
  const state = raw as Partial<SessionParserState>;
  if (!state.config || typeof state.config !== 'object') {
    return cloneParserState(DEFAULT_PARSER_STATE);
  }
  return cloneParserState({
    config: state.config as ParserConfig,
    presetId: typeof state.presetId === 'string' ? state.presetId : null,
  });
}

export function normalizePortConfig(raw: unknown): PortConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PORT_CONFIG };
  const cfg = raw as Partial<PortConfig>;
  return {
    baudRate:
      typeof cfg.baudRate === 'number' && Number.isFinite(cfg.baudRate)
        ? Math.max(1, Math.floor(cfg.baudRate))
        : DEFAULT_PORT_CONFIG.baudRate,
    dataBits: cfg.dataBits === 5 || cfg.dataBits === 6 || cfg.dataBits === 7 ? cfg.dataBits : 8,
    stopBits: cfg.stopBits === 2 ? 2 : 1,
    parity: cfg.parity === 'odd' || cfg.parity === 'even' ? cfg.parity : 'none',
    flowControl:
      cfg.flowControl === 'software' || cfg.flowControl === 'hardware' ? cfg.flowControl : 'none',
    rxFrameGapMs: normalizeRxFrameGapMs(cfg.rxFrameGapMs),
    dtr: cfg.dtr === true,
    rts: cfg.rts === true,
  };
}

export function createSessionRecord(
  id: string,
  portName: string,
  portConfig: PortConfig,
  overrides: Partial<SerialSession> = {},
): SerialSession {
  return {
    id,
    portName,
    portConfig,
    isConnected: false,
    frames: [],
    pausedFrames: [],
    capturePaused: false,
    txBytes: 0,
    rxBytes: 0,
    txFrames: 0,
    rxFrames: 0,
    droppedBytes: 0,
    startTime: null,
    sendHistory: [],
    sendDraft: '',
    quickCommands: [],
    macros: [],
    triggers: [],
    highlights: [],
    parserState: cloneParserState(DEFAULT_PARSER_STATE),
    modbusRegisters: [],
    modbusConfig: { ...DEFAULT_MODBUS_CONFIG },
    waveformSourceMode: 'text',
    autoLogEnabled: false,
    logPath: null,
    terminalAiModel: 'glm-4.5-air',
    logAiModel: 'glm-4.5-air',
    logAiContextMode: 'latest-10k',
    logAiFrameLimit: 200,
    logAiMessages: [],
    ...overrides,
  };
}

export function countFrameTotals(frames: DataFrame[]) {
  let txBytes = 0;
  let rxBytes = 0;
  let txFrames = 0;
  let rxFrames = 0;
  for (const frame of frames) {
    if (frame.direction === 'TX') {
      txBytes += frame.data.length;
      txFrames += 1;
    } else {
      rxBytes += frame.data.length;
      rxFrames += 1;
    }
  }
  return { txBytes, rxBytes, txFrames, rxFrames };
}

function persistedFrameTail(frames: DataFrame[]): DataFrame[] {
  const selected: DataFrame[] = [];
  let bytes = 0;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (selected.length >= MAX_PERSISTED_FRAMES_PER_SESSION) break;
    if (frame.data.length > MAX_PERSISTED_BYTES_PER_SESSION) continue;
    if (bytes + frame.data.length > MAX_PERSISTED_BYTES_PER_SESSION) {
      break;
    }
    selected.push(frame);
    bytes += frame.data.length;
  }
  return selected.reverse();
}

function serializeFrame(frame: DataFrame): PersistedFrame {
  return {
    id: frame.id,
    direction: frame.direction,
    timestamp: frame.timestamp,
    data: frame.data,
    ...(frame.txStatus ? { txStatus: frame.txStatus } : {}),
    ...(frame.requestedBytes !== undefined ? { requestedBytes: frame.requestedBytes } : {}),
  };
}

interface PersistedFrameCandidate {
  id: string | null;
  direction: Direction;
  timestamp: number | null;
  data: Uint8Array;
  txStatus?: DataFrame['txStatus'];
  requestedBytes?: number;
}

function deserializeFrameCandidate(raw: unknown): PersistedFrameCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const frame = raw as Partial<PersistedFrame> & { dataHex?: unknown };
  if (frame.direction !== 'TX' && frame.direction !== 'RX') return null;
  let data: Uint8Array;
  try {
    if (frame.data instanceof Uint8Array) {
      data = frame.data;
    } else if (typeof frame.dataHex === 'string') {
      if (frame.dataHex.length > MAX_PERSISTED_BYTES_PER_SESSION * 3) return null;
      data = parseHex(frame.dataHex);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (data.length > MAX_PERSISTED_BYTES_PER_SESSION) return null;
  const requestedBytes =
    typeof frame.requestedBytes === 'number' &&
    Number.isFinite(frame.requestedBytes) &&
    frame.requestedBytes >= data.length
      ? Math.floor(frame.requestedBytes)
      : undefined;
  return {
    id: typeof frame.id === 'string' ? frame.id : null,
    direction: frame.direction,
    timestamp:
      typeof frame.timestamp === 'number' && Number.isFinite(frame.timestamp)
        ? frame.timestamp
        : null,
    data,
    txStatus:
      frame.direction === 'TX' &&
      (frame.txStatus === 'complete' || frame.txStatus === 'partial-unknown')
        ? frame.txStatus
        : undefined,
    requestedBytes: frame.direction === 'TX' ? requestedBytes : undefined,
  };
}

function deserializeFrameTail(raw: unknown, options: SessionPersistenceOptions): DataFrame[] {
  if (!Array.isArray(raw)) return [];
  const selected: PersistedFrameCandidate[] = [];
  let bytes = 0;
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_PERSISTED_FRAMES_PER_SESSION) break;
    const frame = deserializeFrameCandidate(raw[index]);
    if (!frame) continue;
    if (bytes + frame.data.length > MAX_PERSISTED_BYTES_PER_SESSION) break;
    selected.push(frame);
    bytes += frame.data.length;
  }
  selected.reverse();
  return selected.map((frame) =>
    decorateFrame(
      {
        id: frame.id ?? createId(options),
        direction: frame.direction,
        timestamp: frame.timestamp ?? now(options),
        data: frame.data,
        ...(frame.txStatus ? { txStatus: frame.txStatus } : {}),
        ...(frame.requestedBytes !== undefined ? { requestedBytes: frame.requestedBytes } : {}),
      },
      options,
    ),
  );
}

function normalizeSendHistory(raw: unknown): SendHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is SendHistoryEntry =>
        item &&
        typeof item === 'object' &&
        typeof (item as SendHistoryEntry).data === 'string' &&
        typeof (item as SendHistoryEntry).isHex === 'boolean',
    )
    .slice(0, MAX_HISTORY);
}

function normalizeQuickCommands(
  raw: unknown,
  options: SessionPersistenceOptions,
): SerialSession['quickCommands'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is SerialSession['quickCommands'][number] =>
        item &&
        typeof item === 'object' &&
        typeof (item as SerialSession['quickCommands'][number]).name === 'string' &&
        typeof (item as SerialSession['quickCommands'][number]).data === 'string',
    )
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : createId(options),
      name: item.name.trim() || 'Command',
      data: item.data,
      isHex: item.isHex === true,
    }));
}

function normalizeMacros(raw: unknown, options: SessionPersistenceOptions): Macro[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Macro =>
        item &&
        typeof item === 'object' &&
        typeof (item as Macro).name === 'string' &&
        Array.isArray((item as Macro).steps),
    )
    .map((macro) => ({
      id: typeof macro.id === 'string' ? macro.id : createId(options),
      name: macro.name.trim() || 'Macro',
      steps: macro.steps
        .filter((step) => step && typeof step.data === 'string')
        .map((step) => ({
          data: step.data,
          isHex: step.isHex === true,
          delayMs:
            typeof step.delayMs === 'number' && Number.isFinite(step.delayMs)
              ? Math.max(0, Math.min(3_600_000, Math.floor(step.delayMs)))
              : 0,
        })),
    }))
    .filter((macro) => macro.steps.length > 0);
}

function normalizeTriggers(raw: unknown, options: SessionPersistenceOptions): Trigger[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Trigger =>
        item &&
        typeof item === 'object' &&
        typeof (item as Trigger).name === 'string' &&
        typeof (item as Trigger).pattern === 'string' &&
        typeof (item as Trigger).response === 'string',
    )
    .map((trigger) => ({
      id: typeof trigger.id === 'string' ? trigger.id : createId(options),
      name: trigger.name.trim() || 'Trigger',
      enabled: trigger.enabled === true,
      matchMode: trigger.matchMode === 'hex' ? 'hex' : 'text',
      pattern: trigger.pattern,
      response: trigger.response,
      responseIsHex: trigger.responseIsHex === true,
      cooldownMs:
        typeof trigger.cooldownMs === 'number' && Number.isFinite(trigger.cooldownMs)
          ? Math.max(0, Math.min(60_000, Math.floor(trigger.cooldownMs)))
          : 500,
    }));
}

function normalizeHighlightDirection(raw: unknown): DirectionFilter {
  return raw === 'TX' || raw === 'RX' ? raw : 'ALL';
}

function normalizeHighlightMatchMode(raw: unknown): HighlightMatchMode {
  return raw === 'hex' ? 'hex' : 'text';
}

function normalizeHighlightColor(raw: unknown): HighlightColor {
  return raw === 'red' || raw === 'blue' || raw === 'green' || raw === 'violet' ? raw : 'amber';
}

function normalizeHighlights(raw: unknown, options: SessionPersistenceOptions): HighlightRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is HighlightRule =>
        item &&
        typeof item === 'object' &&
        typeof (item as HighlightRule).name === 'string' &&
        typeof (item as HighlightRule).pattern === 'string',
    )
    .map((highlight) => ({
      id: typeof highlight.id === 'string' ? highlight.id : createId(options),
      name: highlight.name.trim() || 'Highlight',
      enabled: highlight.enabled !== false,
      matchMode: normalizeHighlightMatchMode(highlight.matchMode),
      pattern: highlight.pattern,
      direction: normalizeHighlightDirection(highlight.direction),
      color: normalizeHighlightColor(highlight.color),
    }))
    .filter((highlight) => highlight.pattern.trim().length > 0);
}

function normalizeAiModel(raw: unknown): AiModel {
  return raw === 'glm-5.1' || raw === 'glm-5-turbo' || raw === 'glm-4.7' || raw === 'glm-4.5-air'
    ? raw
    : 'glm-4.5-air';
}

function normalizeLogContextMode(raw: unknown): LogAiContextMode {
  return raw === 'latest-n-frames' || raw === 'full-capped' ? raw : 'latest-10k';
}

function normalizeWaveformSourceMode(raw: unknown): WaveformSourceMode {
  return raw === 'register' ? 'register' : 'text';
}

export function hydrateSession(
  raw: unknown,
  options: SessionPersistenceOptions = {},
): SerialSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const saved = raw as Partial<PersistedSession>;
  if (typeof saved.portName !== 'string' || saved.portName.length === 0) return null;

  const frames = deserializeFrameTail(saved.frames, options);
  const totals = countFrameTotals(frames);
  return createSessionRecord(
    typeof saved.id === 'string' ? saved.id : createId(options),
    saved.portName,
    normalizePortConfig(saved.portConfig),
    {
      frames,
      ...totals,
      sendHistory: normalizeSendHistory(saved.sendHistory),
      sendDraft: typeof saved.sendDraft === 'string' ? saved.sendDraft : '',
      quickCommands: normalizeQuickCommands(saved.quickCommands, options),
      macros: normalizeMacros(saved.macros, options),
      triggers: normalizeTriggers(saved.triggers, options),
      highlights: normalizeHighlights(saved.highlights, options),
      parserState: normalizeParserState(saved.parserState),
      modbusRegisters: normalizeModbusRegisters(saved.modbusRegisters),
      modbusConfig: normalizeModbusConfig(saved.modbusConfig),
      waveformSourceMode: normalizeWaveformSourceMode(saved.waveformSourceMode),
      terminalAiModel: normalizeAiModel(saved.terminalAiModel),
      logAiModel: normalizeAiModel(saved.logAiModel),
      logAiContextMode: normalizeLogContextMode(saved.logAiContextMode),
      logAiFrameLimit:
        typeof saved.logAiFrameLimit === 'number' && Number.isFinite(saved.logAiFrameLimit)
          ? Math.max(20, Math.min(2_000, Math.floor(saved.logAiFrameLimit)))
          : 200,
    },
  );
}

export function serializeSessionSnapshots(
  sessions: SerialSession[],
  activeSessionId: string | null,
  options: { mruSessionIds?: readonly string[]; includeFrames?: boolean } = {},
): PersistedSessionsFile {
  const mruSessionIds = normalizePersistedMruSessionIds(
    sessions,
    activeSessionId,
    options.mruSessionIds,
  );
  const frameSessionIds = new Set(options.includeFrames === false ? [] : mruSessionIds);
  return {
    version: SESSION_STORAGE_VERSION,
    activeSessionId,
    mruSessionIds,
    sessions: sessions.map((session) => {
      const frames = frameSessionIds.has(session.id)
        ? persistedFrameTail([...session.frames, ...session.pausedFrames])
        : [];
      return {
        id: session.id,
        portName: session.portName,
        portConfig: session.portConfig,
        frames: frames.map(serializeFrame),
        sendHistory: session.sendHistory.slice(0, MAX_HISTORY),
        sendDraft: session.sendDraft,
        quickCommands: session.quickCommands,
        macros: session.macros,
        triggers: session.triggers,
        highlights: session.highlights,
        parserState: cloneParserState(session.parserState),
        modbusRegisters: persistableModbusRegisters(session.modbusRegisters),
        modbusConfig: cloneModbusConfig(session.modbusConfig),
        waveformSourceMode: session.waveformSourceMode,
        terminalAiModel: session.terminalAiModel,
        logAiModel: session.logAiModel,
        logAiContextMode: session.logAiContextMode,
        logAiFrameLimit: session.logAiFrameLimit,
      };
    }),
  };
}

/**
 * Compatibility encoder used only when Worker/IndexedDB is unavailable. v2
 * IndexedDB stores structured-cloned Uint8Array payloads; the legacy fallback
 * remains JSON-safe so older/browser-test environments can still recover it.
 */
export function sessionSnapshotsForLocalStorage(file: PersistedSessionsFile): unknown {
  return {
    ...file,
    sessions: file.sessions.map((session) => ({
      ...session,
      frames: session.frames.map((frame) => ({
        id: frame.id,
        direction: frame.direction,
        timestamp: frame.timestamp,
        dataHex: toContinuousHex(frame.data),
        ...(frame.txStatus ? { txStatus: frame.txStatus } : {}),
        ...(frame.requestedBytes !== undefined ? { requestedBytes: frame.requestedBytes } : {}),
      })),
    })),
  };
}
