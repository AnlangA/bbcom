import type {
  WorkspaceAiMessage,
  WorkspaceHydratedFrame,
  WorkspaceMutation,
  WorkspacePortHint,
  WorkspaceSessionKind,
  WorkspaceSessionSnapshot,
  WorkspaceSessionCollectionsPayload,
  WorkspaceWaveformChannel,
  WorkspaceWaveformSample,
} from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import { AI_MODEL_IDS, isValidAiModel } from '@/lib/ai-models';
import {
  cloneParserState,
  countFrameTotals,
  createSessionRecord,
  normalizeParserState,
  normalizePortConfig,
} from '@/lib/session-persistence';
import { cloneModbusConfig, normalizeModbusConfig } from '@/lib/modbus';
import {
  DEFAULT_SERIAL_SHELL_CONFIG,
  cloneSerialShellConfig,
  normalizeSerialShellConfig,
} from '@/lib/serial-shell';
import {
  DEFAULT_MCUMGR_CONFIG,
  MCUMGR_CONFIG_KEYS,
  cloneMcumgrConfig,
  normalizeMcumgrConfig,
  persistableMcumgrConfig,
  validateMcumgrConfig,
} from '@/lib/mcumgr-config';
import type { SerialSession, SessionWaveformFrameCursor } from '@/types';
import {
  WorkspaceAdapterLimitError,
  WorkspaceAdapterValidationError,
} from './workspace-adapter-errors';
import {
  assertSafeWorkspaceValue,
  validateOpaqueText,
  validateSafeText,
  validateWorkspaceIdentifier,
} from './workspace-adapter-security';
import { hydrateWorkspaceFrame } from './workspace-frame-adapter';
import {
  chunkAiMessages,
  hydrateAiMessages,
  hydrateCollections,
  projectAiMessages,
  projectCollections,
} from './workspace-collections-projection';
import {
  WORKSPACE_SESSION_PROJECTION_VERSION,
  SERIAL_SHELL_CONFIG_KEYS,
  SERIAL_SHELL_LEGACY_CONFIG_KEYS,
  assertExactKeys,
  assertLimit,
  assertMutationSize,
  boundedInteger,
  canonicalJson,
  expectBoolean,
  expectString,
  expectVersion,
  isRecord,
  positiveInteger,
  validNonNegativeInteger,
  validUint32,
  validateModbusConfig,
  validateParserConfig,
  validateSerialShellConfig,
} from './workspace-validation';
import {
  chunkWaveformSamples,
  cloneWaveformPayload,
  hydrateWaveformPreferences,
  legacyWaveformFrameCursor,
  projectWaveformSamples,
  projectWorkspaceWaveformPreferences,
  type WorkspaceWaveformChannelProjection,
  type WorkspaceWaveformSampleProjection,
} from './workspace-waveform-projection';

// Public API pieces that moved into focused sibling modules are re-exported so
// every existing import site keeps working unchanged.
export { WORKSPACE_SESSION_PROJECTION_VERSION } from './workspace-validation';
export { projectWorkspaceWaveformPreferences } from './workspace-waveform-projection';
export type {
  WorkspaceWaveformChannelProjection,
  WorkspaceWaveformSampleProjection,
} from './workspace-waveform-projection';

export interface WorkspaceSessionProjectionOptions {
  readonly sequenceStart: number;
  readonly sortOrder: number;
  /** Safe display label, never a physical device path. */
  readonly name: string;
  readonly kind?: WorkspaceSessionKind;
  readonly lastPortHint?: WorkspacePortHint;
  /** Persist the runtime text-ingest position without rewriting waveform rows. */
  readonly waveformFrameCursor?: SessionWaveformFrameCursor;
  /** Display-only channel visibility, persisted without touching sample rows. */
  readonly waveformChannelVisibility?: readonly Readonly<{
    channelIndex: number;
    visible: boolean;
  }>[];
  readonly waveform?: {
    readonly channels: readonly WorkspaceWaveformChannelProjection[];
    readonly samples: readonly WorkspaceWaveformSampleProjection[];
    readonly frameCursor: SessionWaveformFrameCursor;
  };
}

