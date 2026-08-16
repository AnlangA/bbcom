// @vitest-environment happy-dom

import { flushPromises, mount, shallowMount, type VueWrapper } from '@vue/test-utils';
import { computed, nextTick, reactive, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Macro, SerialSession } from '../../src/types/index.ts';
import type { SessionRuntimeController } from '../../src/features/sessions/runtime/session-runtime-controller.ts';

const uiMocks = vi.hoisted(() => ({
  sessionStore: null as unknown,
  appStore: null as unknown,
  exportApi: null as unknown,
  workspace: null as unknown,
  requestClearFrames: vi.fn(),
  shortcuts: null as unknown,
  messages: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/stores/session-core', () => ({
  useSessionCoreStore: () => uiMocks.sessionStore,
}));

vi.mock('../../src/features/sessions', async () => {
  const { computed } = await import('vue');
  const store = () => uiMocks.sessionStore as ReturnType<typeof sessionStore>;
  return {
    useSessionCatalog: () => ({
      sessions: computed(() => store().sessions),
      activeSessionId: computed(() => store().activeSessionId),
      activeSession: computed(
        () =>
          store().sessions.find(
            (session: SerialSession) => session.id === store().activeSessionId,
          ) ?? null,
      ),
      workspaceRebindBySessionId: computed(() => store().workspaceRebindBySessionId),
      framesVersion: (sessionId: string) => store().getSessionFramesVersion(sessionId),
      activate: (sessionId: string) => store().setActiveSession(sessionId),
    }),
    useSessionCapture: (sessionId: string) => ({
      session: computed(
        () => store().sessions.find((session: SerialSession) => session.id === sessionId) ?? null,
      ),
      framesVersion: computed(() => store().getSessionFramesVersion(sessionId)),
      setPaused: (paused: boolean) => store().setCapturePaused(sessionId, paused),
    }),
    useSessionDocument: (sessionId: string) => ({
      session: computed(
        () => store().sessions.find((session: SerialSession) => session.id === sessionId) ?? null,
      ),
      ...store(),
    }),
    useSessionMutationPolicy: () => ({
      userMutationsAllowed: computed(() => store().userMutationsAllowed),
      runtimeCaptureAllowed: computed(() => store().runtimeCaptureAllowed),
      persistenceReadOnly: computed(() => false),
    }),
    useSessionWaveform: (sessionId: string) => ({
      state: computed(() => store().workspaceWaveformBySessionId[sessionId] ?? null),
      appendSamples: store().appendSessionWaveformSamples,
      replaceSamples: store().replaceSessionWaveformSamples,
      setChannelVisible: store().setSessionWaveformChannelVisible,
      setFrameCursor: store().setSessionWaveformFrameCursor,
      commitFrameIngest: store().commitSessionWaveformFrameIngest,
      reset: store().resetSessionWaveform,
    }),
  };
});

vi.mock('../../src/stores/app', () => ({
  useAppStore: () => uiMocks.appStore,
}));

vi.mock('../../src/composables/useSessionActions', () => ({
  useSessionActions: () => ({ requestClearFrames: uiMocks.requestClearFrames }),
}));

vi.mock('../../src/composables/useSessionShortcuts', () => ({
  useSessionShortcuts: (shortcuts: unknown) => {
    uiMocks.shortcuts = shortcuts;
  },
}));

vi.mock('../../src/composables/useExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/composables/useExport')>();
  return { ...actual, useExport: () => uiMocks.exportApi };
});

vi.mock('../../src/features/workspace/application', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/workspace/application')>();
  return { ...actual, useOptionalWorkspaceApplication: () => uiMocks.workspace };
});

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>();
  return {
    ...actual,
    useMessage: () => uiMocks.messages,
    NButton: {
      name: 'NButton',
      inheritAttrs: true,
      props: ['disabled', 'loading'],
      emits: ['click'],
      template:
        '<button class="n-button" :disabled="disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
    },
    NInput: {
      name: 'NInput',
      props: ['value', 'disabled'],
      emits: ['update:value'],
      template:
        '<input class="n-input" :value="value" :disabled="disabled" @input="$emit(\'update:value\', $event.target.value)" />',
    },
    NInputNumber: {
      name: 'NInputNumber',
      props: ['value', 'disabled'],
      emits: ['update:value'],
      template:
        '<input class="n-input-number" type="number" :value="value" :disabled="disabled" @input="$emit(\'update:value\', Number($event.target.value))" />',
    },
    NCheckbox: {
      name: 'NCheckbox',
      props: ['checked', 'disabled'],
      emits: ['update:checked'],
      template:
        '<label><input class="n-checkbox" type="checkbox" :checked="checked" :disabled="disabled" @change="$emit(\'update:checked\', $event.target.checked)" /><slot /></label>',
    },
    NModal: {
      name: 'NModal',
      inheritAttrs: true,
      props: ['show'],
      emits: ['update:show', 'close', 'after-leave'],
      template:
        '<section v-if="show" class="n-modal"><slot /><slot name="footer" /><button class="modal-close" @click="$emit(\'close\')" /></section>',
    },
    NProgress: {
      name: 'NProgress',
      props: ['percentage', 'status', 'processing'],
      template: '<div class="n-progress" :data-percentage="percentage" :data-status="status" />',
    },
  };
});

