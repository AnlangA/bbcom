import { normalizeModbusRegister, normalizeModbusRegisters } from '@/lib/modbus';
import {
  appendIdentifiedItem,
  patchIdentifiedItem,
  removeIdentifiedItem,
  upsertSendHistory,
} from '@/lib/session-store-helpers';
import type { AiChatMessage } from '@/types/ai';
import { MAX_HISTORY } from '@/types/constants';
import type { HighlightRule, Macro, Trigger } from '@/types/macros';
import type { ModbusRegister } from '@/types/modbus';
import type { SendHistoryEntry } from '@/types/serial';
import type { SerialSession } from '@/types/session';

export interface SessionDocumentMutationDependencies {
  findSession(sessionId: string): SerialSession | undefined;
  /** Synchronous write barrier for persisted, user-visible document state. */
  canMutateUserState?: () => boolean;
  schedulePersist(sessionId: string): void;
  onSessionChanged?: (sessionId: string) => void;
  onAiMessageAppended?: (sessionId: string, message: AiChatMessage, startPosition: number) => void;
  onAiMessagesCleared?: (sessionId: string) => void;
  createId?: () => string;
  now?: () => number;
  decorateAiMessage?: (message: AiChatMessage) => AiChatMessage;
}

/**
 * Mutations for persisted session-owned collections. Collection references are
 * replaced rather than mutated in place so the shallow-reactive store facade
 * continues to notify its existing consumers.
 */
export function createSessionDocumentMutations({
  findSession,
  canMutateUserState = () => true,
  schedulePersist,
  onSessionChanged = () => undefined,
  onAiMessageAppended = () => undefined,
  onAiMessagesCleared = () => undefined,
  createId = () => crypto.randomUUID(),
  now = () => Date.now(),
  decorateAiMessage = (message) => message,
}: SessionDocumentMutationDependencies) {
  function addSendHistory(sessionId: string, entry: SendHistoryEntry) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.sendHistory = upsertSendHistory(session.sendHistory, entry, MAX_HISTORY);
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function clearSendHistory(sessionId: string) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.sendHistory = [];
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setSendDraft(sessionId: string, draft: string) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.sendDraft = draft;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function addQuickCommand(
    sessionId: string,
    command: Omit<SerialSession['quickCommands'][number], 'id'>,
  ) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    const commands = [...session.quickCommands];
    appendIdentifiedItem(commands, command, createId);
    session.quickCommands = commands;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function removeQuickCommand(sessionId: string, commandId: string) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.quickCommands = removeIdentifiedItem(session.quickCommands, commandId);
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function addMacro(sessionId: string, macro: Omit<Macro, 'id'>): string | undefined {
    if (!canMutateUserState()) return undefined;
    const session = findSession(sessionId);
    if (!session) return undefined;
    const macros = [...session.macros];
    const id = appendIdentifiedItem(macros, macro, createId);
    session.macros = macros;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
    return id;
  }

  function updateMacro(sessionId: string, macroId: string, patch: Partial<Omit<Macro, 'id'>>) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    const macros = [...session.macros];
    if (!patchIdentifiedItem(macros, macroId, patch)) return;
    session.macros = macros;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function removeMacro(sessionId: string, macroId: string) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.macros = removeIdentifiedItem(session.macros, macroId);
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function addTrigger(sessionId: string, trigger: Omit<Trigger, 'id'>): string | undefined {
    if (!canMutateUserState()) return undefined;
    const session = findSession(sessionId);
    if (!session) return undefined;
    const triggers = [...session.triggers];
    const id = appendIdentifiedItem(triggers, trigger, createId);
    session.triggers = triggers;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
    return id;
  }

  function updateTrigger(
    sessionId: string,
    triggerId: string,
    patch: Partial<Omit<Trigger, 'id'>>,
  ) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    const triggers = [...session.triggers];
    if (!patchIdentifiedItem(triggers, triggerId, patch)) return;
    session.triggers = triggers;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function removeTrigger(sessionId: string, triggerId: string) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.triggers = removeIdentifiedItem(session.triggers, triggerId);
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function addHighlight(
    sessionId: string,
    highlight: Omit<HighlightRule, 'id'>,
  ): string | undefined {
    if (!canMutateUserState()) return undefined;
    const session = findSession(sessionId);
    if (!session) return undefined;
    const highlights = [...session.highlights];
    const id = appendIdentifiedItem(highlights, highlight, createId);
    session.highlights = highlights;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
    return id;
  }

  function updateHighlight(
    sessionId: string,
    highlightId: string,
    patch: Partial<Omit<HighlightRule, 'id'>>,
  ) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    const highlights = [...session.highlights];
    if (!patchIdentifiedItem(highlights, highlightId, patch)) return;
    session.highlights = highlights;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function removeHighlight(sessionId: string, highlightId: string) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.highlights = removeIdentifiedItem(session.highlights, highlightId);
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function addModbusRegister(
    sessionId: string,
    reg: Omit<ModbusRegister, 'id' | 'value' | 'values' | 'valueTs'>,
  ): string | undefined {
    if (!canMutateUserState()) return undefined;
    const session = findSession(sessionId);
    if (!session) return undefined;
    const id = createId();
    session.modbusRegisters = [
      ...session.modbusRegisters,
      normalizeModbusRegister({ ...reg, id, value: null, values: null, valueTs: null }),
    ];
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
    return id;
  }

  function updateModbusRegister(
    sessionId: string,
    regId: string,
    patch: Partial<Omit<ModbusRegister, 'id'>>,
  ) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    const index = session.modbusRegisters.findIndex((register) => register.id === regId);
    if (index === -1) return;
    session.modbusRegisters = session.modbusRegisters.map((register, itemIndex) =>
      itemIndex === index
        ? normalizeModbusRegister({ ...register, ...patch, id: register.id })
        : register,
    );
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function removeModbusRegister(sessionId: string, regId: string) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.modbusRegisters = session.modbusRegisters.filter((register) => register.id !== regId);
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setModbusRegisters(sessionId: string, registers: ModbusRegister[]) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.modbusRegisters = normalizeModbusRegisters(registers);
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  /** Runtime values deliberately do not schedule a persisted snapshot. */
  function setModbusRegisterValues(
    sessionId: string,
    values: Array<{ id: string; value: number; values?: number[] | null; valueTs: number }>,
  ) {
    const session = findSession(sessionId);
    if (!session || values.length === 0) return;
    const byId = new Map(values.map((value) => [value.id, value]));
    session.modbusRegisters = session.modbusRegisters.map((register) => {
      const hit = byId.get(register.id);
      if (!hit) return register;
      return {
        ...register,
        value: hit.value,
        values: hit.values === undefined ? register.values : hit.values,
        valueTs: hit.valueTs,
      };
    });
  }

  function addLogAiMessage(sessionId: string, message: Omit<AiChatMessage, 'id' | 'timestamp'>) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    const startPosition = session.logAiMessages.length;
    const appended = decorateAiMessage({ ...message, id: createId(), timestamp: now() });
    session.logAiMessages = [...session.logAiMessages, appended];
    schedulePersist(sessionId);
    onAiMessageAppended(sessionId, appended, startPosition);
  }

  function clearLogAiMessages(sessionId: string) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.logAiMessages = [];
    schedulePersist(sessionId);
    onAiMessagesCleared(sessionId);
  }

  return {
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
    addModbusRegister,
    updateModbusRegister,
    removeModbusRegister,
    setModbusRegisters,
    setModbusRegisterValues,
    addLogAiMessage,
    clearLogAiMessages,
  };
}