export interface WorkspaceSessionMutationProjection {
  readonly mutations: readonly WorkspaceMutation[];
  readonly nextSequence: number;
}

export interface WorkspaceSessionHydrationParts {
  readonly frames: readonly WorkspaceHydratedFrame[];
  readonly collections: WorkspaceSessionCollectionsPayload;
  readonly aiMessages: readonly WorkspaceAiMessage[];
  readonly waveformChannels: readonly WorkspaceWaveformChannel[];
  readonly waveformSamples: readonly WorkspaceWaveformSample[];
}

export interface WorkspaceSessionRebindMetadata {
  readonly required: true;
  readonly displayName: string;
  readonly kind: WorkspaceSessionKind;
  readonly lastPortHint: WorkspacePortHint | null;
}

export interface HydratedWorkspaceSession {
  readonly session: SerialSession;
  readonly sortOrder: number;
  readonly rebind: WorkspaceSessionRebindMetadata;
  /** Durable waveform sidecar adopted by the session façade during replacement. */
  readonly waveform: {
    readonly channels: readonly WorkspaceWaveformChannel[];
    readonly samples: readonly WorkspaceWaveformSample[];
    readonly frameCursor: SessionWaveformFrameCursor;
  };
}

/**
 * Project every persistable SerialSession field into Rust-generated workspace
 * mutations. No connection, loop, auto-log, operation or authorization state
 * is accepted by this boundary.
 */
export function projectWorkspaceSessionMutations(
  session: SerialSession,
  options: WorkspaceSessionProjectionOptions,
): WorkspaceSessionMutationProjection {
  assertKnownSessionShape(session);
  const sessionId = validateWorkspaceIdentifier(session.id, 'session.id');
  const name = validateSafeText(options.name, 'session.name', { maxBytes: 256 });
  const sortOrder = validUint32(options.sortOrder, 'sortOrder');
  const kind = options.kind ?? 'live';
  if (kind !== 'live' && kind !== 'offline') {
    throw new WorkspaceAdapterValidationError('session.kind');
  }
  const lastPortHint = options.lastPortHint ? projectPortHint(options.lastPortHint) : undefined;
  let sequence = validUint32(options.sequenceStart, 'sequenceStart');

  const document = projectDocument(session);
  const preferences = projectPreferences(session);
  const parser = projectParser(session);
  const modbus = projectModbus(session);
  const waveform = projectWorkspaceWaveformPreferences(
    session,
    options.waveformFrameCursor ?? options.waveform?.frameCursor,
    options.waveformChannelVisibility ?? options.waveform?.channels,
  );
  const collections = projectCollections(session);
  const aiMessages = projectAiMessages(session.logAiMessages);
  const waveformRows = options.waveform ? projectWaveformSamples(options.waveform) : null;

  const mutations: WorkspaceMutation[] = [
    {
      kind: 'upsert-session',
      sequence: sequence++,
      sessionId,
      payload: {
        name,
        sortOrder,
        kind,
        ...(lastPortHint ? { lastPortHint } : {}),
        portConfig: projectPortConfig(session.portConfig),
        document,
      },
    },
    featureMutation(sequence++, sessionId, 'preferences', preferences),
    featureMutation(sequence++, sessionId, 'parser', parser),
    featureMutation(sequence++, sessionId, 'modbus', modbus),
    featureMutation(sequence++, sessionId, 'waveform', waveform),
    featureMutation(sequence++, sessionId, 'shell', projectShell(session)),
    featureMutation(sequence++, sessionId, 'mcumgr', projectMcumgr(session)),
    {
      kind: 'replace-session-collections',
      sequence: sequence++,
      sessionId,
      payload: collections,
    },
    { kind: 'clear-ai-messages', sequence: sequence++, sessionId },
  ];
  if (waveformRows) {
    mutations.push({
      kind: 'replace-waveform-channels',
      sequence: sequence++,
      sessionId,
      payload: waveformRows.channels,
    });
  }
  for (const payload of chunkAiMessages(aiMessages.messages)) {
    mutations.push({
      kind: 'append-ai-messages',
      sequence: sequence++,
      sessionId,
      payload,
    });
  }
  if (waveformRows) {
    for (const payload of chunkWaveformSamples(waveformRows.samples)) {
      mutations.push({
        kind: 'append-waveform-samples',
        sequence: sequence++,
        sessionId,
        payload,
      });
    }
  }

  if (mutations.length > IPC_LIMITS.MAX_WORKSPACE_MUTATIONS_PER_BATCH) {
    throw new WorkspaceAdapterLimitError(
      'mutations',
      IPC_LIMITS.MAX_WORKSPACE_MUTATIONS_PER_BATCH,
      mutations.length,
    );
  }
  if (sequence > 0x1_0000_0000)
    throw new WorkspaceAdapterLimitError('sequence', 0xffff_ffff, sequence);
  for (const mutation of mutations) {
    assertSafeWorkspaceValue(mutation, 'mutation', { rejectAbsolutePaths: false });
    assertMutationSize(mutation);
  }
  return Object.freeze({ mutations: Object.freeze(mutations), nextSequence: sequence });
}