import MacroPanel from '../../src/components/send-panel/MacroPanel.vue';
import ExportDialog from '../../src/components/session/ExportDialog.vue';
import SessionView from '../../src/components/session/SessionView.vue';
import WorkspacePanel from '../../src/components/workspace/WorkspacePanel.vue';

function componentSetup<T>(wrapper: VueWrapper): T {
  return (wrapper.vm.$ as unknown as { setupState: T }).setupState;
}

function serialSession(overrides: Partial<SerialSession> = {}): SerialSession {
  return {
    id: 'session-a',
    portName: 'COM1',
    portConfig: {
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      rxFrameGapMs: 5,
      dtr: false,
      rts: false,
    },
    isConnected: true,
    frames: [
      { id: 'rx', direction: 'RX', timestamp: 1_000, data: new Uint8Array([1, 2]) },
      { id: 'tx', direction: 'TX', timestamp: 2_000, data: new Uint8Array([3]) },
    ],
    pausedFrames: [],
    capturePaused: false,
    txBytes: 1,
    rxBytes: 2,
    txFrames: 1,
    rxFrames: 1,
    startTime: null,
    sendHistory: [],
    sendDraft: '',
    quickCommands: [],
    macros: [],
    triggers: [],
    highlights: [],
    parserState: { config: { kind: 'fixed', frameSize: 1 }, presetId: null },
    modbusRegisters: [],
    modbusConfig: { enabled: false, transport: 'rtu', pollIntervalMs: 1000, timeoutMs: 500 },
    waveformSourceMode: 'text',
    autoLogEnabled: false,
    logPath: null,
    terminalAiModel: 'glm-4.5-air',
    logAiModel: 'glm-4.5-air',
    logAiContextMode: 'latest-10k',
    logAiFrameLimit: 200,
    logAiMessages: [],
    ...overrides,
  } as SerialSession;
}

function sessionStore(session: SerialSession) {
  return reactive({
    sessions: [session],
    activeSessionId: session.id as string | null,
    userMutationsAllowed: true,
    runtimeCaptureAllowed: true,
    workspaceRebindBySessionId: {} as Record<string, unknown>,
    workspaceWaveformBySessionId: {} as Record<string, unknown>,
    getSessionFramesVersion: vi.fn(() => 7),
    addMacro: vi.fn(),
    updateMacro: vi.fn(),
    removeMacro: vi.fn(),
    setCapturePaused: vi.fn(),
    setActiveSession: vi.fn(),
    appendSessionWaveformSamples: vi.fn(),
    replaceSessionWaveformSamples: vi.fn(),
    setSessionWaveformChannelVisible: vi.fn(),
    setSessionWaveformFrameCursor: vi.fn(),
    commitSessionWaveformFrameIngest: vi.fn(),
    resetSessionWaveform: vi.fn(),
    setSendDraft: vi.fn(),
    clearSendHistory: vi.fn(),
    addQuickCommand: vi.fn(),
    removeQuickCommand: vi.fn(),
  });
}

function appStore() {
  return reactive({
    displayMode: 'hex' as const,
    toggleAutoScroll: vi.fn(),
    toggleShowTimestamp: vi.fn(),
  });
}

beforeEach(() => {
  uiMocks.sessionStore = sessionStore(serialSession());
  uiMocks.appStore = appStore();
  uiMocks.workspace = null;
  uiMocks.exportApi = {
    isExporting: ref(false),
    progress: ref({
      phase: 'idle',
      totalFrames: 0,
      totalRawBytes: 0,
      completedFrames: 0,
      completedRawBytes: 0,
      outputBytes: 0,
      durationMs: 0,
    }),
    cancelExport: vi.fn(),
    resetExportProgress: vi.fn(),
    exportData: vi.fn(),
  };
  uiMocks.requestClearFrames.mockReset();
  uiMocks.shortcuts = null;
  for (const mock of Object.values(uiMocks.messages)) mock.mockReset();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:macro-library'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  vi.restoreAllMocks();
});

