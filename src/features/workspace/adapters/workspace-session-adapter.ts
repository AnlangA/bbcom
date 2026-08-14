import type {
  WorkspaceAiMessage,
  WorkspaceAiMessagesPayload,
  WorkspaceConfigRow,
  WorkspaceHydratedFrame,
  WorkspaceMutation,
  WorkspacePortHint,
  WorkspaceSessionCollectionsPayload,
  WorkspaceSessionKind,
  WorkspaceSessionSnapshot,
  WorkspaceWaveformChannel,
  WorkspaceWaveformChannelsPayload,
  WorkspaceWaveformSample,
} from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import { AI_MODEL_IDS, isValidAiModel } from '../../../lib/ai-models';
import {
  cloneParserState,
  countFrameTotals,
  createSessionRecord,
  normalizeParserState,
  normalizePortConfig,
} from '../../../lib/session-persistence';
import {
  cloneModbusConfig,
  isModbusWriteFc,
  isReadFc,
  normalizeModbusConfig,
  normalizeModbusQuantity,
  normalizeModbusRegisters,
} from '../../../lib/modbus';
import type {
  AiChatMessage,
  HighlightRule,
  Macro,
  ModbusMasterConfig,
  ModbusRegister,
  PortConfig,
  QuickCommand,
  SendHistoryEntry,
  SerialSession,
  SessionWaveformFrameCursor,
  Trigger,
} from '../../../types';
import { MAX_HISTORY } from '../../../types';
import {
  WorkspaceAdapterLimitError,
  WorkspaceAdapterValidationError,
} from './workspace-adapter-errors';
import {
  assertSafeWorkspaceValue,
  validateOpaqueText,
  validateSafeText,
  validateWorkspaceIdentifier,
  utf8ByteLength,
} from './workspace-adapter-security';
import { hydrateWorkspaceFrame } from './workspace-frame-adapter';

export const WORKSPACE_SESSION_PROJECTION_VERSION = 1 as const;

export interface WorkspaceWaveformChannelProjection {
  readonly channelIndex: number;
  readonly config: Record<string, unknown>;
}

export interface WorkspaceWaveformSampleProjection {
  readonly channelIndex: number;
  readonly seq: number;
  readonly timestampMs: number;
  readonly value: number;
}

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
  assertEmptyRecord(snapshot.sendPreferences, 'snapshot.sendPreferences');
  const preferences = hydratePreferences(snapshot.featureState);
  const parserState = hydrateParser(snapshot.parserState);
  const modbusConfig = hydrateModbusConfig(snapshot.modbusConfig);
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
  feature: 'preferences' | 'parser' | 'modbus' | 'waveform',
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

export function projectWorkspaceWaveformPreferences(
  session: Pick<SerialSession, 'waveformSourceMode'>,
  frameCursor?: SessionWaveformFrameCursor,
  channels?: readonly Readonly<{
    channelIndex: number;
    config?: Readonly<Record<string, unknown>>;
    visible?: boolean;
  }>[],
): Record<string, unknown> {
  if (session.waveformSourceMode !== 'text' && session.waveformSourceMode !== 'register') {
    throw new WorkspaceAdapterValidationError('session.waveformSourceMode');
  }
  if (frameCursor && !isWorkspaceWaveformFrameCursor(frameCursor)) {
    throw new WorkspaceAdapterValidationError('session.waveformFrameCursor');
  }
  const channelVisibility = channels?.map((channel) => ({
    channelIndex: boundedInteger(channel.channelIndex, 0, 7, 'waveform.channelIndex'),
    visible:
      channel.visible ??
      (channel.config?.visible === undefined
        ? true
        : expectBoolean(channel.config.visible, 'waveform.channel.visible')),
  }));
  if (
    channelVisibility &&
    new Set(channelVisibility.map((channel) => channel.channelIndex)).size !==
      channelVisibility.length
  ) {
    throw new WorkspaceAdapterValidationError('waveform.channelIndex');
  }
  return {
    schemaVersion: WORKSPACE_SESSION_PROJECTION_VERSION,
    sourceMode: session.waveformSourceMode,
    ...(frameCursor
      ? { frameCursor: { consumed: frameCursor.consumed, lastFrameId: frameCursor.lastFrameId } }
      : {}),
    ...(channelVisibility ? { channelVisibility } : {}),
  };
}

