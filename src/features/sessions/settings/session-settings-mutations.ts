import type { ParserConfig } from '../../../lib/protocol-parser';
import { cloneParserConfig } from '../../../lib/session-persistence';
import { normalizeLogAiFrameLimit } from '../../../lib/session-store-helpers';
import { cloneModbusConfig } from '../../../lib/modbus';
import { cloneSerialShellConfig } from '../../../lib/serial-shell';
import { cloneMcumgrConfig } from '../../../lib/mcumgr';
import type { AiModel, LogAiContextMode } from '../../../types/ai';
import type { ModbusMasterConfig } from '../../../types/modbus';
import type { McumgrClientConfig } from '../../../types/mcumgr';
import type { SerialSession } from '../../../types/session';
import type { SerialShellConfig } from '../../../types/serial-shell';
import type { WaveformSourceMode } from '../../../types/waveform';

export interface SessionSettingsMutationDependencies {
  findSession(sessionId: string): SerialSession | undefined;
  /** Synchronous write barrier for persisted workspace configuration. */
  canMutateUserState?: () => boolean;
  schedulePersist(sessionId: string): void;
  onSessionChanged?: (sessionId: string) => void;
  /** Source mode persistence also resets waveform rows and their frame anchor. */
  onWaveformSourceModeChanged?: (sessionId: string) => void;
}

/** Session-owned scalar/configuration mutations, independent of Pinia/Vue. */
export function createSessionSettingsMutations({
  findSession,
  canMutateUserState = () => true,
  schedulePersist,
  onSessionChanged = () => undefined,
  onWaveformSourceModeChanged,
}: SessionSettingsMutationDependencies) {
  function setParserState(sessionId: string, config: ParserConfig, presetId?: string | null) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.parserState = {
      config: cloneParserConfig(config),
      presetId: presetId === undefined ? session.parserState.presetId : presetId,
    };
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setModbusConfig(sessionId: string, patch: Partial<ModbusMasterConfig>) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.modbusConfig = cloneModbusConfig({ ...session.modbusConfig, ...patch });
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setShellConfig(sessionId: string, patch: Partial<SerialShellConfig>) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.shellConfig = cloneSerialShellConfig({ ...session.shellConfig, ...patch });
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setMcumgrConfig(sessionId: string, patch: Partial<McumgrClientConfig>) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.mcumgrConfig = cloneMcumgrConfig({ ...session.mcumgrConfig, ...patch });
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setWaveformSourceMode(sessionId: string, mode: WaveformSourceMode) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    if (session.waveformSourceMode === mode) return;
    session.waveformSourceMode = mode;
    schedulePersist(sessionId);
    (onWaveformSourceModeChanged ?? onSessionChanged)(sessionId);
  }

  /** Set both fields together so the persisted auto-log state cannot diverge. */
  function setAutoLogTarget(sessionId: string, path: string | null) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.logPath = path;
    session.autoLogEnabled = path !== null;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setTerminalAiModel(sessionId: string, model: AiModel) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.terminalAiModel = model;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setLogAiModel(sessionId: string, model: AiModel) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.logAiModel = model;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setLogAiContextMode(sessionId: string, mode: LogAiContextMode) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.logAiContextMode = mode;
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  function setLogAiFrameLimit(sessionId: string, limit: number) {
    if (!canMutateUserState()) return;
    const session = findSession(sessionId);
    if (!session) return;
    session.logAiFrameLimit = normalizeLogAiFrameLimit(limit);
    schedulePersist(sessionId);
    onSessionChanged(sessionId);
  }

  return {
    setParserState,
    setModbusConfig,
    setShellConfig,
    setMcumgrConfig,
    setWaveformSourceMode,
    setAutoLogTarget,
    setTerminalAiModel,
    setLogAiModel,
    setLogAiContextMode,
    setLogAiFrameLimit,
  };
}