interface MacroPanelSetup {
  runningMacroId: string | null;
  editing: boolean;
  editingId: string | null;
  draft: { name: string; steps: Array<{ data: string; isHex: boolean; delayMs: number }> };
  runMacro: (macro: Macro) => Promise<void>;
  startCreate: () => void;
  startEdit: (macro: Macro) => void;
  cancelEdit: () => void;
  addStep: () => void;
  removeStep: (index: number) => void;
  save: () => void;
  remove: (id: string) => void;
  exportLibrary: () => Promise<void>;
  importLibrary: () => void;
  onFilePicked: (event: Event) => Promise<void>;
}

describe('MacroPanel', () => {
  test('creates, edits, removes, runs, stops, imports, and exports macros', async () => {
    const macro: Macro = {
      id: 'macro-one',
      name: 'Handshake',
      steps: [{ data: 'AT', isHex: false, delayMs: 10 }],
    };
    const emptyMacro: Macro = { id: 'macro-empty', name: 'Empty', steps: [] };
    const store = sessionStore(serialSession({ macros: [macro, emptyMacro] }));
    uiMocks.sessionStore = store;
    const run = vi.fn();
    const abort = vi.fn();
    const runner = {
      running: ref(false),
      status: computed(() => 'idle' as const),
      run,
      abort,
    } as unknown as SessionRuntimeController['macro'];
    const wrapper = mount(MacroPanel, {
      props: { sessionId: 'session-a', runner, disabled: false },
    });
    const setup = componentSetup<MacroPanelSetup>(wrapper);
    expect(wrapper.findAll('.macro-item')).toHaveLength(2);

    setup.startCreate();
    await nextTick();
    expect(wrapper.find('.macro-form').exists()).toBe(true);
    setup.draft.name = '  New macro  ';
    setup.draft.steps[0].data = 'PING';
    setup.addStep();
    setup.draft.steps[1].data = 'PONG';
    setup.removeStep(1);
    setup.save();
    expect(store.addMacro).toHaveBeenCalledWith('session-a', {
      name: 'New macro',
      steps: [{ data: 'PING', isHex: false, delayMs: 0 }],
    });

    setup.startEdit(macro);
    setup.draft.name = 'Updated';
    setup.save();
    expect(store.updateMacro).toHaveBeenCalledWith(
      'session-a',
      'macro-one',
      expect.objectContaining({ name: 'Updated' }),
    );
    setup.startCreate();
    setup.draft.name = '';
    setup.save();
    expect(store.addMacro).toHaveBeenCalledTimes(1);
    setup.cancelEdit();
    setup.remove('macro-one');
    expect(store.removeMacro).toHaveBeenCalledWith('session-a', 'macro-one');

    run.mockResolvedValueOnce({ completed: 1, failedAt: 1, aborted: false });
    await setup.runMacro(macro);
    expect(uiMocks.messages.success).toHaveBeenCalled();
    run.mockResolvedValueOnce({ completed: 0, failedAt: 1, aborted: true });
    await setup.runMacro(macro);
    expect(uiMocks.messages.info).toHaveBeenCalled();
    run.mockResolvedValueOnce({ completed: 0, failedAt: 0, aborted: false });
    await setup.runMacro(macro);
    expect(uiMocks.messages.warning).toHaveBeenCalled();

    runner.running.value = true;
    setup.runningMacroId = null;
    await setup.runMacro(macro);
    runner.running.value = false;
    setup.runningMacroId = macro.id;
    await setup.runMacro(macro);
    setup.runningMacroId = 'another-macro';
    await setup.runMacro(macro);
    expect(abort).toHaveBeenCalledTimes(2);
    setup.runningMacroId = null;
    await wrapper.setProps({ disabled: true });
    await setup.runMacro(macro);
    await wrapper.setProps({ disabled: false });
    await setup.runMacro(emptyMacro);
    expect(run).toHaveBeenCalledTimes(3);

    const write = vi.fn();
    const close = vi.fn();
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: vi.fn(async () => ({
        createWritable: async () => ({ write, close }),
      })),
    });
    await setup.exportLibrary();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('macro-library'));
    expect(close).toHaveBeenCalledOnce();

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: vi.fn(async () => Promise.reject(new DOMException('cancelled', 'AbortError'))),
    });
    const successCount = uiMocks.messages.success.mock.calls.length;
    await setup.exportLibrary();
    expect(uiMocks.messages.success).toHaveBeenCalledTimes(successCount);

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: vi.fn(async () => Promise.reject(new Error('fallback'))),
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await setup.exportLibrary();
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:macro-library');

    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    setup.importLibrary();
    expect(inputClick).toHaveBeenCalled();
    const validLibrary = JSON.stringify({
      app: 'bbcom',
      kind: 'macro-library',
      version: 1,
      macros: [{ name: 'Imported', steps: [{ data: 'OK', isHex: false, delayMs: 0 }] }],
    });
    const validTarget = {
      files: [{ text: async () => validLibrary }],
      value: 'chosen.json',
    };
    await setup.onFilePicked({ target: validTarget } as unknown as Event);
    expect(validTarget.value).toBe('');
    expect(store.addMacro).toHaveBeenCalledWith(
      'session-a',
      expect.objectContaining({ name: 'Imported' }),
    );
    await setup.onFilePicked({ target: { files: [], value: 'none' } } as unknown as Event);
    await setup.onFilePicked({
      target: { files: [{ text: async () => '{bad' }], value: 'bad.json' },
    } as unknown as Event);
    expect(uiMocks.messages.error).toHaveBeenCalled();

    store.sessions[0].macros = [];
    await setup.exportLibrary();
    wrapper.unmount();
  });
});

