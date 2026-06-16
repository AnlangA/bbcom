import { defineStore } from 'pinia';
import { computed, markRaw, ref } from 'vue';
import type {
  AiChatMessage,
  AiModel,
  DataFrame,
  Direction,
  DirectionFilter,
  HighlightColor,
  HighlightMatchMode,
  HighlightRule,
  LogAiContextMode,
  Macro,
  ModbusFunctionCode,
  ModbusMasterConfig,
  ModbusRegister,
  ModbusValueType,
  PortConfig,
  SendHistoryEntry,
  SessionParserState,
  SerialSession,
  Trigger,
  WaveformSourceMode,
} from '../types';
import type { ParserConfig } from '../lib/protocol-parser';
import { MAX_HISTORY } from '../types';
import { maxBufferFrames } from '../lib/buffer-config';
import { nowMillis } from '../lib/time';
import { parseHex, toContinuousHex } from '../lib/format';
import { MODBUS_LIMITS, isReadFc, maxValueCountForRegisters } from '../lib/modbus';
import { isLocalStorageAvailable, loadJson, saveJson } from '../lib/storage';

const FRAME_TRIM_THRESHOLD = 500;
const STORAGE_KEY = 'bbcom-session-snapshots';
const STORAGE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 800;
const PERSIST_MAX_WAIT_MS = 2_500;
const MAX_PERSISTED_SESSIONS = 8;
const MAX_PERSISTED_FRAMES_PER_SESSION = 2_000;
const MAX_PERSISTED_BYTES_PER_SESSION = 1_000_000;

const DEFAULT_PORT_CONFIG: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  dtr: false,
  rts: false,
};

const DEFAULT_PARSER_STATE: SessionParserState = {
  config: {
    kind: 'delimiter',
    delimiter: [0x0d, 0x0a],
    includeDelimiter: false,
  },
  presetId: 'at-crlf',
};

const DEFAULT_MODBUS_CONFIG: ModbusMasterConfig = {
  transport: 'rtu',
  enabled: false,
  pollIntervalMs: 1000,
  writeIntervalMs: 1000,
  timeoutMs: 500,
};

const MODBUS_VALUE_TYPES: ReadonlySet<ModbusValueType> = new Set([
  'bool',
  'uint8',
  'int8',
  'uint16',
  'int16',
  'uint32-be',
  'int32-be',
  'float32-be',
  'uint32-le',
  'int32-le',
  'float32-le',
]);

const MODBUS_FUNCTION_CODES: ReadonlySet<ModbusFunctionCode> = new Set([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x10,
]);

interface PersistedFrame {
  id: string;
  direction: Direction;
  timestamp: number;
  dataHex: string;
}

interface PersistedSession {
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

interface PersistedSessionsFile {
  version: number;
  activeSessionId: string | null;
  sessions: PersistedSession[];
}

function cloneParserConfig(config: ParserConfig): ParserConfig {
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
        : [0x0d, 0x0a],
      includeDelimiter: config.includeDelimiter === true,
    };
  }
  return cloneParserConfig(DEFAULT_PARSER_STATE.config);
}

function cloneParserState(state: SessionParserState): SessionParserState {
  return {
    config: cloneParserConfig(state.config),
    presetId: typeof state.presetId === 'string' ? state.presetId : null,
  };
}

function normalizeParserState(raw: unknown): SessionParserState {
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

function normalizePortConfig(raw: unknown): PortConfig {
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
    dtr: cfg.dtr === true,
    rts: cfg.rts === true,
  };
}

function createSessionRecord(
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

function countFrameTotals(frames: DataFrame[]) {
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
    if (selected.length > 0 && bytes + frame.data.length > MAX_PERSISTED_BYTES_PER_SESSION) {
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
    dataHex: toContinuousHex(frame.data),
  };
}

function deserializeFrame(raw: unknown): DataFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const frame = raw as Partial<PersistedFrame>;
  if (frame.direction !== 'TX' && frame.direction !== 'RX') return null;
  if (typeof frame.dataHex !== 'string') return null;
  try {
    return markRaw({
      id: typeof frame.id === 'string' ? frame.id : crypto.randomUUID(),
      direction: frame.direction,
      timestamp:
        typeof frame.timestamp === 'number' && Number.isFinite(frame.timestamp)
          ? frame.timestamp
          : nowMillis(),
      data: parseHex(frame.dataHex),
    });
  } catch {
    return null;
  }
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

function normalizeQuickCommands(raw: unknown): SerialSession['quickCommands'] {
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
      id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
      name: item.name.trim() || 'Command',
      data: item.data,
      isHex: item.isHex === true,
    }));
}