function projectCollections(session: SerialSession): WorkspaceSessionCollectionsPayload {
  assertLimit('sendHistory', MAX_HISTORY, session.sendHistory.length);
  const projected = {
    sendHistory: session.sendHistory.map(projectSendHistory),
    quickCommands: session.quickCommands.map(projectQuickCommand),
    macros: session.macros.map(projectMacro),
    triggers: session.triggers.map((trigger) => ({
      id: validateWorkspaceIdentifier(trigger.id, 'trigger.id'),
      config: projectTriggerConfig(trigger),
    })),
    highlights: session.highlights.map((highlight) => ({
      id: validateWorkspaceIdentifier(highlight.id, 'highlight.id'),
      config: projectHighlightConfig(highlight),
    })),
    modbusRegisters: session.modbusRegisters.map(projectModbusRegisterRow),
  };
  assertUniqueIds(projected.quickCommands, 'quickCommand.id');
  assertUniqueIds(projected.macros, 'macro.id');
  assertUniqueIds(projected.triggers, 'trigger.id');
  assertUniqueIds(projected.highlights, 'highlight.id');
  assertUniqueIds(projected.modbusRegisters, 'modbusRegister.id');
  return projected;
}

function projectSendHistory(entry: SendHistoryEntry): { data: string; isHex: boolean } {
  assertExactKeys(entry, ['data', 'isHex'], 'sendHistory');
  return {
    data: validateOpaqueText(entry.data, 'sendHistory.data', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    isHex: expectBoolean(entry.isHex, 'sendHistory.isHex'),
  };
}

function projectQuickCommand(command: QuickCommand): {
  id: string;
  name: string;
  data: string;
  isHex: boolean;
} {
  assertExactKeys(command, ['id', 'name', 'data', 'isHex'], 'quickCommand');
  return {
    id: validateWorkspaceIdentifier(command.id, 'quickCommand.id'),
    name: validateSafeText(command.name, 'quickCommand.name', { maxBytes: 256 }),
    data: validateOpaqueText(command.data, 'quickCommand.data', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    isHex: expectBoolean(command.isHex, 'quickCommand.isHex'),
  };
}

function projectMacro(macro: Macro): {
  id: string;
  name: string;
  steps: { data: string; isHex: boolean; delayMs: number }[];
} {
  assertExactKeys(macro, ['id', 'name', 'steps'], 'macro');
  if (!Array.isArray(macro.steps)) throw new WorkspaceAdapterValidationError('macro.steps');
  return {
    id: validateWorkspaceIdentifier(macro.id, 'macro.id'),
    name: validateSafeText(macro.name, 'macro.name', { maxBytes: 256 }),
    steps: macro.steps.map((step) => {
      assertExactKeys(step, ['data', 'isHex', 'delayMs'], 'macro.step');
      return {
        data: validateOpaqueText(step.data, 'macro.step.data', {
          maxBytes: 1024 * 1024,
          allowEmpty: true,
        }),
        isHex: expectBoolean(step.isHex, 'macro.step.isHex'),
        delayMs: validUint32(step.delayMs, 'macro.step.delayMs'),
      };
    }),
  };
}

function projectTriggerConfig(trigger: Trigger): Record<string, unknown> {
  assertExactKeys(
    trigger,
    ['id', 'name', 'enabled', 'matchMode', 'pattern', 'response', 'responseIsHex', 'cooldownMs'],
    'trigger',
  );
  if (trigger.matchMode !== 'text' && trigger.matchMode !== 'hex') {
    throw new WorkspaceAdapterValidationError('trigger.matchMode');
  }
  return {
    name: validateSafeText(trigger.name, 'trigger.name', { maxBytes: 256 }),
    enabled: expectBoolean(trigger.enabled, 'trigger.enabled'),
    matchMode: trigger.matchMode,
    pattern: validateOpaqueText(trigger.pattern, 'trigger.pattern', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    response: validateOpaqueText(trigger.response, 'trigger.response', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    responseIsHex: expectBoolean(trigger.responseIsHex, 'trigger.responseIsHex'),
    cooldownMs: validUint32(trigger.cooldownMs, 'trigger.cooldownMs'),
  };
}

function projectHighlightConfig(highlight: HighlightRule): Record<string, unknown> {
  assertExactKeys(
    highlight,
    ['id', 'name', 'enabled', 'matchMode', 'pattern', 'direction', 'color'],
    'highlight',
  );
  if (highlight.matchMode !== 'text' && highlight.matchMode !== 'hex') {
    throw new WorkspaceAdapterValidationError('highlight.matchMode');
  }
  if (
    highlight.direction !== 'ALL' &&
    highlight.direction !== 'TX' &&
    highlight.direction !== 'RX'
  ) {
    throw new WorkspaceAdapterValidationError('highlight.direction');
  }
  if (!['amber', 'red', 'blue', 'green', 'violet'].includes(highlight.color)) {
    throw new WorkspaceAdapterValidationError('highlight.color');
  }
  return {
    name: validateSafeText(highlight.name, 'highlight.name', { maxBytes: 256 }),
    enabled: expectBoolean(highlight.enabled, 'highlight.enabled'),
    matchMode: highlight.matchMode,
    pattern: validateOpaqueText(highlight.pattern, 'highlight.pattern', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    direction: highlight.direction,
    color: highlight.color,
  };
}

function projectModbusRegisterRow(register: ModbusRegister): WorkspaceConfigRow {
  assertExactKeys(
    register,
    [
      'id',
      'name',
      'slaveAddress',
      'functionCode',
      'address',
      'quantity',
      'type',
      'unit',
      'waveformChannel',
      'value',
      'values',
      'valueTs',
      'periodicRead',
      'periodicWrite',
    ],
    'modbusRegister',
  );
  if (![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x10].includes(register.functionCode)) {
    throw new WorkspaceAdapterValidationError('modbusRegister.functionCode');
  }
  if (
    ![
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
    ].includes(register.type)
  ) {
    throw new WorkspaceAdapterValidationError('modbusRegister.type');
  }
  boundedInteger(register.slaveAddress, 0, 247, 'modbusRegister.slaveAddress');
  boundedInteger(register.address, 0, 0xffff, 'modbusRegister.address');
  if (
    register.quantity !== undefined &&
    normalizeModbusQuantity(register.quantity, register.functionCode, register.type) !==
      register.quantity
  ) {
    throw new WorkspaceAdapterValidationError('modbusRegister.quantity');
  }
  if (
    register.periodicRead !== (isReadFc(register.functionCode) && register.periodicRead) ||
    register.periodicWrite !== (isModbusWriteFc(register.functionCode) && register.periodicWrite)
  ) {
    throw new WorkspaceAdapterValidationError('modbusRegister.periodicMode');
  }
  return {
    id: validateWorkspaceIdentifier(register.id, 'modbusRegister.id'),
    config: {
      name: validateSafeText(register.name, 'modbusRegister.name', { maxBytes: 256 }),
      slaveAddress: register.slaveAddress,
      functionCode: register.functionCode,
      address: register.address,
      ...(register.quantity !== undefined
        ? { quantity: positiveInteger(register.quantity, 'modbusRegister.quantity') }
        : {}),
      type: register.type,
      ...(register.unit !== undefined
        ? {
            unit: validateSafeText(register.unit, 'modbusRegister.unit', {
              maxBytes: 64,
              allowEmpty: true,
            }),
          }
        : {}),
      waveformChannel:
        register.waveformChannel === null
          ? null
          : boundedInteger(register.waveformChannel, 0, 7, 'modbusRegister.waveformChannel'),
      periodicRead: expectBoolean(register.periodicRead, 'modbusRegister.periodicRead'),
      periodicWrite: expectBoolean(register.periodicWrite, 'modbusRegister.periodicWrite'),
    },
  };
}

function projectAiMessages(messages: readonly AiChatMessage[]): WorkspaceAiMessagesPayload {
  if (!Array.isArray(messages)) throw new WorkspaceAdapterValidationError('aiMessages');
  assertLimit('aiMessages', IPC_LIMITS.MAX_WORKSPACE_AI_MESSAGES, messages.length);
  let totalBytes = 0;
  const projected: WorkspaceAiMessage[] = messages.map((message) => {
    assertExactKeys(message, ['id', 'role', 'content', 'timestamp'], 'aiMessage');
    const content = validateOpaqueText(message.content, 'aiMessage.content', {
      maxBytes: IPC_LIMITS.MAX_WORKSPACE_AI_MESSAGE_BYTES,
      allowEmpty: true,
    });
    totalBytes += utf8ByteLength(content);
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new WorkspaceAdapterValidationError('aiMessage.role');
    }
    return {
      id: validateWorkspaceIdentifier(message.id, 'aiMessage.id'),
      role: message.role,
      content,
      timestampMs: validNonNegativeInteger(message.timestamp, 'aiMessage.timestamp'),
    };
  });
  assertUniqueIds(projected, 'aiMessage.id');
  assertLimit('aiMessageBytes', IPC_LIMITS.MAX_WORKSPACE_AI_BYTES, totalBytes);
  return { startPosition: 0, messages: projected };
}

function projectWaveformSamples(input: {
  readonly channels: readonly WorkspaceWaveformChannelProjection[];
  readonly samples: readonly WorkspaceWaveformSampleProjection[];
}): {
  channels: WorkspaceWaveformChannelsPayload;
  samples: WorkspaceWaveformSample[];
} {
  if (!Array.isArray(input.channels) || !Array.isArray(input.samples)) {
    throw new WorkspaceAdapterValidationError('waveform');
  }
  const seenChannels = new Set<number>();
  const channels = input.channels.map((channel) => {
    assertExactKeys(channel, ['channelIndex', 'config'], 'waveform.channel');
    const channelIndex = boundedInteger(channel.channelIndex, 0, 7, 'waveform.channelIndex');
    if (seenChannels.has(channelIndex)) {
      throw new WorkspaceAdapterValidationError('waveform.channelIndex');
    }
    seenChannels.add(channelIndex);
    assertSafeWorkspaceValue(channel.config, 'waveform.channelConfig');
    return { channelIndex, config: structuredClone(channel.config) };
  });
  const seenSamples = new Set<string>();
  const samples = input.samples.map((sample) => {
    assertExactKeys(sample, ['channelIndex', 'seq', 'timestampMs', 'value'], 'waveform.sample');
    const channelIndex = boundedInteger(sample.channelIndex, 0, 7, 'waveform.channelIndex');
    if (!seenChannels.has(channelIndex)) {
      throw new WorkspaceAdapterValidationError('waveform.sample.channelIndex');
    }
    const sequence = validNonNegativeInteger(sample.seq, 'waveform.seq');
    const sampleKey = `${channelIndex}:${sequence}`;
    if (seenSamples.has(sampleKey)) {
      throw new WorkspaceAdapterValidationError('waveform.sample.seq');
    }
    seenSamples.add(sampleKey);
    if (!Number.isFinite(sample.value)) throw new WorkspaceAdapterValidationError('waveform.value');
    return {
      channelIndex,
      seq: sequence,
      timestampMs: validNonNegativeInteger(sample.timestampMs, 'waveform.timestampMs'),
      value: sample.value,
    };
  });
  return { channels: { channels }, samples };
}

function projectPortConfig(config: PortConfig): Record<string, unknown> {
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

function hydrateWaveformPreferences(value: Record<string, unknown>): {
  readonly sourceMode: SerialSession['waveformSourceMode'];
  readonly frameCursor: SessionWaveformFrameCursor | null;
  readonly channelVisibility: ReadonlyMap<number, boolean>;
} {
  const keys = ['schemaVersion', 'sourceMode'];
  if (value.frameCursor !== undefined) keys.push('frameCursor');
  if (value.channelVisibility !== undefined) keys.push('channelVisibility');
  assertExactKeys(value, keys, 'waveformPreferences');
  expectVersion(value.schemaVersion, 'waveformPreferences.schemaVersion');
  if (value.sourceMode !== 'text' && value.sourceMode !== 'register') {
    throw new WorkspaceAdapterValidationError('waveformPreferences.sourceMode');
  }
  let frameCursor: SessionWaveformFrameCursor | null = null;
  if (value.frameCursor !== undefined) {
    if (
      !value.frameCursor ||
      typeof value.frameCursor !== 'object' ||
      Array.isArray(value.frameCursor)
    ) {
      throw new WorkspaceAdapterValidationError('waveformPreferences.frameCursor');
    }
    const cursor = value.frameCursor as Record<string, unknown>;
    assertExactKeys(cursor, ['consumed', 'lastFrameId'], 'waveformPreferences.frameCursor');
    if (!isWorkspaceWaveformFrameCursor(cursor)) {
      throw new WorkspaceAdapterValidationError('waveformPreferences.frameCursor');
    }
    frameCursor = Object.freeze({
      consumed: cursor.consumed,
      lastFrameId: cursor.lastFrameId,
    });
  }
  const channelVisibility = new Map<number, boolean>();
  if (value.channelVisibility !== undefined) {
    if (!Array.isArray(value.channelVisibility) || value.channelVisibility.length > 8) {
      throw new WorkspaceAdapterValidationError('waveformPreferences.channelVisibility');
    }
    for (const entry of value.channelVisibility) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new WorkspaceAdapterValidationError('waveformPreferences.channelVisibility');
      }
      const channel = entry as Record<string, unknown>;
      assertExactKeys(
        channel,
        ['channelIndex', 'visible'],
        'waveformPreferences.channelVisibility',
      );
      const channelIndex = boundedInteger(
        channel.channelIndex,
        0,
        7,
        'waveformPreferences.channelIndex',
      );
      if (channelVisibility.has(channelIndex)) {
        throw new WorkspaceAdapterValidationError('waveformPreferences.channelIndex');
      }
      channelVisibility.set(
        channelIndex,
        expectBoolean(channel.visible, 'waveformPreferences.channel.visible'),
      );
    }
  }
  return Object.freeze({
    sourceMode: value.sourceMode,
    frameCursor,
    channelVisibility,
  });
}

function legacyWaveformFrameCursor(
  sourceMode: SerialSession['waveformSourceMode'],
  frames: readonly { readonly id: string }[],
  hasDurableSamples: boolean,
): SessionWaveformFrameCursor {
  if (sourceMode === 'register' || hasDurableSamples) {
    return Object.freeze({
      consumed: frames.length,
      lastFrameId: frames.at(-1)?.id ?? null,
    });
  }
  // Legacy projects did not persist this cursor. Force one deterministic text
  // rebuild so retained frames replace (rather than duplicate) derived rows.
  return Object.freeze({ consumed: frames.length + 1, lastFrameId: null });
}

function isWorkspaceWaveformFrameCursor(value: unknown): value is SessionWaveformFrameCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(cursor.consumed) &&
    (cursor.consumed as number) >= 0 &&
    (cursor.lastFrameId === null || typeof cursor.lastFrameId === 'string')
  );
}

function hydratePortConfig(value: Record<string, unknown>): PortConfig {
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

function hydrateCollections(payload: WorkspaceSessionCollectionsPayload): {
  sendHistory: SendHistoryEntry[];
  quickCommands: QuickCommand[];
  macros: Macro[];
  triggers: Trigger[];
  highlights: HighlightRule[];
  modbusRegisters: ModbusRegister[];
} {
  assertExactKeys(
    payload,
    ['sendHistory', 'quickCommands', 'macros', 'triggers', 'highlights', 'modbusRegisters'],
    'collections',
  );
  for (const [field, value] of Object.entries(payload)) {
    if (!Array.isArray(value)) throw new WorkspaceAdapterValidationError(`collections.${field}`);
  }
  assertLimit('sendHistory', MAX_HISTORY, payload.sendHistory.length);
  const sendHistory = payload.sendHistory.map(projectSendHistory);
  const quickCommands = payload.quickCommands.map(projectQuickCommand);
  const macros = payload.macros.map(projectMacro);
  const triggers = payload.triggers.map(hydrateTriggerRow);
  const highlights = payload.highlights.map(hydrateHighlightRow);
  const registerCandidates = payload.modbusRegisters.map(hydrateModbusRegisterRow);
  assertUniqueIds(quickCommands, 'quickCommand.id');
  assertUniqueIds(macros, 'macro.id');
  assertUniqueIds(triggers, 'trigger.id');
  assertUniqueIds(highlights, 'highlight.id');
  assertUniqueIds(registerCandidates, 'modbusRegister.id');
  const modbusRegisters = normalizeModbusRegisters(registerCandidates);
  if (modbusRegisters.length !== registerCandidates.length) {
    throw new WorkspaceAdapterValidationError('collections.modbusRegisters');
  }
  return { sendHistory, quickCommands, macros, triggers, highlights, modbusRegisters };
}

function hydrateTriggerRow(row: WorkspaceConfigRow): Trigger {
  assertExactKeys(row, ['id', 'config'], 'trigger');
  const config = row.config;
  assertExactKeys(
    config,
    ['name', 'enabled', 'matchMode', 'pattern', 'response', 'responseIsHex', 'cooldownMs'],
    'trigger.config',
  );
  const trigger: Trigger = {
    id: validateWorkspaceIdentifier(row.id, 'trigger.id'),
    name: validateSafeText(config.name, 'trigger.name', { maxBytes: 256 }),
    enabled: expectBoolean(config.enabled, 'trigger.enabled'),
    matchMode:
      config.matchMode === 'text' || config.matchMode === 'hex'
        ? config.matchMode
        : invalid('trigger.matchMode'),
    pattern: validateOpaqueText(config.pattern, 'trigger.pattern', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    response: validateOpaqueText(config.response, 'trigger.response', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    responseIsHex: expectBoolean(config.responseIsHex, 'trigger.responseIsHex'),
    cooldownMs: validUint32(config.cooldownMs, 'trigger.cooldownMs'),
  };
  projectTriggerConfig(trigger);
  return trigger;
}

function hydrateHighlightRow(row: WorkspaceConfigRow): HighlightRule {
  assertExactKeys(row, ['id', 'config'], 'highlight');
  const config = row.config;
  assertExactKeys(
    config,
    ['name', 'enabled', 'matchMode', 'pattern', 'direction', 'color'],
    'highlight.config',
  );
  const highlight = {
    id: validateWorkspaceIdentifier(row.id, 'highlight.id'),
    name: validateSafeText(config.name, 'highlight.name', { maxBytes: 256 }),
    enabled: expectBoolean(config.enabled, 'highlight.enabled'),
    matchMode: config.matchMode,
    pattern: validateOpaqueText(config.pattern, 'highlight.pattern', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    direction: config.direction,
    color: config.color,
  } as HighlightRule;
  projectHighlightConfig(highlight);
  return highlight;
}

function hydrateModbusRegisterRow(row: WorkspaceConfigRow): ModbusRegister {
  assertExactKeys(row, ['id', 'config'], 'modbusRegister');
  const config = row.config;
  assertExactKeys(
    config,
    [
      'name',
      'slaveAddress',
      'functionCode',
      'address',
      'quantity',
      'type',
      'unit',
      'waveformChannel',
      'periodicRead',
      'periodicWrite',
    ],
    'modbusRegister.config',
  );
  const candidate = {
    id: validateWorkspaceIdentifier(row.id, 'modbusRegister.id'),
    name: expectString(config.name, 'modbusRegister.name'),
    slaveAddress: config.slaveAddress,
    functionCode: config.functionCode,
    address: config.address,
    quantity: config.quantity,
    type: config.type,
    unit: config.unit,
    waveformChannel: config.waveformChannel,
    periodicRead: config.periodicRead,
    periodicWrite: config.periodicWrite,
    value: null,
    values: null,
    valueTs: null,
  } as ModbusRegister;
  const normalized = normalizeModbusRegisters([candidate]);
  if (normalized.length !== 1) throw new WorkspaceAdapterValidationError('modbusRegister.config');
  const register = normalized[0];
  const projected = projectModbusRegisterRow(register);
  if (canonicalJson(projected.config) !== canonicalJson(config)) {
    throw new WorkspaceAdapterValidationError('modbusRegister.config');
  }
  return register;
}

function hydrateAiMessages(messages: readonly WorkspaceAiMessage[]): AiChatMessage[] {
  if (!Array.isArray(messages)) throw new WorkspaceAdapterValidationError('aiMessages');
  const projected = projectAiMessages(
    messages.map((message) => {
      assertExactKeys(message, ['id', 'role', 'content', 'timestampMs'], 'aiMessage');
      return {
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestampMs,
      };
    }),
  );
  return projected.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestampMs,
  }));
}

function cloneWaveformPayload(
  channelRows: readonly WorkspaceWaveformChannel[],
  sampleRows: readonly WorkspaceWaveformSample[],
): {
  readonly channels: readonly WorkspaceWaveformChannel[];
  readonly samples: readonly WorkspaceWaveformSample[];
} {
  if (!Array.isArray(channelRows) || !Array.isArray(sampleRows)) {
    throw new WorkspaceAdapterValidationError('waveform');
  }
  const channels = channelRows.map((channel, index) => {
    assertExactKeys(channel, ['channelIndex', 'config'], `waveform.channels[${index}]`);
    const channelIndex = boundedInteger(channel.channelIndex, 0, 7, `waveform.channels[${index}]`);
    assertSafeWorkspaceValue(channel.config, `waveform.channels[${index}].config`);
    return { channelIndex, config: structuredClone(channel.config) };
  });
  if (new Set(channels.map((channel) => channel.channelIndex)).size !== channels.length) {
    throw new WorkspaceAdapterValidationError('waveform.channels');
  }
  const knownChannels = new Set(channels.map((channel) => channel.channelIndex));
  const sampleKeys = new Set<string>();
  const samples = sampleRows.map((sample) => {
    assertExactKeys(sample, ['channelIndex', 'seq', 'timestampMs', 'value'], 'waveform.sample');
    const channelIndex = boundedInteger(sample.channelIndex, 0, 7, 'waveform.sample.channelIndex');
    if (!knownChannels.has(channelIndex)) {
      throw new WorkspaceAdapterValidationError('waveform.sample.channelIndex');
    }
    const sequence = validNonNegativeInteger(sample.seq, 'waveform.seq');
    const sampleKey = `${channelIndex}:${sequence}`;
    if (sampleKeys.has(sampleKey)) {
      throw new WorkspaceAdapterValidationError('waveform.sample.seq');
    }
    sampleKeys.add(sampleKey);
    if (!Number.isFinite(sample.value)) throw new WorkspaceAdapterValidationError('waveform.value');
    return {
      channelIndex,
      seq: sequence,
      timestampMs: validNonNegativeInteger(sample.timestampMs, 'waveform.timestampMs'),
      value: sample.value,
    };
  });
  return Object.freeze({ channels: Object.freeze(channels), samples: Object.freeze(samples) });
}

function chunkAiMessages(messages: readonly WorkspaceAiMessage[]): WorkspaceAiMessagesPayload[] {
  const chunks: WorkspaceAiMessagesPayload[] = [];
  let current: WorkspaceAiMessage[] = [];
  let startPosition = 0;
  for (const message of messages) {
    const candidate = { startPosition, messages: [...current, message] };
    const candidateBytes = jsonByteLength(candidate) + WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES;
    if (current.length > 0 && candidateBytes > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES) {
      chunks.push({ startPosition, messages: current });
      startPosition += current.length;
      current = [];
    }
    current.push(message);
    if (
      jsonByteLength({ startPosition, messages: current }) +
        WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES >
      IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES
    ) {
      throw new WorkspaceAdapterLimitError(
        'workspaceBatchBytes',
        IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES,
        jsonByteLength({ startPosition, messages: current }) +
          WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES,
      );
    }
  }
  if (current.length > 0) chunks.push({ startPosition, messages: current });
  return chunks;
}

function chunkWaveformSamples(
  samples: readonly WorkspaceWaveformSample[],
): { samples: WorkspaceWaveformSample[] }[] {
  const chunks: { samples: WorkspaceWaveformSample[] }[] = [];
  let current: WorkspaceWaveformSample[] = [];
  for (const sample of samples) {
    const candidate = { samples: [...current, sample] };
    if (
      current.length > 0 &&
      jsonByteLength(candidate) + WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES >
        IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES
    ) {
      chunks.push({ samples: current });
      current = [];
    }
    current.push(sample);
  }
  if (current.length > 0) {
    const actual = jsonByteLength({ samples: current }) + WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES;
    if (actual > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES) {
      throw new WorkspaceAdapterLimitError(
        'workspaceBatchBytes',
        IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES,
        actual,
      );
    }
    chunks.push({ samples: current });
  }
  return chunks;
}

const WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES = 2_048;

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

function assertMutationSize(mutation: WorkspaceMutation): void {
  const actual = jsonByteLength(mutation) + WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES;
  if (actual > IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES) {
    throw new WorkspaceAdapterLimitError(
      'workspaceBatchBytes',
      IPC_LIMITS.MAX_WORKSPACE_BATCH_BYTES,
      actual,
    );
  }
}

function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new WorkspaceAdapterValidationError('json');
  return utf8ByteLength(serialized);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new WorkspaceAdapterValidationError('json');
  return serialized;
}

function validateParserConfig(config: Record<string, unknown>): void {
  if (config.kind === 'delimiter') {
    assertExactKeys(config, ['kind', 'delimiter', 'includeDelimiter'], 'parser.config');
    if (
      !Array.isArray(config.delimiter) ||
      config.delimiter.length === 0 ||
      config.delimiter.length > 256 ||
      config.delimiter.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      throw new WorkspaceAdapterValidationError('parser.config.delimiter');
    }
    expectBoolean(config.includeDelimiter, 'parser.config.includeDelimiter');
    return;
  }
  if (config.kind === 'fixed') {
    assertExactKeys(config, ['kind', 'frameSize'], 'parser.config');
    boundedInteger(config.frameSize, 1, 65_535, 'parser.config.frameSize');
    return;
  }
  if (config.kind === 'length') {
    assertExactKeys(
      config,
      ['kind', 'lengthOffset', 'lengthSize', 'bigEndian', 'lengthAdjust'],
      'parser.config',
    );
    boundedInteger(config.lengthOffset, 0, 255, 'parser.config.lengthOffset');
    if (config.lengthSize !== 1 && config.lengthSize !== 2 && config.lengthSize !== 4) {
      throw new WorkspaceAdapterValidationError('parser.config.lengthSize');
    }
    expectBoolean(config.bigEndian, 'parser.config.bigEndian');
    boundedInteger(config.lengthAdjust, 0, 65_535, 'parser.config.lengthAdjust');
    return;
  }
  throw new WorkspaceAdapterValidationError('parser.config.kind');
}

function validateModbusConfig(value: ModbusMasterConfig, field: string): void;
function validateModbusConfig(value: Record<string, unknown>, field: string): void;
function validateModbusConfig(
  value: ModbusMasterConfig | Record<string, unknown>,
  field: string,
): void {
  if (value.transport !== 'rtu' && value.transport !== 'pdu') {
    throw new WorkspaceAdapterValidationError(`${field}.transport`);
  }
  expectBoolean(value.enabled, `${field}.enabled`);
  boundedInteger(value.pollIntervalMs, 100, 10_000, `${field}.pollIntervalMs`);
  boundedInteger(value.writeIntervalMs, 100, 10_000, `${field}.writeIntervalMs`);
  boundedInteger(value.timeoutMs, 50, 5_000, `${field}.timeoutMs`);
}

function assertEmptyRecord(value: Record<string, unknown>, field: string): void {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new WorkspaceAdapterValidationError(field);
  }
}