interface ExportDialogSetup {
  format: 'txt' | 'csv' | 'jsonl' | 'bin';
  direction: 'all' | 'TX' | 'RX';
  timePreset: 'all' | 'last-1m' | 'last-5m' | 'custom';
  customStartMs: number | null;
  customEndMs: number | null;
  customStartInput: string;
  customEndInput: string;
  validationMessage: string;
  progressPercentage: number;
  formatDateTimeLocal: (timestamp: number | null) => string;
  parseDateTimeLocal: (value: string) => number | null;
  confirm: () => void;
}

const AppSelectStub = {
  name: 'AppSelect',
  props: ['value', 'options', 'disabled'],
  emits: ['update:value'],
  template:
    '<select class="app-select-stub" :value="value" :disabled="disabled" @change="$emit(\'update:value\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
};

function idleProgress() {
  return {
    phase: 'idle' as const,
    totalFrames: 0,
    totalRawBytes: 0,
    completedFrames: 0,
    completedRawBytes: 0,
    outputBytes: 0,
    durationMs: 0,
  };
}

describe('ExportDialog', () => {
  test('resets filters, validates all size limits, reports progress, and emits stable snapshots', async () => {
    const frames = serialSession().frames;
    const wrapper = mount(ExportDialog, {
      props: { show: true, frames, isExporting: false, progress: idleProgress() },
      global: { stubs: { AppSelect: AppSelectStub } },
    });
    const setup = componentSetup<ExportDialogSetup>(wrapper);
    expect(wrapper.findAll('.app-select-stub')).toHaveLength(3);
    setup.format = 'csv';
    setup.direction = 'RX';
    setup.confirm();
    expect(wrapper.emitted('confirm')?.[0]?.[0]).toMatchObject({
      choice: 'csv',
      snapshot: { preview: { frameCount: 1, rawBytes: 2 } },
    });

    expect(setup.formatDateTimeLocal(null)).toBe('');
    expect(setup.formatDateTimeLocal(Number.POSITIVE_INFINITY)).toBe('');
    expect(setup.formatDateTimeLocal(0)).toContain('1970');
    expect(setup.parseDateTimeLocal('')).toBeNull();
    expect(setup.parseDateTimeLocal('not-a-date')).toBeNull();
    expect(setup.parseDateTimeLocal('2025-01-02T03:04:05.006')).not.toBeNull();

    setup.timePreset = 'custom';
    setup.customStartInput = '2025-01-02T03:04:05.006';
    setup.customEndInput = '2025-01-01T03:04:05.006';
    await nextTick();
    expect(setup.validationMessage).not.toBe('');
    const emittedBeforeGuard = wrapper.emitted('confirm')?.length ?? 0;
    setup.confirm();
    expect(wrapper.emitted('confirm')?.length ?? 0).toBe(emittedBeforeGuard);

    setup.customEndInput = '2025-01-03T03:04:05.006';
    await wrapper.setProps({ frames: [] });
    expect(setup.validationMessage).not.toBe('');

    setup.timePreset = 'all';
    const common = { id: 'large', direction: 'RX' as const, timestamp: 1 };
    const sharedByte = new Uint8Array([1]);
    await wrapper.setProps({
      frames: Array.from({ length: 100_001 }, (_, index) => ({
        ...common,
        id: String(index),
        data: sharedByte,
      })),
    });
    expect(setup.validationMessage).not.toBe('');

    const twoMiB = { byteLength: 2 * 1024 * 1024 } as unknown as Uint8Array;
    await wrapper.setProps({
      frames: Array.from({ length: 65 }, (_, index) => ({
        ...common,
        id: String(index),
        data: twoMiB,
      })),
    });
    expect(setup.validationMessage).not.toBe('');

    await wrapper.setProps({
      frames: [
        {
          ...common,
          data: { byteLength: 2 * 1024 * 1024 + 1 } as unknown as Uint8Array,
        },
      ],
    });
    expect(setup.validationMessage).not.toBe('');

    setup.direction = 'TX';
    setup.timePreset = 'last-1m';
    setup.customStartMs = 1;
    setup.customEndMs = 2;
    await wrapper.setProps({ show: false });
    await wrapper.setProps({ show: true, frames });
    expect(setup.direction).toBe('all');
    expect(setup.timePreset).toBe('all');
    expect(setup.customStartMs).toBeNull();
    expect(setup.customEndMs).toBeNull();

    await wrapper.setProps({
      isExporting: true,
      progress: {
        ...idleProgress(),
        phase: 'streaming',
        totalFrames: 2,
        completedFrames: 3,
      },
    });
    expect(setup.progressPercentage).toBe(100);
    expect(wrapper.find('.export-progress').exists()).toBe(true);
    await wrapper.setProps({
      isExporting: false,
      progress: {
        ...idleProgress(),
        phase: 'completed',
        totalFrames: 2,
        completedFrames: 2,
        outputBytes: 10,
        durationMs: 4,
      },
    });
    expect(wrapper.text()).toContain('10');
    await wrapper.setProps({ progress: idleProgress() });
    expect(setup.progressPercentage).toBe(0);

    await wrapper.find('.modal-close').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    wrapper.unmount();
  });
});