/**
 * Hydrate one safe, stopped session aggregate. Required row payloads make it
 * impossible for a caller to silently omit collections or AI messages.
 */
export function hydrateWorkspaceSession(
  snapshot: WorkspaceSessionSnapshot,
  parts: WorkspaceSessionHydrationParts,
): HydratedWorkspaceSession {
  assertExactKeys(
    parts,
    ['frames', 'collections', 'aiMessages', 'waveformChannels', 'waveformSamples'],
    'parts',
  );
  assertSafeWorkspaceValue(snapshot, 'snapshot', { rejectAbsolutePaths: false });
  assertSafeWorkspaceValue(parts.collections, 'collections', { rejectAbsolutePaths: false });
  assertSafeWorkspaceValue(parts.aiMessages, 'aiMessages', { rejectAbsolutePaths: false });
  assertSafeWorkspaceValue(parts.waveformChannels, 'waveformChannels');
  assertSafeWorkspaceValue(parts.waveformSamples, 'waveformSamples');
  assertExactKeys(
    snapshot,
    [
      'id',
      'sortOrder',
      'kind',
      'name',
      'needsRebind',
      'lastPortHint',
      'portConfig',
      'document',
      'displayPreferences',
      'sendPreferences',
      'parserState',
      'featureState',
      'modbusConfig',
      'mcumgrConfig',
    ],
    'snapshot',
  );
  const id = validateWorkspaceIdentifier(snapshot.id, 'snapshot.id');
  const sortOrder = validUint32(snapshot.sortOrder, 'snapshot.sortOrder');
  if (snapshot.kind !== 'live' && snapshot.kind !== 'offline') {
    throw new WorkspaceAdapterValidationError('snapshot.kind');
  }
  if (snapshot.needsRebind !== true) {
    throw new WorkspaceAdapterValidationError('snapshot.needsRebind');
  }
  const name = validateSafeText(snapshot.name, 'snapshot.name', { maxBytes: 256 });
  const lastPortHint = snapshot.lastPortHint ? projectPortHint(snapshot.lastPortHint) : null;
  const portConfig = hydratePortConfig(snapshot.portConfig);
  const document = hydrateDocument(snapshot.document);
  const shellConfig = hydrateShell(snapshot.sendPreferences);
  const preferences = hydratePreferences(snapshot.featureState);
  const parserState = hydrateParser(snapshot.parserState);
  const modbusConfig = hydrateModbusConfig(snapshot.modbusConfig);
  const mcumgrConfig = hydrateMcumgrConfig(snapshot.mcumgrConfig);
  const waveformPreferences = hydrateWaveformPreferences(snapshot.displayPreferences);
  const collections = hydrateCollections(parts.collections);
  const logAiMessages = hydrateAiMessages(parts.aiMessages);
  if (!Array.isArray(parts.frames)) throw new WorkspaceAdapterValidationError('frames');
  let previousFrameSequence = -1;
  const frames = parts.frames.map((frame) => {
    const sequence = validNonNegativeInteger(frame.seq, 'frame.seq');
    if (sequence <= previousFrameSequence) {
      throw new WorkspaceAdapterValidationError('frame.seq');
    }
    previousFrameSequence = sequence;
    return hydrateWorkspaceFrame(frame);
  });
  assertLimit('workspaceFrames', IPC_LIMITS.MAX_WORKSPACE_FRAMES, frames.length);
  const frameBytes = frames.reduce((total, frame) => total + frame.data.byteLength, 0);
  assertLimit('workspaceCaptureBytes', IPC_LIMITS.MAX_WORKSPACE_CAPTURE_BYTES, frameBytes);
  const totals = countFrameTotals(frames);

  const session = createSessionRecord(id, '', portConfig, {
    frames,
    pausedFrames: [],
    capturePaused: false,
    ...totals,
    droppedBytes: 0,
    startTime: null,
    sendHistory: collections.sendHistory,
    sendDraft: document.sendDraft,
    quickCommands: collections.quickCommands,
    macros: collections.macros,
    triggers: collections.triggers,
    highlights: collections.highlights,
    parserState,
    modbusRegisters: collections.modbusRegisters,
    modbusConfig,
    shellConfig,
    mcumgrConfig,
    waveformSourceMode: waveformPreferences.sourceMode,
    autoLogEnabled: false,
    logPath: null,
    terminalAiModel: preferences.terminalAiModel,
    logAiModel: preferences.logAiModel,
    logAiContextMode: preferences.logAiContextMode,
    logAiFrameLimit: preferences.logAiFrameLimit,
    logAiMessages,
    isConnected: false,
  });

  return Object.freeze({
    session,
    sortOrder,
    rebind: Object.freeze({
      required: true,
      displayName: lastPortHint?.displayName ?? name,
      kind: snapshot.kind,
      lastPortHint,
    }),
    waveform: Object.freeze({
      ...cloneWaveformPayload(
        parts.waveformChannels.map((channel) => {
          const visible = waveformPreferences.channelVisibility.get(channel.channelIndex);
          return visible === undefined
            ? channel
            : { channelIndex: channel.channelIndex, config: { ...channel.config, visible } };
        }),
        parts.waveformSamples,
      ),
      frameCursor:
        waveformPreferences.frameCursor ??
        legacyWaveformFrameCursor(
          waveformPreferences.sourceMode,
          frames,
          parts.waveformSamples.length > 0,
        ),
    }),
  });
}