function assertExactKeys(value: unknown, allowed: readonly string[], field: string): void {
  if (!isRecord(value)) throw new WorkspaceAdapterValidationError(field);
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new WorkspaceAdapterValidationError(field);
  }
}

function assertUniqueIds(values: readonly { id: string }[], field: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new WorkspaceAdapterValidationError(field);
    ids.add(value.id);
  }
}

function expectVersion(value: unknown, field: string): void {
  if (value !== WORKSPACE_SESSION_PROJECTION_VERSION) {
    throw new WorkspaceAdapterValidationError(field);
  }
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new WorkspaceAdapterValidationError(field);
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new WorkspaceAdapterValidationError(field);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, field: string): number {
  const integer = validNonNegativeInteger(value, field);
  if (integer === 0) throw new WorkspaceAdapterValidationError(field);
  return integer;
}

function validNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return value;
}

function validUint32(value: unknown, field: string): number {
  return boundedInteger(value, 0, 0xffff_ffff, field);
}

function boundedInteger(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return value;
}

function invalid(field: string): never {
  throw new WorkspaceAdapterValidationError(field);
}

function assertLimit(field: string, limit: number, actual: number): void {
  if (actual > limit) throw new WorkspaceAdapterLimitError(field, limit, actual);
}

// Keep this reference intentional: it makes validation fail closed if the
// canonical AI registry is ever emptied while types remain stale.
if (AI_MODEL_IDS.length === 0) throw new Error('AI model registry must not be empty');