function runtimeController() {
  const detach = vi.fn();
  const method = () => vi.fn();
  const modbus = {
    modbusBusy: ref(false),
    modbusStatusText: computed(() => 'ready'),
    modbusStatusClass: computed(() => 'ok'),
    waveformChannelLabels: computed(() => ['CH1']),
    writeSourceInput: ref<HTMLInputElement | null>(null),
    writeSourceName: ref<string | null>(null),
    master: { replaying: ref(false) },
    toggleWaveformSourceMode: method(),
    readAll: method(),
    readRow: method(),
    sendAll: method(),
    sendRow: method(),
    startReplay: method(),
    stopReplay: method(),
    pickWriteSource: method(),
    loadWriteSource: method(),
    clearWriteSource: method(),
    onWriteSourcePicked: method(),
    plotInWaveform: method(),
  };
  const runtime = {
    isConnected: ref(true),
    isConnecting: ref(false),
    reconnecting: ref(false),
    error: ref<string | null>(null),
    connectionFailure: ref(null),
    totalDroppedBytes: ref(0),
    sendingBreak: ref(false),
    viewMode: ref<'terminal' | 'waveform' | 'parser' | 'modbus'>('terminal'),
    looping: ref(false),
    parser: {
      frames: ref([]),
      droppedFrames: ref(0),
      droppedBytes: ref(0),
      throughputBps: ref(0),
      resetVersion: ref(0),
    },
    macro: {
      running: ref(false),
      status: computed(() => 'idle' as const),
      run: method(),
      abort: method(),
    },
    modbus,
    connect: method(),
    disconnect: method(),
    sendBreak: method(),
    send: vi.fn(async () => true),
    toggleAutoLog: method(),
    startSendLoop: method(),
    stopSendLoop: method(),
    attachView: vi.fn(() => detach),
  };
  return { runtime: runtime as unknown as SessionRuntimeController, modbus, detach };
}

interface SessionViewSetup {
  viewMode: 'terminal' | 'waveform' | 'parser' | 'modbus';
  exportDialogVisible: boolean;
  rebindDialogVisible: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  clear: () => void;
  togglePause: () => void;
  appendWaveformSamples: (samples: readonly unknown[]) => void;
  replaceWaveformSamples: (samples: readonly unknown[]) => void;
  setWaveformChannelVisibility: (channel: number, visible: boolean) => void;
  updateWaveformFrameCursor: (cursor: unknown) => void;
  commitWaveformFrameIngest: (ingest: unknown) => void;
  clearWaveform: (cursor: unknown) => void;
  showConflictingSession: (id: string) => void;
  setWriteSourceInput: (element: unknown) => void;
  handleSendBreak: () => Promise<void>;
  handleSend: (data: string, isHex: boolean) => Promise<unknown>;
  updateSendDraft: (value: string) => void;
  clearHistory: () => void;
  addQuickCommand: (command: unknown) => void;
  removeQuickCommand: (id: string) => void;
  toggleAutoScroll: () => void;
  toggleTimestamp: () => void;
  toggleAutoLog: () => Promise<void>;
  handleExport: (payload: unknown) => Promise<void>;
  openExportDialog: () => void;
  handleExportCancel: () => void;
}