function featureMutation(
  sequence: number,
  entityId: string,
  feature: 'preferences' | 'parser' | 'modbus' | 'waveform' | 'shell' | 'mcumgr',
  state: Record<string, unknown>,
): WorkspaceMutation {
  return { kind: 'upsert-feature-state', sequence, entityId, payload: { feature, state } };
}

function projectDocument(session: SerialSession): Record<string, unknown> {
  return {
    schemaVersion: WORKSPACE_SESSION_PROJECTION_VERSION,
    sendDraft: validateOpaqueText(session.sendDraft, 'session.sendDraft', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
  };
}

function projectPreferences(session: SerialSession): Record<string, unknown> {
  if (!isValidAiModel(session.terminalAiModel) || !isValidAiModel(session.logAiModel)) {
    throw new WorkspaceAdapterValidationError('session.aiModel');
  }
  if (
    session.logAiContextMode !== 'latest-10k' &&
    session.logAiContextMode !== 'latest-n-frames' &&
    session.logAiContextMode !== 'full-capped'
  ) {
    throw new WorkspaceAdapterValidationError('session.logAiContextMode');
  }
  return {
    schemaVersion: WORKSPACE_SESSION_PROJECTION_VERSION,
    terminalAiModel: session.terminalAiModel,
    logAiModel: session.logAiModel,
    logAiContextMode: session.logAiContextMode,
    logAiFrameLimit: boundedInteger(session.logAiFrameLimit, 20, 2_000, 'session.logAiFrameLimit'),
  };
}

function projectParser(session: SerialSession): Record<string, unknown> {
  assertExactKeys(session.parserState, ['config', 'presetId'], 'session.parserState');
  if (!isRecord(session.parserState.config)) {
    throw new WorkspaceAdapterValidationError('session.parserState.config');
  }
  validateParserConfig(session.parserState.config);
  const parserState = cloneParserState(session.parserState);
  assertSafeWorkspaceValue(parserState, 'session.parserState');
  return { schemaVersion: WORKSPACE_SESSION_PROJECTION_VERSION, ...parserState };
}

function projectModbus(session: SerialSession): Record<string, unknown> {
  assertExactKeys(
    session.modbusConfig,
    ['transport', 'enabled', 'pollIntervalMs', 'writeIntervalMs', 'timeoutMs'],
    'session.modbusConfig',
  );
  validateModbusConfig(session.modbusConfig, 'session.modbusConfig');
  const config = cloneModbusConfig(session.modbusConfig);
  assertSafeWorkspaceValue(config, 'session.modbusConfig');
  return { schemaVersion: WORKSPACE_SESSION_PROJECTION_VERSION, ...config };
}

function projectShell(session: SerialSession): Record<string, unknown> {
  assertExactKeys(session.shellConfig, SERIAL_SHELL_CONFIG_KEYS, 'session.shellConfig');
  validateSerialShellConfig(session.shellConfig, 'session.shellConfig');
  const config = cloneSerialShellConfig(session.shellConfig);
  assertSafeWorkspaceValue(config, 'session.shellConfig');
  return { schemaVersion: WORKSPACE_SESSION_PROJECTION_VERSION, shell: config };
}

function projectMcumgr(session: SerialSession): Record<string, unknown> {
  assertExactKeys(session.mcumgrConfig, [...MCUMGR_CONFIG_KEYS], 'session.mcumgrConfig');
  validateMcumgrConfig(session.mcumgrConfig, 'session.mcumgrConfig');
  const config = persistableMcumgrConfig(session.mcumgrConfig);
  assertSafeWorkspaceValue(config, 'session.mcumgrConfig');
  return { schemaVersion: WORKSPACE_SESSION_PROJECTION_VERSION, ...config };
}

function projectPortConfig(config: SerialSession['portConfig']): Record<string, unknown> {
  assertExactKeys(
    config,
    ['baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl', 'rxFrameGapMs', 'dtr', 'rts'],
    'portConfig',
  );
  const projected = {
    baudRate: positiveInteger(config.baudRate, 'portConfig.baudRate'),
    dataBits: config.dataBits,
    stopBits: config.stopBits,
    parity: config.parity,
    flowControl: config.flowControl,
    rxFrameGapMs: positiveInteger(config.rxFrameGapMs, 'portConfig.rxFrameGapMs'),
    dtr: expectBoolean(config.dtr, 'portConfig.dtr'),
    rts: expectBoolean(config.rts, 'portConfig.rts'),
  };
  hydratePortConfig(projected);
  return projected;
}

function projectPortHint(hint: WorkspacePortHint): WorkspacePortHint {
  assertExactKeys(
    hint,
    [
      'displayName',
      'vendorId',
      'productId',
      'usbSerial',
      'manufacturer',
      'product',
      'interfaceType',
    ],
    'lastPortHint',
  );
  return {
    displayName: validateSafeText(hint.displayName, 'lastPortHint.displayName', { maxBytes: 256 }),
    ...(hint.vendorId !== undefined
      ? { vendorId: boundedInteger(hint.vendorId, 0, 0xffff, 'lastPortHint.vendorId') }
      : {}),
    ...(hint.productId !== undefined
      ? { productId: boundedInteger(hint.productId, 0, 0xffff, 'lastPortHint.productId') }
      : {}),
    ...(hint.usbSerial !== undefined
      ? { usbSerial: validateSafeText(hint.usbSerial, 'lastPortHint.usbSerial', { maxBytes: 256 }) }
      : {}),
    ...(hint.manufacturer !== undefined
      ? {
          manufacturer: validateSafeText(hint.manufacturer, 'lastPortHint.manufacturer', {
            maxBytes: 256,
          }),
        }
      : {}),
    ...(hint.product !== undefined
      ? { product: validateSafeText(hint.product, 'lastPortHint.product', { maxBytes: 256 }) }
      : {}),
    ...(hint.interfaceType !== undefined
      ? {
          interfaceType: validateSafeText(hint.interfaceType, 'lastPortHint.interfaceType', {
            maxBytes: 256,
          }),
        }
      : {}),
  };
}

function hydrateDocument(value: Record<string, unknown>): { sendDraft: string } {
  assertExactKeys(value, ['schemaVersion', 'sendDraft'], 'document');
  expectVersion(value.schemaVersion, 'document.schemaVersion');
  return {
    sendDraft: validateOpaqueText(value.sendDraft, 'document.sendDraft', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
  };
}

function hydratePreferences(
  value: Record<string, unknown>,
): Pick<SerialSession, 'terminalAiModel' | 'logAiModel' | 'logAiContextMode' | 'logAiFrameLimit'> {
  assertExactKeys(
    value,
    ['schemaVersion', 'terminalAiModel', 'logAiModel', 'logAiContextMode', 'logAiFrameLimit'],
    'preferences',
  );
  expectVersion(value.schemaVersion, 'preferences.schemaVersion');
  const terminalAiModel = expectString(value.terminalAiModel, 'preferences.terminalAiModel');
  const logAiModel = expectString(value.logAiModel, 'preferences.logAiModel');
  if (!isValidAiModel(terminalAiModel) || !isValidAiModel(logAiModel)) {
    throw new WorkspaceAdapterValidationError('preferences.aiModel');
  }
  const logAiContextMode = expectString(value.logAiContextMode, 'preferences.logAiContextMode');
  if (
    logAiContextMode !== 'latest-10k' &&
    logAiContextMode !== 'latest-n-frames' &&
    logAiContextMode !== 'full-capped'
  ) {
    throw new WorkspaceAdapterValidationError('preferences.logAiContextMode');
  }
  return {
    terminalAiModel,
    logAiModel,
    logAiContextMode,
    logAiFrameLimit: boundedInteger(
      value.logAiFrameLimit,
      20,
      2_000,
      'preferences.logAiFrameLimit',
    ),
  };
}

function hydrateParser(value: Record<string, unknown>): SerialSession['parserState'] {
  assertExactKeys(value, ['schemaVersion', 'config', 'presetId'], 'parser');
  expectVersion(value.schemaVersion, 'parser.schemaVersion');
  if (!isRecord(value.config)) throw new WorkspaceAdapterValidationError('parser.config');
  validateParserConfig(value.config);
  const presetId =
    value.presetId === null
      ? null
      : validateSafeText(value.presetId, 'parser.presetId', { maxBytes: 128 });
  return normalizeParserState({ config: value.config, presetId });
}

function hydrateModbusConfig(value: Record<string, unknown>): SerialSession['modbusConfig'] {
  assertExactKeys(
    value,
    ['schemaVersion', 'transport', 'enabled', 'pollIntervalMs', 'writeIntervalMs', 'timeoutMs'],
    'modbusConfig',
  );
  expectVersion(value.schemaVersion, 'modbusConfig.schemaVersion');
  if (value.transport !== 'rtu' && value.transport !== 'pdu') {
    throw new WorkspaceAdapterValidationError('modbusConfig.transport');
  }
  validateModbusConfig(value, 'modbusConfig');
  return normalizeModbusConfig(value);
}

function hydrateMcumgrConfig(value: Record<string, unknown>): SerialSession['mcumgrConfig'] {
  if (!isRecord(value)) throw new WorkspaceAdapterValidationError('mcumgrConfig');
  if (Object.keys(value).length === 0) {
    return cloneMcumgrConfig(DEFAULT_MCUMGR_CONFIG);
  }
  if ('schemaVersion' in value) expectVersion(value.schemaVersion, 'mcumgrConfig.schemaVersion');
  return cloneMcumgrConfig(normalizeMcumgrConfig(value));
}

function hydrateShell(value: Record<string, unknown>): SerialSession['shellConfig'] {
  if (Object.keys(value).length === 0) {
    return cloneSerialShellConfig(DEFAULT_SERIAL_SHELL_CONFIG);
  }
  assertExactKeys(value, ['schemaVersion', 'shell'], 'sendPreferences');
  expectVersion(value.schemaVersion, 'sendPreferences.schemaVersion');
  if (!isRecord(value.shell)) throw new WorkspaceAdapterValidationError('sendPreferences.shell');
  // Pre-terminal snapshots persisted extra fields; tolerate and drop them.
  assertExactKeys(
    value.shell,
    [...SERIAL_SHELL_CONFIG_KEYS, ...SERIAL_SHELL_LEGACY_CONFIG_KEYS],
    'sendPreferences.shell',
  );
  validateSerialShellConfig(value.shell, 'sendPreferences.shell');
  return normalizeSerialShellConfig(value.shell);
}

function hydratePortConfig(value: Record<string, unknown>): SerialSession['portConfig'] {
  assertExactKeys(
    value,
    ['baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl', 'rxFrameGapMs', 'dtr', 'rts'],
    'portConfig',
  );
  positiveInteger(value.baudRate, 'portConfig.baudRate');
  if (
    value.dataBits !== 5 &&
    value.dataBits !== 6 &&
    value.dataBits !== 7 &&
    value.dataBits !== 8
  ) {
    throw new WorkspaceAdapterValidationError('portConfig.dataBits');
  }
  if (value.stopBits !== 1 && value.stopBits !== 2) {
    throw new WorkspaceAdapterValidationError('portConfig.stopBits');
  }
  if (value.parity !== 'none' && value.parity !== 'odd' && value.parity !== 'even') {
    throw new WorkspaceAdapterValidationError('portConfig.parity');
  }
  if (
    value.flowControl !== 'none' &&
    value.flowControl !== 'software' &&
    value.flowControl !== 'hardware'
  ) {
    throw new WorkspaceAdapterValidationError('portConfig.flowControl');
  }
  positiveInteger(value.rxFrameGapMs, 'portConfig.rxFrameGapMs');
  expectBoolean(value.dtr, 'portConfig.dtr');
  expectBoolean(value.rts, 'portConfig.rts');
  const normalized = normalizePortConfig(value);
  if (canonicalJson(normalized) !== canonicalJson(value)) {
    throw new WorkspaceAdapterValidationError('portConfig');
  }
  return normalized;
}

const SERIAL_SESSION_KEYS: ReadonlySet<string> = new Set([
  'id',
  'portName',
  'portConfig',
  'isConnected',
  'frames',
  'pausedFrames',
  'capturePaused',
  'txBytes',
  'rxBytes',
  'txFrames',
  'rxFrames',
  'droppedBytes',
  'startTime',
  'sendHistory',
  'sendDraft',
  'quickCommands',
  'macros',
  'triggers',
  'highlights',
  'parserState',
  'modbusRegisters',
  'modbusConfig',
  'shellConfig',
  'mcumgrConfig',
  'waveformSourceMode',
  'autoLogEnabled',
  'logPath',
  'terminalAiModel',
  'logAiModel',
  'logAiContextMode',
  'logAiFrameLimit',
  'logAiMessages',
]);

function assertKnownSessionShape(session: SerialSession): void {
  if (!isRecord(session)) throw new WorkspaceAdapterValidationError('session');
  for (const key of Object.keys(session)) {
    if (!SERIAL_SESSION_KEYS.has(key)) {
      throw new WorkspaceAdapterValidationError(`session.${key}`);
    }
  }
}

// Keep this reference intentional: it makes validation fail closed if the
// canonical AI registry is ever emptied while types remain stale.
if (AI_MODEL_IDS.length === 0) throw new Error('AI model registry must not be empty');
