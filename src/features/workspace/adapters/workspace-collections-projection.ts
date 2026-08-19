import type {
  WorkspaceAiMessage,
  WorkspaceAiMessagesPayload,
  WorkspaceConfigRow,
  WorkspaceSessionCollectionsPayload,
} from '../../../generated/ipc-contracts';
import { IPC_LIMITS } from '../../../generated/ipc-contracts';
import type {
  AiChatMessage,
  HighlightRule,
  Macro,
  ModbusRegister,
  QuickCommand,
  SendHistoryEntry,
  SerialSession,
  Trigger,
} from '../../../types';
import { MAX_HISTORY } from '../../../types';
import {
  isModbusWriteFc,
  isReadFc,
  normalizeModbusQuantity,
  normalizeModbusRegisters,
} from '../../../lib/modbus';
import {
  WorkspaceAdapterLimitError,
  WorkspaceAdapterValidationError,
} from './workspace-adapter-errors';
import {
  validateOpaqueText,
  validateSafeText,
  validateWorkspaceIdentifier,
  utf8ByteLength,
} from './workspace-adapter-security';
import {
  WORKSPACE_MUTATION_ENVELOPE_RESERVE_BYTES,
  assertExactKeys,
  assertLimit,
  assertUniqueIds,
  boundedInteger,
  canonicalJson,
  expectBoolean,
  expectString,
  invalid,
  jsonByteLength,
  positiveInteger,
  validNonNegativeInteger,
  validUint32,
} from './workspace-validation';

/**
 * Collections and AI row projectors/hydrators for the workspace session
 * adapter.
 *
 * Covers every named collection (send history, quick commands, macros,
 * triggers, highlights, Modbus registers) plus the AI chat-message rows and
 * their byte-budgeted `append-ai-messages` chunking. Cohesion note: the AI
 * message chunker lives here (not with the waveform chunker) because it
 * operates on the same `WorkspaceAiMessagesPayload` rows this module
 * projects and hydrates.
 */

export function projectCollections(session: SerialSession): WorkspaceSessionCollectionsPayload {
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
  ownerPluginId?: string;
} {
  assertExactKeys(command, ['id', 'name', 'data', 'isHex', 'ownerPluginId'], 'quickCommand');
  const id = validateWorkspaceIdentifier(command.id, 'quickCommand.id');
  const ownerPluginId = projectPluginOwner(command.ownerPluginId, id, 'quickCommand');
  return {
    id,
    name: validateSafeText(command.name, 'quickCommand.name', { maxBytes: 256 }),
    data: validateOpaqueText(command.data, 'quickCommand.data', {
      maxBytes: 1024 * 1024,
      allowEmpty: true,
    }),
    isHex: expectBoolean(command.isHex, 'quickCommand.isHex'),
    ...(ownerPluginId ? { ownerPluginId } : {}),
  };
}

function projectMacro(macro: Macro): {
  id: string;
  name: string;
  steps: { data: string; isHex: boolean; delayMs: number }[];
  ownerPluginId?: string;
} {
  assertExactKeys(macro, ['id', 'name', 'steps', 'ownerPluginId'], 'macro');
  if (!Array.isArray(macro.steps)) throw new WorkspaceAdapterValidationError('macro.steps');
  const id = validateWorkspaceIdentifier(macro.id, 'macro.id');
  const ownerPluginId = projectPluginOwner(macro.ownerPluginId, id, 'macro');
  return {
    id,
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
    ...(ownerPluginId ? { ownerPluginId } : {}),
  };
}

function projectPluginOwner(
  ownerPluginId: string | null | undefined,
  itemId: string,
  field: string,
): string | undefined {
  if (ownerPluginId === null || ownerPluginId === undefined) return undefined;
  const owner = validateWorkspaceIdentifier(ownerPluginId, `${field}.ownerPluginId`);
  if (!itemId.startsWith(`plugin:${owner}:`) || itemId.length <= owner.length + 8) {
    throw new WorkspaceAdapterValidationError(`${field}.ownerPluginId`);
  }
  return owner;
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

export function projectAiMessages(messages: readonly AiChatMessage[]): WorkspaceAiMessagesPayload {
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

export function chunkAiMessages(
  messages: readonly WorkspaceAiMessage[],
): WorkspaceAiMessagesPayload[] {
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

export function hydrateCollections(payload: WorkspaceSessionCollectionsPayload): {
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

export function hydrateAiMessages(messages: readonly WorkspaceAiMessage[]): AiChatMessage[] {
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