describe('SessionView', () => {
  test('wires runtime, store, waveform, send, conflict, and export actions', async () => {
    const session = serialSession();
    const store = sessionStore(session);
    store.workspaceRebindBySessionId[session.id] = { previousPortName: 'COM0' };
    uiMocks.sessionStore = store;
    const app = appStore();
    uiMocks.appStore = app;
    const exportApi = uiMocks.exportApi as {
      isExporting: { value: boolean };
      cancelExport: ReturnType<typeof vi.fn>;
      resetExportProgress: ReturnType<typeof vi.fn>;
      exportData: ReturnType<typeof vi.fn>;
    };
    const { runtime, detach } = runtimeController();
    const wrapper = shallowMount(SessionView, {
      props: { session, runtime },
      global: {
        stubs: {
          SessionToolbar: { inheritAttrs: false, template: '<div />' },
          SessionRebindDialog: { inheritAttrs: false, template: '<div />' },
          DataPacketList: { inheritAttrs: false, template: '<div />' },
          SendPanel: { inheritAttrs: false, template: '<div />' },
        },
      },
    });
    const setup = componentSetup<SessionViewSetup>(wrapper);
    expect(runtime.attachView).toHaveBeenCalledOnce();

    await setup.connect();
    await setup.disconnect();
    setup.clear();
    setup.togglePause();
    expect(runtime.connect).toHaveBeenCalledOnce();
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    expect(uiMocks.requestClearFrames).toHaveBeenCalledWith(session.id);
    expect(store.setCapturePaused).toHaveBeenCalledWith(session.id, true);

    const samples = [{ timestamp: 1, channels: [2] }];
    const cursor = { consumed: 1, lastFrameId: 'rx' };
    setup.appendWaveformSamples(samples);
    setup.replaceWaveformSamples(samples);
    setup.setWaveformChannelVisibility(0, false);
    setup.updateWaveformFrameCursor(cursor);
    setup.commitWaveformFrameIngest({ mode: 'append', samples, cursor });
    setup.clearWaveform(cursor);
    expect(store.appendSessionWaveformSamples).toHaveBeenCalledWith(session.id, samples);
    expect(store.replaceSessionWaveformSamples).toHaveBeenCalledWith(session.id, samples);
    expect(store.setSessionWaveformChannelVisible).toHaveBeenCalledWith(session.id, 0, false);
    expect(store.setSessionWaveformFrameCursor).toHaveBeenCalledWith(session.id, cursor);
    expect(store.commitSessionWaveformFrameIngest).toHaveBeenCalledWith(
      session.id,
      'append',
      samples,
      cursor,
    );
    expect(store.resetSessionWaveform).toHaveBeenCalledWith(session.id, cursor);

    setup.showConflictingSession(session.id);
    setup.showConflictingSession('missing');
    expect(store.setActiveSession).toHaveBeenCalledOnce();
    const input = document.createElement('input');
    setup.setWriteSourceInput(input);
    setup.setWriteSourceInput({});
    await setup.handleSendBreak();
    await expect(setup.handleSend('AA', true)).resolves.toBe(true);
    expect(runtime.sendBreak).toHaveBeenCalledOnce();
    expect(runtime.send).toHaveBeenCalledWith('AA', true);

    setup.updateSendDraft('draft');
    setup.clearHistory();
    const quick = { name: 'Q', data: '01', isHex: true };
    setup.addQuickCommand(quick);
    setup.removeQuickCommand('quick-1');
    setup.toggleAutoScroll();
    setup.toggleTimestamp();
    await setup.toggleAutoLog();
    expect(store.setSendDraft).toHaveBeenCalledWith(session.id, 'draft');
    expect(store.clearSendHistory).toHaveBeenCalledWith(session.id);
    expect(store.addQuickCommand).toHaveBeenCalledWith(session.id, quick);
    expect(store.removeQuickCommand).toHaveBeenCalledWith(session.id, 'quick-1');
    expect(app.toggleAutoScroll).toHaveBeenCalledOnce();
    expect(app.toggleShowTimestamp).toHaveBeenCalledOnce();
    expect(runtime.toggleAutoLog).toHaveBeenCalledOnce();

    setup.openExportDialog();
    expect(exportApi.resetExportProgress).toHaveBeenCalledOnce();
    expect(setup.exportDialogVisible).toBe(true);
    setup.handleExportCancel();
    expect(setup.exportDialogVisible).toBe(false);
    exportApi.isExporting.value = true;
    setup.handleExportCancel();
    expect(exportApi.cancelExport).toHaveBeenCalledOnce();
    exportApi.isExporting.value = false;

    const payload = {
      snapshot: {
        frames: session.frames,
        preview: { frameCount: 2, rawBytes: 3, maxFrameBytes: 2 },
      },
      choice: 'txt',
    };
    exportApi.exportData.mockResolvedValueOnce({ ok: true });
    setup.exportDialogVisible = true;
    await setup.handleExport(payload);
    expect(uiMocks.messages.success).toHaveBeenCalled();
    expect(setup.exportDialogVisible).toBe(false);
    exportApi.exportData.mockResolvedValueOnce({ ok: false, cancelled: true });
    setup.exportDialogVisible = true;
    await setup.handleExport(payload);
    expect(setup.exportDialogVisible).toBe(false);
    exportApi.exportData.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    await setup.handleExport(payload);
    expect(uiMocks.messages.error).toHaveBeenCalled();
    exportApi.exportData.mockResolvedValueOnce({ ok: false });
    await setup.handleExport(payload);

    setup.rebindDialogVisible = true;
    await nextTick();
    wrapper.unmount();
    expect(detach).toHaveBeenCalledOnce();
  });
});