function normalizeMacros(raw: unknown): Macro[] {
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
      id: typeof macro.id === 'string' ? macro.id : crypto.randomUUID(),
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

function normalizeTriggers(raw: unknown): Trigger[] {
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
      id: typeof trigger.id === 'string' ? trigger.id : crypto.randomUUID(),
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

function normalizeHighlights(raw: unknown): HighlightRule[] {
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
      id: typeof highlight.id === 'string' ? highlight.id : crypto.randomUUID(),
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

/** Validate a Modbus FC into the supported family, else default to read-holding (03). */
function normalizeModbusFc(raw: unknown): ModbusFunctionCode {
  return MODBUS_FUNCTION_CODES.has(raw as ModbusFunctionCode) ? (raw as ModbusFunctionCode) : 0x03;
}

/** Validate a value-type string into the supported set, else default to uint16. */
function normalizeModbusType(raw: unknown): ModbusValueType {
  return MODBUS_VALUE_TYPES.has(raw as ModbusValueType) ? (raw as ModbusValueType) : 'uint16';
}

function normalizeModbusQuantity(
  raw: unknown,
  fc: ModbusFunctionCode,
  type: ModbusValueType,
): number {
  const min = 1;
  const max =
    fc === 0x01 || fc === 0x02
      ? MODBUS_LIMITS.readBits
      : fc === 0x03 || fc === 0x04
        ? maxValueCountForRegisters(type, MODBUS_LIMITS.readRegisters)
        : fc === 0x10
          ? maxValueCountForRegisters(type, MODBUS_LIMITS.writeRegisters)
          : min;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : min;
  return Math.max(min, Math.min(max, n));
}

function normalizeModbusValues(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const values = raw.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return values.length > 0 ? values : null;
}

function normalizeModbusRegisterRecord(raw: Partial<ModbusRegister>): ModbusRegister {
  const fc = normalizeModbusFc(raw.functionCode);
  const type = normalizeModbusType(raw.type);
  const isWriteFc = fc === 0x05 || fc === 0x06 || fc === 0x10;
  return {
    id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
    name: typeof raw.name === 'string' ? raw.name : 'Register',
    slaveAddress:
      typeof raw.slaveAddress === 'number' && Number.isFinite(raw.slaveAddress)
        ? Math.max(0, Math.min(247, Math.floor(raw.slaveAddress)))
        : 1,
    functionCode: fc,
    address:
      typeof raw.address === 'number' && Number.isFinite(raw.address)
        ? Math.max(0, Math.min(0xffff, Math.floor(raw.address)))
        : 0,
    quantity: normalizeModbusQuantity(raw.quantity, fc, type),
    type,
    unit: typeof raw.unit === 'string' && raw.unit.length > 0 ? raw.unit : undefined,
    waveformChannel:
      typeof raw.waveformChannel === 'number' &&
      Number.isInteger(raw.waveformChannel) &&
      raw.waveformChannel >= 0 &&
      raw.waveformChannel <= 7
        ? raw.waveformChannel
        : null,
    value: typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : null,
    values: normalizeModbusValues(raw.values),
    valueTs: typeof raw.valueTs === 'number' && Number.isFinite(raw.valueTs) ? raw.valueTs : null,
    periodicRead: isReadFc(fc) ? raw.periodicRead !== false : false,
    periodicWrite: isWriteFc ? raw.periodicWrite === true : false,
  };
}

/**
 * Hydrate the register table from persisted storage. Runtime-only fields
 * (value/valueTs) are dropped — a reloaded session starts with no live values
 * until the master polls again. The same normalizer covers the snapshot import
 * path (which DOES carry values), so values are preserved when present.
 */
function normalizeModbusRegisters(raw: unknown): ModbusRegister[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((reg) => normalizeModbusRegisterRecord(reg as Partial<ModbusRegister>));
}

function cloneModbusConfig(cfg: ModbusMasterConfig): ModbusMasterConfig {
  return {
    transport: cfg.transport === 'pdu' ? 'pdu' : 'rtu',
    enabled: cfg.enabled === true,
    pollIntervalMs: Math.max(100, Math.min(10_000, Math.floor(cfg.pollIntervalMs || 1000))),
    writeIntervalMs: Math.max(100, Math.min(10_000, Math.floor(cfg.writeIntervalMs || 1000))),
    timeoutMs: Math.max(50, Math.min(5_000, Math.floor(cfg.timeoutMs || 500))),
  };
}

function normalizeModbusConfig(raw: unknown): ModbusMasterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MODBUS_CONFIG };
  const cfg = raw as Partial<ModbusMasterConfig>;
  return cloneModbusConfig({
    transport: cfg.transport === 'pdu' ? 'pdu' : 'rtu',
    enabled: cfg.enabled === true,
    pollIntervalMs:
      typeof cfg.pollIntervalMs === 'number' && Number.isFinite(cfg.pollIntervalMs)
        ? cfg.pollIntervalMs
        : 1000,
    writeIntervalMs:
      typeof cfg.writeIntervalMs === 'number' && Number.isFinite(cfg.writeIntervalMs)
        ? cfg.writeIntervalMs
        : 1000,
    timeoutMs:
      typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 500,
  });
}

function normalizeWaveformSourceMode(raw: unknown): WaveformSourceMode {
  return raw === 'register' ? 'register' : 'text';
}

/** Strip runtime-only value/valueTs before persisting (they are not restored). */
function persistableModbusRegisters(regs: ModbusRegister[]): ModbusRegister[] {
  return regs.map((reg) => ({
    id: reg.id,
    name: reg.name,
    slaveAddress: reg.slaveAddress,
    functionCode: reg.functionCode,
    address: reg.address,
    quantity: normalizeModbusQuantity(reg.quantity, reg.functionCode, reg.type),
    type: reg.type,
    unit: reg.unit,
    waveformChannel: reg.waveformChannel,
    periodicRead: reg.periodicRead,
    periodicWrite: reg.periodicWrite,
    value: null,
    values: null,
    valueTs: null,
  }));
}

export const useSessionStore = defineStore('sessions', () => {
  const sessions = ref<SerialSession[]>([]);
  const activeSessionId = ref<string | null>(null);
  const cleanupFns = new Map<string, () => Promise<void>>();
  let loaded = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let firstDirtyAt = 0;

  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null,
  );

  function loadPersistedSessions() {
    const saved = loadJson<PersistedSessionsFile>(STORAGE_KEY, {
      version: STORAGE_VERSION,
      activeSessionId: null,
      sessions: [],
    });
    if (!Array.isArray(saved.sessions)) {
      loaded = true;
      return;
    }

    const restored = saved.sessions
      .slice(0, MAX_PERSISTED_SESSIONS)
      .map(hydrateSession)
      .filter((s): s is SerialSession => s !== null);
    sessions.value = restored;
    activeSessionId.value =
      typeof saved.activeSessionId === 'string' &&
      restored.some((session) => session.id === saved.activeSessionId)
        ? saved.activeSessionId
        : (restored[0]?.id ?? null);
    loaded = true;
  }

  function hydrateSession(raw: unknown): SerialSession | null {
    if (!raw || typeof raw !== 'object') return null;
    const saved = raw as Partial<PersistedSession>;
    if (typeof saved.portName !== 'string' || saved.portName.length === 0) return null;

    const frames = Array.isArray(saved.frames)
      ? saved.frames.map(deserializeFrame).filter((f): f is DataFrame => f !== null)
      : [];
    const totals = countFrameTotals(frames);
    return createSessionRecord(
      typeof saved.id === 'string' ? saved.id : crypto.randomUUID(),
      saved.portName,
      normalizePortConfig(saved.portConfig),
      {
        frames,
        ...totals,
        sendHistory: normalizeSendHistory(saved.sendHistory),
        sendDraft: typeof saved.sendDraft === 'string' ? saved.sendDraft : '',
        quickCommands: normalizeQuickCommands(saved.quickCommands),
        macros: normalizeMacros(saved.macros),
        triggers: normalizeTriggers(saved.triggers),
        highlights: normalizeHighlights(saved.highlights),
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

  function serializeSessions(): PersistedSessionsFile {
    return {
      version: STORAGE_VERSION,
      activeSessionId: activeSessionId.value,
      sessions: sessions.value.slice(0, MAX_PERSISTED_SESSIONS).map((session) => {
        const frames = persistedFrameTail([...session.frames, ...session.pausedFrames]);
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

  function flushPersistedSessions() {
    if (!loaded) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    firstDirtyAt = 0;
    saveJson(STORAGE_KEY, serializeSessions());
  }

  function schedulePersist() {
    if (!loaded || !isLocalStorageAvailable()) return;
    const now = nowMillis();
    if (firstDirtyAt === 0) firstDirtyAt = now;
    if (saveTimer) clearTimeout(saveTimer);
    const elapsed = now - firstDirtyAt;
    const delay = elapsed >= PERSIST_MAX_WAIT_MS ? 0 : PERSIST_DEBOUNCE_MS;
    saveTimer = setTimeout(flushPersistedSessions, delay);
  }

  function createSession(portName: string, portConfig: SerialSession['portConfig']): string {
    const id = crypto.randomUUID();
    sessions.value.push(createSessionRecord(id, portName, portConfig));
    activeSessionId.value = id;
    schedulePersist();
    return id;
  }

  async function removeSession(id: string) {
    const cleanup = cleanupFns.get(id);
    if (cleanup) {
      cleanupFns.delete(id);
      await cleanup();
    }
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0]?.id ?? null;
    }
    schedulePersist();
  }

  function setActiveSession(id: string) {
    activeSessionId.value = id;
    schedulePersist();
  }

  function registerCleanup(id: string, fn: () => Promise<void>) {
    cleanupFns.set(id, fn);
  }

  function addFrame(
    sessionId: string,
    frame: Omit<DataFrame, 'id' | 'timestamp'>,
  ): DataFrame | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;

    // Frames are immutable after creation; markRaw opts them (and their
    // Uint8Array payload) out of deep reactivity, so Vue never builds per-byte
    // proxy traps across up to maxBufferFrames entries — the dominant cost at
    // high baud rates. The arrays themselves stay reactive (length changes
    // still trigger updates); only the element contents are raw.
    const fullFrame: DataFrame = markRaw({
      ...frame,
      id: crypto.randomUUID(),
      timestamp: nowMillis(),
    });

    // While capture is paused, hold frames off-screen so the live view freezes
    // without losing data; resuming flushes them back in order.
    const max = maxBufferFrames.value;
    const target = session.capturePaused ? session.pausedFrames : session.frames;
    target.push(fullFrame);
    if (target.length > max + FRAME_TRIM_THRESHOLD) {
      target.splice(0, target.length - max);
    }

    if (frame.direction === 'TX') {
      session.txBytes += frame.data.length;
      session.txFrames += 1;
    } else {
      session.rxBytes += frame.data.length;
      session.rxFrames += 1;
    }

    schedulePersist();
    return fullFrame;
  }

  function setConnected(sessionId: string, connected: boolean) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.isConnected = connected;
    if (connected) {
      if (!session.startTime) session.startTime = nowMillis();
    } else {
      // Reset so the StatusBar duration reflects the active connection and
      // does not accumulate offline time across reconnects.
      session.startTime = null;
    }
    schedulePersist();
  }

  function clearFrames(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.frames = [];
    session.pausedFrames = [];
    session.capturePaused = false;
    session.txBytes = 0;
    session.rxBytes = 0;
    session.txFrames = 0;
    session.rxFrames = 0;
    schedulePersist();
  }

  function setCapturePaused(sessionId: string, paused: boolean) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session || session.capturePaused === paused) return;
    session.capturePaused = paused;
    if (!paused && session.pausedFrames.length > 0) {
      // Flush the off-screen buffer back into the live view, preserving order.
      const max = maxBufferFrames.value;
      for (const held of session.pausedFrames) session.frames.push(held);
      session.pausedFrames = [];
      if (session.frames.length > max + FRAME_TRIM_THRESHOLD) {
        session.frames.splice(0, session.frames.length - max);
      }
    }
    schedulePersist();
  }

  function addSendHistory(sessionId: string, entry: SendHistoryEntry) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendHistory = session.sendHistory.filter(
      (h) => !(h.data === entry.data && h.isHex === entry.isHex),
    );
    session.sendHistory.unshift(entry);
    if (session.sendHistory.length > MAX_HISTORY) {
      session.sendHistory = session.sendHistory.slice(0, MAX_HISTORY);
    }
    schedulePersist();
  }

  function clearSendHistory(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendHistory = [];
    schedulePersist();
  }

  function setSendDraft(sessionId: string, draft: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.sendDraft = draft;
    schedulePersist();
  }

  function addQuickCommand(
    sessionId: string,
    command: Omit<SerialSession['quickCommands'][number], 'id'>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.quickCommands.push({ ...command, id: crypto.randomUUID() });
    schedulePersist();
  }

  function removeQuickCommand(sessionId: string, commandId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.quickCommands = session.quickCommands.filter((c) => c.id !== commandId);
    schedulePersist();
  }

  function addMacro(sessionId: string, macro: Omit<Macro, 'id'>): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const id = crypto.randomUUID();
    session.macros.push({ ...macro, id });
    schedulePersist();
    return id;
  }

  function updateMacro(sessionId: string, macroId: string, patch: Partial<Omit<Macro, 'id'>>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const idx = session.macros.findIndex((m) => m.id === macroId);
    if (idx === -1) return;
    session.macros[idx] = { ...session.macros[idx], ...patch };
    schedulePersist();
  }

  function removeMacro(sessionId: string, macroId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.macros = session.macros.filter((m) => m.id !== macroId);
    schedulePersist();
  }

  function addTrigger(sessionId: string, trigger: Omit<Trigger, 'id'>): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const id = crypto.randomUUID();
    session.triggers.push({ ...trigger, id });
    schedulePersist();
    return id;
  }

  function updateTrigger(
    sessionId: string,
    triggerId: string,
    patch: Partial<Omit<Trigger, 'id'>>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const idx = session.triggers.findIndex((t) => t.id === triggerId);
    if (idx === -1) return;
    session.triggers[idx] = { ...session.triggers[idx], ...patch };
    schedulePersist();
  }

  function removeTrigger(sessionId: string, triggerId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.triggers = session.triggers.filter((t) => t.id !== triggerId);
    schedulePersist();
  }

  function addHighlight(
    sessionId: string,
    highlight: Omit<HighlightRule, 'id'>,
  ): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const id = crypto.randomUUID();
    session.highlights.push({ ...highlight, id });
    schedulePersist();
    return id;
  }

  function updateHighlight(
    sessionId: string,
    highlightId: string,
    patch: Partial<Omit<HighlightRule, 'id'>>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const idx = session.highlights.findIndex((h) => h.id === highlightId);
    if (idx === -1) return;
    session.highlights[idx] = { ...session.highlights[idx], ...patch };
    schedulePersist();
  }

  function removeHighlight(sessionId: string, highlightId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.highlights = session.highlights.filter((h) => h.id !== highlightId);
    schedulePersist();
  }

  function setParserState(sessionId: string, config: ParserConfig, presetId?: string | null) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.parserState = {
      config: cloneParserConfig(config),
      presetId: presetId === undefined ? session.parserState.presetId : presetId,
    };
    schedulePersist();
  }

  function addModbusRegister(
    sessionId: string,
    reg: Omit<ModbusRegister, 'id' | 'value' | 'values' | 'valueTs'>,
  ): string | undefined {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return undefined;
    const id = crypto.randomUUID();
    session.modbusRegisters.push(
      normalizeModbusRegisterRecord({ ...reg, id, value: null, values: null, valueTs: null }),
    );
    schedulePersist();
    return id;
  }

  function updateModbusRegister(
    sessionId: string,
    regId: string,
    patch: Partial<Omit<ModbusRegister, 'id'>>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    const idx = session.modbusRegisters.findIndex((r) => r.id === regId);
    if (idx === -1) return;
    session.modbusRegisters[idx] = normalizeModbusRegisterRecord({
      ...session.modbusRegisters[idx],
      ...patch,
      id: session.modbusRegisters[idx].id,
    });
    schedulePersist();
  }

  function removeModbusRegister(sessionId: string, regId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.modbusRegisters = session.modbusRegisters.filter((r) => r.id !== regId);
    schedulePersist();
  }

  /**
   * Bulk-replace the register table. Used by "load .bbreg" snapshot import and
   * by tests. Skips persistence when the caller is only updating runtime values
   * (value/valueTs) via {@link setModbusRegisterValues}.
   */
  function setModbusRegisters(sessionId: string, regs: ModbusRegister[]) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.modbusRegisters = normalizeModbusRegisters(regs);
    schedulePersist();
  }

  /**
   * Apply a batch of decoded values to the register table (keyed by row id) as a
   * single reactive write — the poll loop calls this once per tick with every
   * register it read, so the table repaints once instead of per-register.
   * Runtime-only → does not schedule persistence.
   */
  function setModbusRegisterValues(
    sessionId: string,
    values: Array<{ id: string; value: number; values?: number[] | null; valueTs: number }>,
  ) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    if (values.length === 0) return;
    const byId = new Map(values.map((v) => [v.id, v]));
    // Build a fresh array so Vue detects the change in one shot.
    session.modbusRegisters = session.modbusRegisters.map((reg) => {
      const hit = byId.get(reg.id);
      if (!hit) return reg;
      return {
        ...reg,
        value: hit.value,
        values: hit.values === undefined ? reg.values : hit.values,
        valueTs: hit.valueTs,
      };
    });
  }

  function setModbusConfig(sessionId: string, patch: Partial<ModbusMasterConfig>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.modbusConfig = cloneModbusConfig({ ...session.modbusConfig, ...patch });
    schedulePersist();
  }

  function setWaveformSourceMode(sessionId: string, mode: WaveformSourceMode) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.waveformSourceMode = mode;
    schedulePersist();
  }

  /** Enable auto-logging to `path`, or disable it when `path` is null. Sets
   * logPath and autoLogEnabled together so they can never disagree. */
  function setAutoLogTarget(sessionId: string, path: string | null) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logPath = path;
    session.autoLogEnabled = path !== null;
    schedulePersist();
  }

  function setTerminalAiModel(sessionId: string, model: AiModel) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.terminalAiModel = model;
    schedulePersist();
  }

  function setLogAiModel(sessionId: string, model: AiModel) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiModel = model;
    schedulePersist();
  }

  function setLogAiContextMode(sessionId: string, mode: LogAiContextMode) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiContextMode = mode;
    schedulePersist();
  }

  function setLogAiFrameLimit(sessionId: string, limit: number) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiFrameLimit = Math.max(20, Math.min(2000, Math.floor(limit || 200)));
    schedulePersist();
  }

  function addLogAiMessage(sessionId: string, message: Omit<AiChatMessage, 'id' | 'timestamp'>) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiMessages.push(
      markRaw({
        ...message,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      }),
    );
    schedulePersist();
  }

  function clearLogAiMessages(sessionId: string) {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.logAiMessages = [];
    schedulePersist();
  }

  function reorderSessions(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= sessions.value.length) return;
    if (toIndex < 0 || toIndex >= sessions.value.length) return;
    const [moved] = sessions.value.splice(fromIndex, 1);
    sessions.value.splice(toIndex, 0, moved);
    schedulePersist();
  }

  loadPersistedSessions();

  return {
    sessions,
    activeSessionId,
    activeSession,
    createSession,
    removeSession,
    setActiveSession,
    registerCleanup,
    addFrame,
    setConnected,
    clearFrames,
    setCapturePaused,
    addSendHistory,
    clearSendHistory,
    setSendDraft,
    addQuickCommand,
    removeQuickCommand,
    addMacro,
    updateMacro,
    removeMacro,
    addTrigger,
    updateTrigger,
    removeTrigger,
    addHighlight,
    updateHighlight,
    removeHighlight,
    setParserState,
    addModbusRegister,
    updateModbusRegister,
    removeModbusRegister,
    setModbusRegisters,
    setModbusRegisterValues,
    setModbusConfig,
    setWaveformSourceMode,
    setAutoLogTarget,
    setTerminalAiModel,
    setLogAiModel,
    setLogAiContextMode,
    setLogAiFrameLimit,
    addLogAiMessage,
    clearLogAiMessages,
    reorderSessions,
    flushPersistedSessions,
  };
});