interface WorkspaceSetup {
  applicationSnapshot: Record<string, unknown>;
  librarySnapshot: Record<string, unknown>;
  showCreate: boolean;
  showImport: boolean;
  showExport: boolean;
  projectName: string;
  passphrase: string;
  passphraseConfirmation: string;
  openProject: (workspaceId: string) => Promise<void>;
  createProject: () => Promise<void>;
  beginImport: () => void;
  cancelImport: () => void;
  importPlaintext: () => Promise<void>;
  importEncrypted: () => Promise<void>;
  exportPlaintext: () => Promise<void>;
  exportEncrypted: () => Promise<void>;
  cancelProjectExport: () => Promise<void>;
  clearPassphrases: () => void;
}

function applicationSnapshot() {
  return {
    status: 'ready',
    currentWorkspace: { workspaceId: 'workspace-a', name: 'Lab' },
    saveHealth: 'clean',
    acceptsSaves: true,
    acceptsPersistenceEvents: true,
    readOnly: false,
    recoveryRequired: false,
    hydrating: false,
    exporting: false,
    messageKey: null,
    unsavedMutationCount: 0,
  };
}

function coordinatorSnapshot() {
  return {
    library: {
      status: 'ready',
      activeWorkspaceId: 'workspace-a',
      messageKey: null,
      actions: {
        newProject: { id: 'new-project', enabled: true, busy: false },
        openProject: { id: 'open-project', enabled: true, busy: false },
        importProject: { id: 'import-project', enabled: true, busy: false },
      },
      recentProjects: [],
      projects: [
        { workspaceId: 'workspace-a', name: 'Lab', active: true, saveHealth: 'clean' },
        { workspaceId: 'workspace-b', name: 'Bench', active: false, saveHealth: 'dirty' },
      ],
    },
    activeWorkspace: null,
    navigationAction: null as string | null,
    exporting: false,
    acceptsMutations: true,
  };
}

describe('WorkspacePanel', () => {
  test('covers catalog subscriptions and all project/import/export outcomes', async () => {
    let appListener: ((snapshot: ReturnType<typeof applicationSnapshot>) => void) | null = null;
    let coordinatorListener: ((snapshot: ReturnType<typeof coordinatorSnapshot>) => void) | null =
      null;
    const stopApplication = vi.fn();
    const stopCoordinator = vi.fn();
    const appSnapshot = applicationSnapshot();
    const library = coordinatorSnapshot();
    const application = {
      snapshot: () => appSnapshot,
      subscribe: vi.fn((listener: typeof appListener) => {
        appListener = listener;
        return stopApplication;
      }),
      openWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      importWorkspace: vi.fn(),
      exportWorkspace: vi.fn(),
      cancelActivation: vi.fn(),
      cancelExport: vi.fn(),
    };
    const coordinator = {
      snapshot: () => library,
      subscribe: vi.fn((listener: typeof coordinatorListener) => {
        coordinatorListener = listener;
        return stopCoordinator;
      }),
      refreshCatalog: vi.fn(async () => undefined),
    };
    uiMocks.workspace = { application, coordinator };
    const wrapper = mount(WorkspacePanel);
    await flushPromises();
    const setup = componentSetup<WorkspaceSetup>(wrapper);
    expect(coordinator.refreshCatalog).toHaveBeenCalledOnce();
    expect(wrapper.findAll('.workspace-recent')).toHaveLength(2);

    application.openWorkspace.mockResolvedValueOnce({
      outcome: 'failed',
      messageKey: 'workspace.open_failed',
    });
    await setup.openProject('workspace-b');
    expect(uiMocks.messages.error).toHaveBeenCalled();

    setup.projectName = '   ';
    await setup.createProject();
    expect(application.createWorkspace).not.toHaveBeenCalled();
    setup.projectName = '  New Lab  ';
    setup.showCreate = true;
    application.createWorkspace.mockResolvedValueOnce({ outcome: 'completed' });
    await setup.createProject();
    expect(application.createWorkspace).toHaveBeenCalledWith('New Lab');
    expect(setup.showCreate).toBe(false);
    setup.projectName = 'Broken';
    application.createWorkspace.mockResolvedValueOnce({
      outcome: 'failed',
      messageKey: 'workspace.create_failed',
    });
    await setup.createProject();

    setup.beginImport();
    expect(setup.showImport).toBe(true);
    library.navigationAction = 'import';
    coordinatorListener?.(library);
    setup.cancelImport();
    expect(application.cancelActivation).toHaveBeenCalledOnce();
    library.navigationAction = null;
    coordinatorListener?.(library);
    setup.cancelImport();
    expect(application.cancelActivation).toHaveBeenCalledOnce();

    setup.showImport = true;
    application.importWorkspace.mockResolvedValueOnce({ outcome: 'completed' });
    await setup.importPlaintext();
    expect(application.importWorkspace).toHaveBeenCalledWith({ mode: 'plaintext' });
    expect(setup.showImport).toBe(false);
    application.importWorkspace.mockResolvedValueOnce({
      outcome: 'failed',
      messageKey: 'workspace.import_failed',
    });
    await setup.importPlaintext();
    setup.passphrase = 'short';
    await setup.importEncrypted();
    expect(application.importWorkspace).toHaveBeenCalledTimes(2);
    setup.passphrase = 'long-enough-passphrase';
    application.importWorkspace.mockResolvedValueOnce({ outcome: 'completed' });
    await setup.importEncrypted();
    expect(application.importWorkspace).toHaveBeenLastCalledWith({
      mode: 'age-passphrase',
      passphrase: 'long-enough-passphrase',
    });

    setup.showExport = true;
    application.exportWorkspace.mockResolvedValueOnce({ outcome: 'completed' });
    await setup.exportPlaintext();
    expect(application.exportWorkspace).toHaveBeenCalledWith('Lab.bbcom', { mode: 'plaintext' });
    expect(setup.showExport).toBe(false);
    appSnapshot.currentWorkspace = null;
    appListener?.(appSnapshot);
    await setup.exportPlaintext();
    setup.passphrase = 'matching-passphrase';
    setup.passphraseConfirmation = 'matching-passphrase';
    await setup.exportEncrypted();
    expect(application.exportWorkspace).toHaveBeenCalledTimes(1);
    appSnapshot.currentWorkspace = { workspaceId: 'workspace-a', name: 'Lab' };
    appListener?.(appSnapshot);
    setup.passphraseConfirmation = 'mismatch-passphrase';
    await setup.exportEncrypted();
    expect(application.exportWorkspace).toHaveBeenCalledTimes(1);
    setup.passphraseConfirmation = 'matching-passphrase';
    application.exportWorkspace.mockResolvedValueOnce({ outcome: 'completed' });
    await setup.exportEncrypted();
    expect(application.exportWorkspace).toHaveBeenLastCalledWith('Lab.bbcom', {
      mode: 'age-passphrase',
      passphrase: 'matching-passphrase',
    });

    setup.showExport = true;
    application.cancelExport.mockResolvedValueOnce(null);
    await setup.cancelProjectExport();
    expect(setup.showExport).toBe(false);
    setup.showExport = true;
    application.cancelExport.mockResolvedValueOnce({ outcome: 'completed' });
    await setup.cancelProjectExport();
    expect(uiMocks.messages.info).toHaveBeenCalled();
    setup.showExport = true;
    application.cancelExport.mockResolvedValueOnce({
      outcome: 'failed',
      messageKey: 'workspace.export_failed',
    });
    await setup.cancelProjectExport();
    expect(setup.showExport).toBe(true);
    expect(uiMocks.messages.error).toHaveBeenCalledWith(expect.any(String));

    appListener?.({ ...appSnapshot, hydrating: true, messageKey: 'workspace.hydrating' });
    coordinatorListener?.({ ...library, exporting: true });
    await nextTick();
    expect(wrapper.find('.workspace-error').exists()).toBe(true);
    setup.clearPassphrases();
    expect(setup.passphrase).toBe('');
    expect(setup.passphraseConfirmation).toBe('');
    wrapper.unmount();
    expect(stopApplication).toHaveBeenCalledOnce();
    expect(stopCoordinator).toHaveBeenCalledOnce();
  });

  test('renders nothing and safely no-ops every action without an application context', async () => {
    uiMocks.workspace = null;
    const wrapper = mount(WorkspacePanel);
    const setup = componentSetup<WorkspaceSetup>(wrapper);
    expect(wrapper.find('.workspace-panel').exists()).toBe(false);
    await setup.openProject('workspace-a');
    setup.projectName = 'Name';
    await setup.createProject();
    setup.beginImport();
    setup.cancelImport();
    await setup.importPlaintext();
    setup.passphrase = 'long-enough-passphrase';
    await setup.importEncrypted();
    await setup.exportPlaintext();
    setup.passphraseConfirmation = 'long-enough-passphrase';
    await setup.exportEncrypted();
    await setup.cancelProjectExport();
    wrapper.unmount();
  });
});
