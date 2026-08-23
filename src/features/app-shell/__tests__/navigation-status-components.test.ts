// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { config as testUtilsConfig, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SessionTabs from '@/features/sessions/ui/SessionTabs.vue';
import StatusBar from '@/features/app-shell/ui/StatusBar.vue';
import SendPanel from '@/features/send-panel/ui/SendPanel.vue';
import ToolsTabs from '@/features/send-panel/ui/ToolsTabs.vue';
import TriggerPanel from '@/features/send-panel/ui/TriggerPanel.vue';
import HighlightPanel from '@/features/send-panel/ui/HighlightPanel.vue';
import SessionToolbar from '@/features/sessions/ui/SessionToolbar.vue';
import ModbusHeader from '@/features/terminal/ui/ModbusHeader.vue';
import ModbusAddRegisterForm from '@/features/terminal/ui/ModbusAddRegisterForm.vue';
import ModbusRegisterRow from '@/features/terminal/ui/ModbusRegisterRow.vue';
import ParserConfigBar from '@/features/terminal/ui/ParserConfigBar.vue';
import ParserFrameDetail from '@/features/terminal/ui/ParserFrameDetail.vue';
import ChecksumPanel from '@/features/send-panel/ui/ChecksumPanel.vue';
import AppShell from '@/features/app-shell/ui/AppShell.vue';
import WaveformLegend from '@/features/terminal/ui/WaveformLegend.vue';
import WaveformPanel from '@/features/terminal/ui/WaveformPanel.vue';
import DataPacketList from '@/features/terminal/ui/DataPacketList.vue';
import ParserPanel from '@/features/terminal/ui/ParserPanel.vue';
import ModbusPanel from '@/features/terminal/ui/ModbusPanel.vue';
import CreateSessionDialog from '@/features/app-shell/ui/CreateSessionDialog.vue';
import SettingsModal from '@/features/app-shell/ui/SettingsModal.vue';
import App from '@/App.vue';
import AiWindow from '@/AiWindow.vue';
import { useAppStore } from '@/features/settings/store/app-store.ts';
import { useSessionStore } from '@/features/sessions/store/session-store.ts';
import { ensureLocaleLoaded, setLocale, t } from '@/lib/i18n.ts';
import type {
  PortConfig,
  SerialSession,
  SessionWaveformFrameCursor,
  SessionWaveformSampleInput,
} from '@/types/index.ts';
import { computed, ref } from 'vue';
import type { SessionRuntimeMacroController } from '@/features/sessions/runtime/session-runtime-controller.ts';
import {
  SESSION_APPLICATION_SERVICES_KEY,
  SessionRuntimeStatusRegistry,
} from '@/features/sessions';
import { useWorkspaceUiStore } from '@/features/workspace';

function fakeMacroRunner(): SessionRuntimeMacroController {
  return {
    running: ref(false),
    status: computed(() => 'idle' as const),
    run: vi.fn(async (macro) => ({
      completed: macro.steps.length,
      failedAt: macro.steps.length,
      aborted: false,
    })),
    abort: vi.fn(),
  };
}

const sessionActions = vi.hoisted(() => ({
  requestCloseSession: vi.fn(),
  createSession: vi.fn(),
}));

const nativeMocks = vi.hoisted(() => ({
  checksum: vi.fn(),
  resizeAiWindow: vi.fn(),
  tauriEmit: vi.fn(),
  tauriListen: vi.fn(),
  message: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

const portWatcher = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

const appShellMocks = vi.hoisted(() => ({
  toggleAiWindow: vi.fn(),
  shortcuts: null as {
    onCreateSession: () => void;
    onCloseSession: () => void;
  } | null,
}));

const packetVirtualMocks = vi.hoisted(() => ({
  measureElement: vi.fn(),
  onScroll: vi.fn(),
  scrollToIndex: vi.fn(),
  options: null as {
    itemKey?: (index: number) => string | number;
    rowSizeVersion?: { readonly value: unknown };
  } | null,
}));

vi.mock('@/features/sessions/application/use-session-actions', () => ({
  useSessionActions: () => sessionActions,
}));

vi.mock('@/features/serial/application/use-port-watcher', async () => {
  const { ref } = await import('vue');
  const ports = ref(['COM-A', 'COM-B']);
  return { usePortWatcher: () => ({ ports, refresh: portWatcher.refresh }) };
});

vi.mock('@/features/ai/application/use-ai-window-state', async () => {
  const { ref } = await import('vue');
  const visible = ref(false);
  return {
    useAiWindowState: () => ({ visible, toggle: appShellMocks.toggleAiWindow }),
  };
});

vi.mock('@/features/app-shell/application/use-app-shortcuts', () => ({
  useAppShortcuts: (handlers: { onCreateSession: () => void; onCloseSession: () => void }) => {
    appShellMocks.shortcuts = handlers;
  },
}));

vi.mock('@/features/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/sessions')>()),
  SessionRuntimeHost: { name: 'SessionRuntimeHost', template: '<div />' },
}));

vi.mock('@/features/terminal/application/use-packet-virtual-scroll', async () => {
  const { ref } = await import('vue');
  return {
    usePacketVirtualScroll: (options: NonNullable<typeof packetVirtualMocks.options>) => {
      packetVirtualMocks.options = options;
      return {
        scrollRef: ref<HTMLDivElement | null>(null),
        virtualItems: ref([
          { index: 0, start: 0, size: 28 },
          { index: 1, start: 28, size: 28 },
        ]),
        totalSize: ref(56),
        measureElement: packetVirtualMocks.measureElement,
        onScroll: packetVirtualMocks.onScroll,
        scrollToIndex: packetVirtualMocks.scrollToIndex,
      };
    },
  };
});

vi.mock('@tanstack/vue-virtual', async () => {
  const { ref } = await import('vue');
  return {
    useVirtualizer: () =>
      ref({
        getTotalSize: () => 32,
        getVirtualItems: () => [{ index: 0, start: 0, size: 32 }],
      }),
  };
});

vi.mock('@/features/platform/native/tauri-ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform/native/tauri-ipc')>();
  return {
    ...actual,
    calculateChecksum: nativeMocks.checksum,
    resizeAiWindow: nativeMocks.resizeAiWindow,
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  emit: nativeMocks.tauriEmit,
  listen: nativeMocks.tauriListen,
}));

vi.mock('@/features/ai/application/use-ai-session-bridge', () => ({
  useAiSessionBridge: vi.fn(),
}));

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>();
  return {
    ...actual,
    useMessage: () => nativeMocks.message,
    NDropdown: {
      name: 'NDropdown',
      props: ['options'],
      emits: ['select'],
      template:
        '<div class="dropdown-stub"><slot /><button v-for="option in options" :key="option.key" class="dropdown-option" :data-key="option.key" @click="$emit(\'select\', option.key)" /></div>',
    },
    NModal: {
      name: 'NModal',
      props: ['show'],
      emits: ['update:show', 'positive-click', 'negative-click'],
      template:
        '<div v-if="show" class="modal-stub"><slot /><slot name="footer" /><button class="modal-positive" @click="$emit(\'positive-click\')" /><button class="modal-negative" @click="$emit(\'negative-click\')" /><button class="modal-hide" @click="$emit(\'update:show\', false)" /></div>',
    },
    NSwitch: {
      name: 'NSwitch',
      props: ['value', 'checked'],
      emits: ['update:value', 'update:checked'],
      template:
        '<button class="switch-stub" @click="$emit(\'update:value\', !value); $emit(\'update:checked\', !checked)" />',
    },
  };
});

const config: PortConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  rxFrameGapMs: 5,
  dtr: false,
  rts: false,
};

function setupSessions() {
  localStorage.clear();
  const pinia = createPinia();
  setActivePinia(pinia);
  testUtilsConfig.global.plugins = [pinia];
  return useSessionStore();
}

beforeEach(() => {
  const pinia = createPinia();
  setActivePinia(pinia);
  testUtilsConfig.global.plugins = [pinia];
  sessionActions.requestCloseSession.mockReset();
  sessionActions.createSession.mockReset().mockReturnValue('created-session');
  nativeMocks.checksum.mockReset();
  nativeMocks.resizeAiWindow.mockReset();
  nativeMocks.tauriEmit.mockReset();
  nativeMocks.tauriListen.mockReset().mockResolvedValue(vi.fn());
  nativeMocks.message.error.mockReset();
  nativeMocks.message.warning.mockReset();
  nativeMocks.message.success.mockReset();
  portWatcher.refresh.mockReset();
  appShellMocks.toggleAiWindow.mockReset();
  appShellMocks.shortcuts = null;
  packetVirtualMocks.measureElement.mockReset();
  packetVirtualMocks.onScroll.mockReset();
  packetVirtualMocks.options = null;
});

afterEach(() => {
  vi.useRealTimers();
  setLocale('zh');
});

test('SessionTabs switches, reorders, closes, and exposes a useful live-frame tooltip', async () => {
  const sessions = setupSessions();
  const firstId = sessions.createSession('COM-A', config);
  const secondId = sessions.createSession('COM-B', config);
  sessions.setConnected(firstId, true);
  sessions.addFrame(firstId, { direction: 'RX', data: new Uint8Array([1, 2]) });

  const wrapper = mount(SessionTabs);
  const tabs = wrapper.findAll('.tab-item');
  expect(tabs).toHaveLength(2);
  expect(tabs[0].attributes('title')).toContain('COM-A | 115200 bps | 1');

  await tabs[1].trigger('click');
  expect(sessions.activeSessionId).toBe(secondId);

  const transfer = {
    effectAllowed: '',
    setData: vi.fn(),
  } as unknown as DataTransfer;
  await tabs[0].trigger('dragstart', { dataTransfer: transfer });
  await tabs[1].trigger('dragover');
  await tabs[1].trigger('drop');
  await tabs[0].trigger('dragend');
  expect(sessions.sessions.map((session) => session.id)).toEqual([secondId, firstId]);
  expect(transfer.setData).toHaveBeenCalledWith('text/plain', '0');

  await wrapper.find('.tab-add').trigger('click');
  expect(wrapper.emitted('create')).toEqual([[]]);

  await wrapper.findAll('.tab-close')[0].trigger('click');
  expect(sessionActions.requestCloseSession).toHaveBeenCalledWith(secondId);
});

test('StatusBar renders idle and connected telemetry, including reset-safe rates and dropped data', async () => {
  vi.useFakeTimers();
  const now = 1_000_000;
  vi.setSystemTime(now);
  const session = {
    id: 'status-session',
    portName: 'COM9',
    portConfig: config,
    isConnected: true,
    startTime: now - 3_723_000,
    txBytes: 100,
    rxBytes: 200,
    txFrames: 3,
    rxFrames: 4,
    frames: [{ id: 'f1', direction: 'RX', timestamp: now, data: new Uint8Array([1]) }],
    droppedBytes: 2048,
  } as unknown as SerialSession;
  const runtimeStatuses = new SessionRuntimeStatusRegistry();
  runtimeStatuses.publish(session.id, { phase: 'connected', droppedBytes: 2048, failure: null });

  const wrapper = mount(StatusBar, {
    props: { session, framesVersion: 0 },
    global: {
      provide: {
        [SESSION_APPLICATION_SERVICES_KEY as symbol]: { runtimeStatusRegistry: runtimeStatuses },
      },
    },
  });
  expect(wrapper.text()).not.toContain('COM9');
  expect(wrapper.text()).toContain('2.0 KB');
  expect(wrapper.text()).toContain('01:02:03');
  expect(wrapper.text()).toContain('1/10000');

  session.txBytes = 1_124;
  session.rxBytes = 2_248;
  session.frames.push({ id: 'f2', direction: 'TX', timestamp: now, data: new Uint8Array([2]) });
  await vi.advanceTimersByTimeAsync(1_000);
  await wrapper.vm.$nextTick();
  expect(wrapper.text()).toContain('TX 1.0 KB/s');
  expect(wrapper.text()).toContain('RX 2.0 KB/s');
  expect(wrapper.text()).toContain('1/s');

  // A clear/reset between samples must not produce a bogus negative rate.
  session.txBytes = 5;
  session.rxBytes = 7;
  session.frames.splice(0, session.frames.length);
  await vi.advanceTimersByTimeAsync(1_000);
  await wrapper.vm.$nextTick();
  expect(wrapper.text()).toContain('TX 5 B/s');
  expect(wrapper.text()).toContain('RX 7 B/s');

  await wrapper.setProps({ session: null, framesVersion: 1 });
  expect(wrapper.find('.no-session').text()).not.toBe('');
});

test('SendPanel sends text with the selected line ending, normalizes valid hexadecimal input, and stops loops', async () => {
  setupSessions();
  const app = useAppStore();
  app.setLineEnding('CRLF');
  const sent = vi.fn(async () => true);
  const startLoop = vi.fn(() => true);
  const stopLoop = vi.fn();
  const wrapper = mount(SendPanel, {
    props: {
      onSend: sent,
      onStartLoop: startLoop,
      onStopLoop: stopLoop,
      macroRunner: fakeMacroRunner(),
      looping: false,
      modelValue: 'AT',
      history: [],
      quickCommands: [],
    },
    global: { stubs: { ToolsTabs: true } },
  });

  await wrapper.find('.send-btn').trigger('click');
  await wrapper.vm.$nextTick();
  expect(sent).toHaveBeenCalledWith('AT\r\n', false);
  expect(wrapper.emitted('update:modelValue')).toContainEqual(['']);

  await wrapper.get('[role="checkbox"]').trigger('click');
  await wrapper.vm.$nextTick();
  await wrapper.setProps({ modelValue: 'aa0b' });
  await wrapper.find('textarea').trigger('blur');
  expect(wrapper.emitted('update:modelValue')).toContainEqual(['AA 0B']);

  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('循环'))!
    .trigger('click');
  await wrapper.vm.$nextTick();
  expect(startLoop).toHaveBeenCalledWith('aa0b', true);

  await wrapper.setProps({ looping: true });
  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('停止循环'))!
    .trigger('click');
  expect(stopLoop).toHaveBeenCalledTimes(1);
});

test('SendPanel appends a checksum when the native calculation succeeds and reports native failures', async () => {
  setupSessions();
  const app = useAppStore();
  app.setSendAsHex(true);
  nativeMocks.checksum
    .mockResolvedValueOnce({ result: 'CC' })
    .mockRejectedValueOnce(new Error('nope'));
  const sent = vi.fn(async () => true);
  const wrapper = mount(SendPanel, {
    props: {
      onSend: sent,
      onStartLoop: vi.fn(() => true),
      onStopLoop: vi.fn(),
      macroRunner: fakeMacroRunner(),
      looping: false,
      modelValue: 'AA',
      history: [],
      quickCommands: [],
    },
    global: { stubs: { ToolsTabs: true } },
  });

  const checksumSelect = wrapper.findAll('select')[1];
  // AppSelect carries the typed option in its indexed DOM values: CRC-8 is
  // option two after “none” and the one-byte checksum.
  await checksumSelect.setValue('2');
  await wrapper.find('.send-btn').trigger('click');
  await wrapper.vm.$nextTick();
  expect(nativeMocks.checksum).toHaveBeenCalledWith(new Uint8Array([0xaa]), 'CRC8');
  expect(sent).toHaveBeenCalledWith('AA CC', true);

  await wrapper.setProps({ modelValue: 'BB' });
  await wrapper.find('.send-btn').trigger('click');
  await wrapper.vm.$nextTick();
  expect(nativeMocks.message.warning).toHaveBeenCalledTimes(1);
  expect(sent).toHaveBeenLastCalledWith('BB', true);
});

test('ToolsTabs saves, sends, removes, and replays quick commands without running them while disabled', async () => {
  const sessions = setupSessions();
  const sessionId = sessions.createSession('COM-tools', config);
  const onSend = vi.fn(async () => true);
  const wrapper = mount(ToolsTabs, {
    props: {
      sessionId,
      modelValue: 'AT+PING',
      isHex: false,
      history: [{ data: 'AT+OLD', isHex: false, timestamp: 1 }],
      quickCommands: [{ id: 'quick-1', name: 'Ping', data: 'AT+PING', isHex: false }],
      onSend,
      macroRunner: fakeMacroRunner(),
    },
    global: {
      stubs: {
        MacroPanel: true,
        TriggerPanel: true,
        HighlightPanel: true,
      },
    },
  });

  const quickInput = wrapper.find('input');
  await quickInput.setValue('Named ping');
  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('保存快捷'))!
    .trigger('click');
  expect(wrapper.emitted('addQuickCommand')).toContainEqual([
    { name: 'Named ping', data: 'AT+PING', isHex: false },
  ]);

  await wrapper.find('.quick-item').trigger('click');
  expect(onSend).toHaveBeenCalledWith('AT+PING', false);
  await wrapper.find('.quick-remove').trigger('click');
  expect(wrapper.emitted('removeQuickCommand')).toEqual([['quick-1']]);

  await wrapper
    .findAll('[role="tab"]')
    .find((tab) => tab.text().includes('历史'))!
    .trigger('click');
  await wrapper.find('.history-item').trigger('click');
  expect(onSend).toHaveBeenLastCalledWith('AT+OLD', false);
  await wrapper.find('.history-clear').trigger('click');
  expect(wrapper.emitted('clearHistory')).toEqual([[]]);

  await wrapper.setProps({ disabled: true });
  await wrapper
    .findAll('[role="tab"]')
    .find((tab) => tab.text().includes('快捷'))!
    .trigger('click');
  await wrapper.find('.quick-item').trigger('click');
  expect(onSend).toHaveBeenCalledTimes(2);
});

test('TriggerPanel creates, edits, disables, and deletes a persisted trigger', async () => {
  const sessions = setupSessions();
  const sessionId = sessions.createSession('COM-trigger', config);
  const wrapper = mount(TriggerPanel, { props: { sessionId } });

  await wrapper.find('.trigger-add').trigger('click');
  const inputs = wrapper.findAll('input');
  await inputs[0].setValue('Login response');
  await inputs[1].setValue('login:');
  await inputs[2].setValue('root\\r\\n');
  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('保存'))!
    .trigger('click');
  expect(sessions.sessions[0].triggers).toHaveLength(1);
  expect(sessions.sessions[0].triggers[0]).toMatchObject({
    name: 'Login response',
    pattern: 'login:',
    response: 'root\\r\\n',
    enabled: true,
  });

  await wrapper.get('[role="checkbox"]').trigger('click');
  expect(sessions.sessions[0].triggers[0].enabled).toBe(false);

  await wrapper.find('.trigger-edit').trigger('click');
  await wrapper.findAll('input')[0].setValue('Updated login');
  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('更新'))!
    .trigger('click');
  expect(sessions.sessions[0].triggers[0].name).toBe('Updated login');

  // Two-step inline confirmation: first click arms, second confirms.
  await wrapper.find('.trigger-remove').trigger('click');
  await wrapper.find('.trigger-remove').trigger('click');
  expect(sessions.sessions[0].triggers).toHaveLength(0);
});

test('HighlightPanel creates, edits, toggles, and removes typed direction/color rules', async () => {
  const sessions = setupSessions();
  const sessionId = sessions.createSession('COM-highlight', config);
  const wrapper = mount(HighlightPanel, { props: { sessionId } });

  await wrapper.find('.highlight-add').trigger('click');
  const inputs = wrapper.findAll('input');
  await inputs[0].setValue('Errors');
  await inputs[1].setValue('ERROR');
  const selects = wrapper.findAll('select');
  await selects[0].setValue('2');
  await selects[1].setValue('1');
  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('保存'))!
    .trigger('click');
  expect(sessions.sessions[0].highlights).toHaveLength(1);
  expect(sessions.sessions[0].highlights[0]).toMatchObject({
    name: 'Errors',
    pattern: 'ERROR',
    direction: 'RX',
    color: 'red',
    enabled: true,
  });

  await wrapper.get('[role="checkbox"]').trigger('click');
  expect(sessions.sessions[0].highlights[0].enabled).toBe(false);

  await wrapper.find('.highlight-edit').trigger('click');
  await wrapper.findAll('input')[0].setValue('Updated errors');
  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('更新'))!
    .trigger('click');
  expect(sessions.sessions[0].highlights[0].name).toBe('Updated errors');

  // Two-step inline confirmation: first click arms, second confirms.
  await wrapper.find('.highlight-remove').trigger('click');
  await wrapper.find('.highlight-remove').trigger('click');
  expect(sessions.sessions[0].highlights).toHaveLength(0);
});

test('SessionToolbar reflects connection state and emits every terminal control action', async () => {
  const sessions = setupSessions();
  const sessionId = sessions.createSession('COM-toolbar', config);
  sessions.addFrame(sessionId, { direction: 'RX', data: new Uint8Array([1]) });
  const session = sessions.sessions[0];
  const props = {
    session,
    framesVersion: 0,
    isConnected: false,
    isConnecting: false,
    reconnecting: true,
    error: 'connection failed',
    totalDroppedBytes: 2048,
    sendingBreak: false,
    isExporting: false,
    viewMode: 'terminal' as const,
  };
  const wrapper = mount(SessionToolbar, { props });
  expect(wrapper.text()).toContain('connection failed');
  expect(wrapper.text()).not.toContain('2.0 KB');
  const connectButton = wrapper
    .findAll('button')
    .find((button) => button.text().includes(t('session.connect')));
  const clearButton = wrapper
    .findAll('button')
    .find((button) => button.text().includes(t('session.clear')));
  expect(connectButton).toBeDefined();
  expect(clearButton).toBeDefined();
  await connectButton!.trigger('click');
  await clearButton!.trigger('click');
  expect(wrapper.emitted('connect')).toEqual([[]]);
  expect(wrapper.emitted('clear')).toEqual([[]]);

  session.isConnected = true;
  await wrapper.setProps({ isConnected: true, viewMode: 'terminal' });
  const disconnectButton = wrapper
    .findAll('button')
    .find((button) => button.text().includes(t('session.disconnect')));
  const pauseButton = wrapper
    .findAll('button')
    .find((button) => button.text().includes(t('session.pause')));
  const breakButton = wrapper
    .findAll('button')
    .find((button) => button.text().includes(t('session.break')));
  expect(disconnectButton).toBeDefined();
  expect(pauseButton).toBeDefined();
  expect(breakButton).toBeDefined();
  await disconnectButton!.trigger('click');
  await pauseButton!.trigger('click');
  await breakButton!.trigger('click');
  await wrapper.get(`[aria-label="${t('toolbar.shell')}"]`).trigger('click');
  await wrapper.get(`[aria-label="${t('toolbar.waveform')}"]`).trigger('click');
  await wrapper.get(`[aria-label="${t('toolbar.autoScroll')}"]`).trigger('click');
  await wrapper.get(`[aria-label="${t('toolbar.timestamp')}"]`).trigger('click');
  await wrapper.get(`[aria-label="${t('toolbar.autoLog')}"]`).trigger('click');
  await wrapper.find('.toolbar-export-btn').trigger('click');
  expect(wrapper.emitted('disconnect')).toEqual([[]]);
  expect(wrapper.emitted('toggle-pause')).toEqual([[]]);
  expect(wrapper.emitted('send-break')).toEqual([[]]);
  expect(wrapper.emitted('update:viewMode')).toEqual([['shell'], ['waveform']]);
  expect(wrapper.emitted('toggle-auto-scroll')).toEqual([[]]);
  expect(wrapper.emitted('toggle-timestamp')).toEqual([[]]);
  expect(wrapper.emitted('toggle-auto-log')).toEqual([[]]);
  expect(wrapper.emitted('export')).toEqual([[]]);
});

test('ModbusHeader patches typed configuration and dispatches all visible transport actions', async () => {
  const wrapper = mount(ModbusHeader, {
    props: {
      config: {
        transport: 'rtu',
        enabled: false,
        pollIntervalMs: 1000,
        writeIntervalMs: 1200,
        timeoutMs: 500,
      },
      statusText: 'idle',
      statusClass: 'idle',
      busy: false,
      isConnected: true,
      replaying: false,
      hasWriteRegs: true,
      registersEmpty: false,
      writeSourceName: 'registers.json',
    },
  });

  await wrapper.find('select').setValue('1');
  await wrapper.get('[role="checkbox"]').trigger('click');
  const timingInputs = wrapper.findAll('.mb-timing-bar input');
  await timingInputs[0].setValue('900');
  await timingInputs[1].setValue('1100');
  await timingInputs[2].setValue('450');
  expect(wrapper.emitted('patch')).toEqual(
    expect.arrayContaining([
      [{ transport: 'pdu' }],
      [{ enabled: true }],
      [{ pollIntervalMs: 900 }],
      [{ writeIntervalMs: 1100 }],
      [{ timeoutMs: 450 }],
    ]),
  );

  await wrapper.find('.mb-close').trigger('click');
  const actionButtons = wrapper.findAll('.mb-actions-bar button');
  for (const button of actionButtons) await button.trigger('click');
  const timingButtons = wrapper.findAll('.mb-writesrc button');
  for (const button of timingButtons) await button.trigger('click');
  expect(wrapper.emitted('close')).toEqual([[]]);
  for (const event of [
    'read-all',
    'send-all',
    'replay',
    'load',
    'save',
    'pick-write-source',
    'clear-write-source',
  ]) {
    expect(wrapper.emitted(event)).toEqual([[]]);
  }

  await wrapper.setProps({ replaying: true });
  const stopReplayButton = wrapper
    .findAll('.mb-actions-bar button')
    .find((button) => button.text().includes(t('modbus.stopReplay')));
  expect(stopReplayButton).toBeDefined();
  await stopReplayButton!.trigger('click');
  expect(wrapper.emitted('stop-replay')).toEqual([[]]);
});

test('ModbusAddRegisterForm normalizes function/type choices and advances an accepted batch draft', async () => {
  const wrapper = mount(ModbusAddRegisterForm);
  const inputs = wrapper.findAll('input');
  await inputs[0].setValue('Coil bank');
  const selects = wrapper.findAll('select');
  // Function code 0x01 forces a bool type and the fixed bit quantity rules.
  await selects[0].setValue('0');
  await selects[2].setValue('3');
  await inputs[2].setValue('10');
  await inputs[3].setValue('4');
  await inputs[4].setValue('flags');
  await wrapper.find('button').trigger('click');
  expect(wrapper.emitted('add')).toEqual([
    [
      expect.objectContaining({
        name: 'Coil bank',
        functionCode: 0x01,
        type: 'bool',
        address: 10,
        quantity: 1,
        waveformChannel: 2,
        unit: 'flags',
      }),
    ],
  ]);
  expect(wrapper.findAll('input')[0].element.value).toBe('');
  expect(wrapper.findAll('input')[4].element.value).toBe('');
});

test('ParserConfigBar emits each delimiter, fixed, and length protocol configuration edit', async () => {
  const props = {
    presetId: null,
    presetOptions: [{ label: 'Modbus', value: 'modbus' }],
    kindOptions: [
      { label: 'Delimiter', value: 'delimiter' },
      { label: 'Fixed', value: 'fixed' },
      { label: 'Length', value: 'length' },
    ],
    lenSizeOptions: [
      { label: '1', value: 1 },
      { label: '2', value: 2 },
      { label: '4', value: 4 },
    ],
    kind: 'delimiter',
    delimiterHex: '0D 0A',
    includeDelimiter: false,
    fixedSize: 8,
    lenOffset: 2,
    lenSize: 2,
    lenBigEndian: true,
    lenAdjust: 3,
  };
  const wrapper = mount(ParserConfigBar, { props });
  const delimiterSelects = wrapper.findAll('select');
  await delimiterSelects[0].setValue('0');
  await delimiterSelects[1].setValue('1');
  await wrapper.find('input').setValue('AA BB');
  await wrapper.get('[role="checkbox"]').trigger('click');
  expect(wrapper.emitted('apply-preset')).toEqual([['modbus']]);
  expect(wrapper.emitted('update:kind')).toEqual([['fixed']]);
  expect(wrapper.emitted('update:delimiterHex')).toEqual([['AA BB']]);
  expect(wrapper.emitted('update:includeDelimiter')).toEqual([[true]]);

  await wrapper.setProps({ kind: 'fixed' });
  await wrapper.find('input').setValue('32');
  expect(wrapper.emitted('update:fixedSize')).toEqual([[32]]);

  await wrapper.setProps({ kind: 'length' });
  const lengthInputs = wrapper.findAll('input');
  await lengthInputs[0].setValue('4');
  await lengthInputs[1].setValue('9');
  await wrapper.findAll('select')[2].setValue('2');
  await wrapper.get('[role="checkbox"]').trigger('click');
  expect(wrapper.emitted('update:lenOffset')).toEqual([[4]]);
  expect(wrapper.emitted('update:lenAdjust')).toEqual([[9]]);
  expect(wrapper.emitted('update:lenSize')).toEqual([[4]]);
  expect(wrapper.emitted('update:lenBigEndian')).toEqual([[false]]);

  await wrapper.find('.pp-close').trigger('click');
  expect(wrapper.emitted('close')).toEqual([[]]);
});

test('ParserFrameDetail switches from its empty state to a dump and exposes both copy actions', async () => {
  const wrapper = mount(ParserFrameDetail, { props: { frame: null, dump: [] } });
  expect(wrapper.classes()).toContain('pp-detail-empty');
  await wrapper.setProps({
    frame: { offset: 42, data: new Uint8Array([0x41, 0x42]) },
    dump: [{ offset: 42, hex: '41 42', ascii: 'AB' }],
  });
  expect(wrapper.text()).toContain('42');
  expect(wrapper.text()).toContain('41 42');
  expect(wrapper.text()).toContain('AB');
  const buttons = wrapper.findAll('.detail-copy');
  await buttons[0].trigger('click');
  await buttons[1].trigger('click');
  expect(wrapper.emitted('copy')).toEqual([[]]);
  expect(wrapper.emitted('copy-ascii')).toEqual([[]]);
});

test('ModbusRegisterRow updates read and write register state while preserving typed row actions', async () => {
  const sessions = setupSessions();
  const sessionId = sessions.createSession('COM-row', config);
  const readId = sessions.addModbusRegister(sessionId, {
    name: 'Temperature',
    slaveAddress: 1,
    functionCode: 0x03,
    address: 12,
    quantity: 2,
    type: 'uint16',
    unit: '°C',
    waveformChannel: null,
    periodicRead: true,
    periodicWrite: false,
  })!;
  const options = {
    fcOptions: [
      { label: '01', value: 0x01 },
      { label: '03', value: 0x03 },
      { label: '06', value: 0x06 },
      { label: '10', value: 0x10 },
    ],
    channelOptions: [
      { label: 'off', value: -1 },
      { label: '0', value: 0 },
      { label: '1', value: 1 },
    ],
    typeOptions: [
      { label: 'u16', value: 'uint16' as const },
      { label: 'f32', value: 'float32-be' as const },
    ],
    bitTypeOptions: [{ label: 'bool', value: 'bool' as const }],
  };
  const readRow = mount(ModbusRegisterRow, {
    props: {
      reg: sessions.sessions[0].modbusRegisters.find((reg) => reg.id === readId)!,
      sessionId,
      busy: false,
      isConnected: true,
      flashed: true,
      alt: true,
      ...options,
    },
  });
  await readRow.findAll('input')[0].setValue('Temperature 2');
  await readRow.findAll('input')[1].setValue('2');
  await readRow.findAll('input')[2].setValue('20');
  await readRow.findAll('input')[3].setValue('3');
  await readRow.findAll('select')[2].setValue('2');
  await readRow.find('.rw-toggle').trigger('click');
  const currentRead = sessions.sessions[0].modbusRegisters.find((reg) => reg.id === readId)!;
  expect(currentRead).toMatchObject({
    name: 'Temperature 2',
    slaveAddress: 2,
    address: 20,
    quantity: 3,
    waveformChannel: 1,
    periodicRead: false,
    value: null,
  });
  for (const button of readRow.findAll('.row-btn')) await button.trigger('click');
  expect(readRow.emitted('plot')).toEqual([[]]);
  expect(readRow.emitted('read')).toEqual([[]]);
  expect(readRow.emitted('remove')).toEqual([[]]);
  expect(readRow.emitted('updateValueDraft')).toContainEqual([undefined]);

  const writeId = sessions.addModbusRegister(sessionId, {
    name: 'Setpoint',
    slaveAddress: 1,
    functionCode: 0x10,
    address: 30,
    quantity: 2,
    type: 'uint16',
    waveformChannel: 0,
    periodicRead: false,
    periodicWrite: true,
  })!;
  const writeRow = mount(ModbusRegisterRow, {
    props: {
      reg: sessions.sessions[0].modbusRegisters.find((reg) => reg.id === writeId)!,
      sessionId,
      busy: false,
      isConnected: true,
      flashed: false,
      alt: false,
      valueDraft: '7 8',
      ...options,
    },
  });
  const writeValueInput = writeRow.findAll('input')[4];
  await writeValueInput.setValue('7 8 9');
  await writeRow.find('.rw-toggle.w').trigger('click');
  const currentWrite = sessions.sessions[0].modbusRegisters.find((reg) => reg.id === writeId)!;
  expect(currentWrite).toMatchObject({
    value: 7,
    values: [7, 8, 9],
    periodicWrite: false,
  });
  for (const button of writeRow.findAll('.row-btn')) await button.trigger('click');
  expect(writeRow.emitted('plot')).toEqual([[]]);
  expect(writeRow.emitted('send')).toEqual([[]]);
  expect(writeRow.emitted('remove')).toEqual([[]]);
  expect(writeRow.emitted('updateValueDraft')).toContainEqual(['7 8 9']);
});

test('ChecksumPanel normalizes input and calculates through the native boundary', async () => {
  vi.useFakeTimers();
  nativeMocks.checksum.mockResolvedValue({ result: 'BEEF' });

  const wrapper = mount(ChecksumPanel);
  const checksumInput = wrapper.get('input');
  await checksumInput.setValue('aa bb');
  await checksumInput.trigger('blur');
  expect((checksumInput.element as HTMLInputElement).value).toBe('AA BB');
  await vi.advanceTimersByTimeAsync(150);
  await wrapper.vm.$nextTick();
  expect(nativeMocks.checksum).toHaveBeenCalledWith(new Uint8Array([0xaa, 0xbb]), 'CHECKSUM');
  expect(wrapper.find('.checksum-panel__result').text()).toContain('BEEF');

  await checksumInput.setValue('A');
  await vi.advanceTimersByTimeAsync(200);
  expect(nativeMocks.checksum).toHaveBeenCalledTimes(1);
});

test('AppShell handles layout controls, failure notifications, resize cleanup, and shortcuts around an empty workspace', async () => {
  const sessions = setupSessions();
  const workspaceUi = useWorkspaceUiStore();
  const wrapper = mount(AppShell, {
    global: {
      stubs: {
        SessionTabs: {
          template: '<button class="session-tabs-stub" @click="$emit(\'create\')">tabs</button>',
        },
        StatusBar: true,
        SessionRuntimeHost: true,
        CreateSessionDialog: true,
        SettingsModal: true,
        AiSettingsPanel: true,
      },
    },
  });
  expect(wrapper.find('.empty-state').exists()).toBe(true);
  expect(wrapper.find('.sidebar').attributes('style')).toContain('292px');

  const resizeHandle = wrapper.find('.resize-handle');
  expect(resizeHandle.attributes('role')).toBe('separator');
  expect(resizeHandle.attributes('aria-valuemin')).toBe('252');
  expect(resizeHandle.attributes('aria-valuemax')).toBe('340');
  await resizeHandle.trigger('keydown', { key: 'ArrowRight' });
  expect(workspaceUi.sidebarWidth).toBe(304);
  await resizeHandle.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
  expect(workspaceUi.sidebarWidth).toBe(328);
  await resizeHandle.trigger('keydown', { key: 'Home' });
  expect(workspaceUi.sidebarWidth).toBe(252);
  await resizeHandle.trigger('keydown', { key: 'End' });
  expect(workspaceUi.sidebarWidth).toBe(340);
  workspaceUi.setSidebarWidth(292);

  await wrapper.find('.collapse-btn').trigger('click');
  expect(workspaceUi.sidebarCollapsed).toBe(true);
  await wrapper.find('.collapse-btn').trigger('click');
  expect(workspaceUi.sidebarCollapsed).toBe(false);

  await wrapper.find('.ai-toggle').trigger('click');
  expect(appShellMocks.toggleAiWindow).toHaveBeenCalledTimes(1);
  expect(wrapper.find('.theme-toggle').exists()).toBe(false);
  expect(wrapper.find('.locale-toggle').exists()).toBe(false);

  await resizeHandle.trigger('mousedown', { clientX: 100 });
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: 132 }));
  expect(workspaceUi.sidebarWidth).toBe(324);
  document.dispatchEvent(new MouseEvent('mouseup'));
  expect(document.body.style.cursor).toBe('');
  expect(document.body.style.userSelect).toBe('');

  window.dispatchEvent(
    new CustomEvent('bbcom:auto-log-failure', {
      detail: { sessionId: 'one', reason: 'disk-error' },
    }),
  );
  expect(nativeMocks.message.error).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new CustomEvent('bbcom:auto-log-failure', { detail: { sessionId: 4 } }));
  expect(nativeMocks.message.error).toHaveBeenCalledTimes(1);

  expect(appShellMocks.shortcuts).not.toBeNull();
  appShellMocks.shortcuts!.onCreateSession();
  await wrapper.find('.session-tabs-stub').trigger('click');
  sessions.createSession('COM-shortcut', config);
  await wrapper.vm.$nextTick();
  appShellMocks.shortcuts!.onCloseSession();
  expect(sessionActions.requestCloseSession).toHaveBeenCalledWith(sessions.activeSessionId);

  await wrapper.unmount();
  window.dispatchEvent(
    new CustomEvent('bbcom:auto-log-failure', {
      detail: { sessionId: 'after-unmount', reason: 'ignored' },
    }),
  );
  expect(nativeMocks.message.error).toHaveBeenCalledTimes(1);
});

test('WaveformLegend exposes channel visibility, viewport, ruler, source, and export controls', async () => {
  const props = {
    channelState: [
      { color: '#f00', visible: true, latest: 12.5 },
      { color: '#0f0', visible: false, latest: null },
    ],
    stats: [
      { min: 1, max: 20, mean: 12.5 },
      { min: 0, max: 0, mean: 0 },
    ],
    channelLabel: (index: number) => `Channel ${index}`,
    formatNum: (value: number) => value.toFixed(1),
    sourceMode: 'text' as const,
    showXRuler: true,
    showYRuler: true,
    showHoverRuler: true,
    showSamplePoints: false,
    canZoomIn: true,
    canZoomOut: true,
    canPanLeft: true,
    canPanRight: true,
    paused: false,
    disabled: false,
  };
  const wrapper = mount(WaveformLegend, { props });
  expect(wrapper.text()).toContain('Channel 0');
  expect(wrapper.text()).toContain('12.5');
  await wrapper.findAll('.legend-toggle')[0].trigger('click');
  await wrapper.find('.source-toggle').trigger('click');
  for (const button of wrapper.findAll('.wf-btn')) await button.trigger('click');
  expect(wrapper.emitted('toggle-channel')).toEqual([[0]]);
  expect(wrapper.emitted('toggle-mode')).toEqual([[]]);
  expect(wrapper.emitted('update:paused')).toEqual([[true]]);
  for (const event of [
    'pan-left',
    'pan-right',
    'zoom-in',
    'zoom-out',
    'toggle-x-ruler',
    'toggle-y-ruler',
    'toggle-hover-ruler',
    'toggle-sample-points',
    'clear',
    'load',
    'export',
  ]) {
    expect(wrapper.emitted(event)).toEqual([[]]);
  }

  await wrapper.setProps({ sourceMode: 'register', paused: true, disabled: true });
  expect(wrapper.find('.source-option.active').text()).toBe('REG');
  expect(wrapper.findAll('.wf-btn').at(-1)!.attributes('disabled')).toBeDefined();
});

test('WaveformPanel ingests frames, handles legend controls, register samples, canvas input, and CSV export', async () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const createObjectURL = vi.fn(() => 'blob:waveform');
  const revokeObjectURL = vi.fn();
  const context = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'measureText' ? () => ({ width: 24 }) : () => undefined,
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => context,
  });
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', undefined);
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: createObjectURL },
    revokeObjectURL: { configurable: true, value: revokeObjectURL },
  });

  try {
    const wrapper = mount(WaveformPanel, {
      props: {
        frames: [
          {
            id: 'wave-1',
            direction: 'RX',
            timestamp: 1000,
            data: new TextEncoder().encode('1,2'),
          },
          {
            id: 'wave-2',
            direction: 'TX',
            timestamp: 1010,
            data: new TextEncoder().encode('ignored'),
          },
        ],
        framesVersion: 1,
        canAppend: true,
        canEdit: true,
        waveform: {
          channels: [],
          samples: [],
          frameCursor: { consumed: 0, lastFrameId: null },
        },
      },
    });
    await wrapper.vm.$nextTick();
    const ingestEvents =
      wrapper.emitted('commitFrameIngest') ?? wrapper.emitted('commit-frame-ingest');
    const initialIngest = ingestEvents?.[0]?.[0] as
      | {
          mode: 'append' | 'replace';
          samples: readonly SessionWaveformSampleInput[];
          cursor: SessionWaveformFrameCursor;
        }
      | undefined;
    expect(initialIngest?.mode).toBe('append');
    expect(initialIngest?.samples).toHaveLength(2);
    await wrapper.setProps({
      waveform: {
        channels: [
          { channelIndex: 0, config: { visible: true } },
          { channelIndex: 1, config: { visible: true } },
        ],
        samples: initialIngest!.samples.map((sample) => ({
          channelIndex: sample.channelIndex,
          seq: sample.group,
          timestampMs: sample.timestampMs,
          value: sample.value,
        })),
        frameCursor: initialIngest!.cursor,
      },
    });
    const legend = wrapper.findComponent(WaveformLegend);
    expect(legend.findAll('.legend-toggle')).toHaveLength(2);
    await legend.findAll('.legend-toggle')[0].trigger('click');
    await legend.find('.source-toggle').trigger('click');
    expect(wrapper.emitted('toggleMode')).toEqual([[]]);

    const actionButtons = legend.findAll('.wf-btn');
    for (const button of actionButtons.slice(0, -3)) await button.trigger('click');
    await actionButtons.at(-2)!.trigger('click');
    await actionButtons.at(-1)!.trigger('click');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(nativeMocks.message.error).not.toHaveBeenCalled();

    const canvas = wrapper.find('canvas');
    Object.defineProperty(canvas.element, 'clientWidth', { configurable: true, value: 640 });
    Object.defineProperty(canvas.element, 'clientHeight', { configurable: true, value: 300 });
    (canvas.element as HTMLCanvasElement).getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 300 }) as DOMRect;
    await canvas.trigger('wheel', {
      clientX: 300,
      clientY: 100,
      deltaX: 0,
      deltaY: -20,
      deltaMode: 0,
    });
    await canvas.trigger('pointermove', { clientX: 300, clientY: 100, pointerId: 1 });
    await canvas.trigger('pointerleave');

    await wrapper.setProps({ mode: 'register', frames: [], framesVersion: 2 });
    await wrapper.vm.$nextTick();
    // The first legend action toggled pause; resume before feeding register
    // samples because a paused waveform intentionally consumes without storing.
    await actionButtons[0].trigger('click');
    const exposed = wrapper.vm as unknown as {
      pushRegisterSample: (channel: number, value: number, timestamp: number) => void;
      pushRegisterSamples: (
        samples: Array<{ channel: number; value: number; timestamp: number }>,
      ) => void;
    };
    exposed.pushRegisterSample(0, 7, 2000);
    exposed.pushRegisterSamples([
      { channel: 0, value: 8, timestamp: 2010 },
      { channel: 1, value: 9, timestamp: 2020 },
    ]);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.legend-toggle')).toHaveLength(2);
    await wrapper.unmount();
  } finally {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: originalGetContext,
    });
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      value: originalAnchorClick,
    });
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: originalCreateObjectURL },
      revokeObjectURL: { configurable: true, value: originalRevokeObjectURL },
    });
    vi.unstubAllGlobals();
  }
});

test('DataPacketList filters, selects, context-copies, keyboard-copies, and rejects oversized batches', async () => {
  vi.useFakeTimers();
  setupSessions();
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  const frames = [
    {
      id: 'packet-rx',
      direction: 'RX' as const,
      timestamp: 1000,
      data: new TextEncoder().encode('alpha'),
    },
    {
      id: 'packet-tx',
      direction: 'TX' as const,
      timestamp: 1010,
      data: new TextEncoder().encode('beta'),
    },
  ];
  const wrapper = mount(DataPacketList, {
    props: {
      frames,
      framesVersion: 1,
      highlights: [
        {
          id: 'highlight',
          name: 'Alpha',
          enabled: true,
          matchMode: 'text',
          pattern: 'alpha',
          direction: 'RX',
          color: 'amber',
        },
      ],
    },
  });
  await wrapper.vm.$nextTick();
  expect(wrapper.findAll('.packet-item')).toHaveLength(2);
  expect(wrapper.findAll('[data-index]')).toHaveLength(2);
  expect(packetVirtualMocks.measureElement).toHaveBeenCalled();
  expect(wrapper.find('.packet-item').classes()).toContain('highlight-amber');
  const virtualOptions = packetVirtualMocks.options;
  expect(virtualOptions?.itemKey?.(0)).toBe('packet-rx');
  const initialRowSizeVersion = virtualOptions?.rowSizeVersion?.value;

  // Rolling retention can replace the head while preserving the array length.
  // Stable frame keys and a replacement-only measurement version prevent the
  // virtualizer from reusing the old row's measured height for new content.
  await wrapper.setProps({
    frames: frames.map((frame) => ({ ...frame, id: `replacement-${frame.id}` })),
    framesVersion: 2,
  });
  await wrapper.vm.$nextTick();
  expect(virtualOptions?.itemKey?.(0)).toBe('replacement-packet-rx');
  expect(virtualOptions?.rowSizeVersion?.value).not.toBe(initialRowSizeVersion);

  const toolbarInput = wrapper.find('.packet-toolbar input');
  await toolbarInput.setValue('alpha');
  await vi.advanceTimersByTimeAsync(150);
  await wrapper.vm.$nextTick();
  expect(wrapper.find('.frame-count').text()).toContain('1 / 2');

  await wrapper.get('.dropdown-option[data-key="filtered-hex"]').trigger('click');
  await wrapper.vm.$nextTick();
  expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  expect(nativeMocks.message.success).toHaveBeenCalledTimes(1);

  const row = wrapper.find('.packet-item');
  await row.trigger('contextmenu', { clientX: 40, clientY: 50 });
  await wrapper.get('.dropdown-option[data-key="row"]').trigger('click');
  await wrapper.vm.$nextTick();
  expect(clipboard.writeText).toHaveBeenCalledTimes(2);

  const items = wrapper.find('.packet-items');
  Object.defineProperty(items.element, 'clientHeight', { configurable: true, value: 28 });
  Object.defineProperty(items.element, 'scrollHeight', { configurable: true, value: 56 });
  await items.trigger('scroll');
  expect(packetVirtualMocks.onScroll).toHaveBeenCalledTimes(1);
  await items.trigger('keydown', { key: 'ArrowDown' });
  await wrapper.vm.$nextTick();
  expect(wrapper.find('.packet-item').classes()).toContain('selected');
  await items.trigger('keydown', { key: 'c', ctrlKey: true });
  await Promise.resolve();
  expect(clipboard.writeText).toHaveBeenCalledTimes(3);

  const oversized = Array.from({ length: 5001 }, (_, index) => ({
    id: `oversized-${index}`,
    direction: 'RX' as const,
    timestamp: index,
    data: new Uint8Array([index % 256]),
  }));
  await wrapper.setProps({ frames: oversized, framesVersion: 3 });
  await wrapper.get('.dropdown-option[data-key="all-text"]').trigger('click');
  await wrapper.vm.$nextTick();
  expect(nativeMocks.message.warning).toHaveBeenCalledTimes(1);
});

test('ParserPanel edits resident parser settings, filters/selects parsed frames, and copies hex/ascii details', async () => {
  await ensureLocaleLoaded('en');
  setLocale('en');
  const sessions = setupSessions();
  const sessionId = sessions.createSession('COM-parser', config);
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  const parsedFrames = [
    { offset: 0, data: new TextEncoder().encode('alpha') },
    { offset: 5, data: new TextEncoder().encode('beta') },
  ];
  const wrapper = mount(ParserPanel, {
    props: {
      sessionId,
      parsedFrames,
      droppedFrames: 0,
      droppedBytes: 0,
      throughputBps: 256,
      parserResetVersion: 0,
    },
  });
  expect(wrapper.find('.parser-dropped-stat').exists()).toBe(false);
  await wrapper.setProps({ droppedFrames: 3, droppedBytes: 42 });
  expect(wrapper.get('.parser-dropped-stat').text()).toContain('Dropped');
  expect(wrapper.get('.parser-dropped-stat').text()).toContain('3 frames / 42 B');
  setLocale('zh');
  await wrapper.vm.$nextTick();
  expect(wrapper.get('.parser-dropped-stat').text()).toContain('丢弃');
  expect(wrapper.get('.parser-dropped-stat').text()).toContain('3 帧 / 42 B');
  expect(wrapper.findAll('.pp-frame')).toHaveLength(2);
  await wrapper.findAll('.pp-frame')[0].trigger('click');
  expect(wrapper.find('.pp-frame').classes()).toContain('selected');
  await wrapper.find('.pp-copy').trigger('click');
  await Promise.resolve();
  expect(clipboard.writeText).toHaveBeenCalledWith('61 6C 70 68 61');

  const searchInput = wrapper.find('.pp-search input');
  await searchInput.setValue('beta');
  expect(wrapper.findAll('.pp-frame')).toHaveLength(1);
  const configBar = wrapper.findComponent(ParserConfigBar);
  configBar.vm.$emit('apply-preset', 'modbus-fixed-8');
  await wrapper.vm.$nextTick();
  expect(sessions.sessions[0].parserState).toMatchObject({
    presetId: 'modbus-fixed-8',
    config: { kind: 'fixed', frameSize: 8 },
  });
  configBar.vm.$emit('update:kind', 'length');
  await wrapper.vm.$nextTick();
  expect(sessions.sessions[0].parserState.config.kind).toBe('length');

  const detail = wrapper.findComponent(ParserFrameDetail);
  detail.vm.$emit('copy-ascii');
  await Promise.resolve();
  expect(clipboard.writeText).toHaveBeenLastCalledWith('alpha');
  await wrapper.setProps({ parserResetVersion: 1 });
  expect(wrapper.find('.pp-detail-empty').exists()).toBe(true);
  configBar.vm.$emit('close');
  expect(wrapper.emitted('close')).toEqual([[]]);
});

test('ModbusPanel bridges header, virtual row, add form, write feedback, source controls, and save actions', async () => {
  vi.useFakeTimers();
  const sessions = setupSessions();
  const sessionId = sessions.createSession('COM-modbus', config);
  const regId = sessions.addModbusRegister(sessionId, {
    name: 'Setpoint',
    slaveAddress: 1,
    functionCode: 0x06,
    address: 10,
    quantity: 1,
    type: 'uint16',
    waveformChannel: null,
    periodicRead: false,
    periodicWrite: false,
  })!;
  sessions.updateModbusRegister(sessionId, regId, { value: 42, valueTs: 1 });
  const onReadAll = vi.fn(async () => undefined);
  const onReadRow = vi.fn(async () => undefined);
  const onSendAll = vi.fn(async () => undefined);
  const onSendRow = vi.fn(async () => true);
  const onReplay = vi.fn();
  const onStopReplay = vi.fn();
  const onLoadWriteSource = vi.fn();
  const onClearWriteSource = vi.fn();
  const onPickWriteSource = vi.fn();
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const createObjectURL = vi.fn(() => 'blob:modbus');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: createObjectURL },
    revokeObjectURL: { configurable: true, value: revokeObjectURL },
  });
  try {
    const wrapper = mount(ModbusPanel, {
      props: {
        sessionId,
        config: sessions.sessions[0].modbusConfig,
        registers: sessions.sessions[0].modbusRegisters,
        isConnected: true,
        busy: false,
        statusText: 'idle',
        statusClass: 'idle',
        replaying: false,
        writeSourceName: 'writes.bbreg',
        onReadAll,
        onReadRow,
        onSendAll,
        onSendRow,
        onReplay,
        onStopReplay,
        onLoadWriteSource,
        onClearWriteSource,
        onPickWriteSource,
      },
    });
    const header = wrapper.findComponent(ModbusHeader);
    header.vm.$emit('patch', { enabled: true, timeoutMs: 750 });
    header.vm.$emit('read-all');
    header.vm.$emit('send-all');
    header.vm.$emit('pick-write-source');
    header.vm.$emit('clear-write-source');
    await wrapper.vm.$nextTick();
    expect(sessions.sessions[0].modbusConfig).toMatchObject({ enabled: true, timeoutMs: 750 });
    expect(onReadAll).toHaveBeenCalledTimes(1);
    expect(onSendAll).toHaveBeenCalledTimes(1);
    expect(onPickWriteSource).toHaveBeenCalledTimes(1);
    expect(onClearWriteSource).toHaveBeenCalledTimes(1);

    const row = wrapper.findComponent(ModbusRegisterRow);
    row.vm.$emit('updateValueDraft', '42');
    row.vm.$emit('plot');
    row.vm.$emit('send');
    await Promise.resolve();
    expect(onSendRow).toHaveBeenCalledWith(expect.objectContaining({ id: regId, value: 42 }));
    expect(wrapper.emitted('plotInWaveform')).toEqual([[expect.objectContaining({ id: regId })]]);
    await vi.advanceTimersByTimeAsync(320);

    const addForm = wrapper.findComponent(ModbusAddRegisterForm);
    addForm.vm.$emit('add', {
      name: 'Readback',
      slaveAddress: 2,
      functionCode: 0x03,
      address: 20,
      quantity: 2,
      type: 'uint16',
      unit: 'V',
      waveformChannel: 1,
    });
    expect(sessions.sessions[0].modbusRegisters).toHaveLength(2);
    expect(sessions.sessions[0].modbusRegisters[1]).toMatchObject({
      name: 'Readback',
      periodicRead: true,
      waveformChannel: 1,
    });

    header.vm.$emit('save');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    header.vm.$emit('load');
    header.vm.$emit('replay');
    header.vm.$emit('stop-replay');
    header.vm.$emit('close');
    expect(onStopReplay).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('close')).toEqual([[]]);
  } finally {
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      value: originalAnchorClick,
    });
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: originalCreateObjectURL },
      revokeObjectURL: { configurable: true, value: originalRevokeObjectURL },
    });
  }
});

test('SettingsModal updates appearance, locale, buffer limits, reconnection, and close state', async () => {
  setupSessions();
  const app = useAppStore();
  const wrapper = mount(SettingsModal, {
    props: { show: true },
    global: { stubs: { Teleport: true } },
  });
  expect(wrapper.find('.settings-body').exists()).toBe(true);
  const select = wrapper.find('select');
  await select.setValue('1');
  expect(app.locale).toBe('en');

  const bufferInput = wrapper.find('input');
  await bufferInput.setValue('2500');
  expect(app.maxBufferFrames).toBe(2500);
  const buttons = wrapper.findAll('button');
  const resetButton = buttons.find((button) => button.text().includes(t('settings.resetDefault')));
  expect(resetButton).toBeDefined();
  await resetButton!.trigger('click');
  expect(app.maxBufferFrames).toBe(10000);

  const switches = wrapper.findAll('.switch-stub');
  await switches[0].trigger('click');
  wrapper.findAllComponents({ name: 'NSwitch' })[1].vm.$emit('update:value', true);
  await wrapper.vm.$nextTick();
  expect(app.theme).toBe('light');
  expect(app.autoReconnect).toBe(true);

  await wrapper.find('.app-modal__close').trigger('click');
  const doneButton = buttons.find((button) => button.text().includes(t('settings.done')));
  expect(doneButton).toBeDefined();
  await doneButton!.trigger('click');
  expect(wrapper.emitted('update:show')).toEqual([[false], [false]]);
});

test('CreateSessionDialog syncs selected port/config, creates sessions, and saves/removes named presets', async () => {
  const sessions = setupSessions();
  const serialStore = (await import('@/features/serial/store/serial-store.ts')).useSerialStore();
  serialStore.setSelectedPort('COM-B');
  const busyId = sessions.createSession('COM-A', config);
  sessions.setConnected(busyId, true);
  const wrapper = mount(CreateSessionDialog, {
    props: { show: false },
    global: { stubs: { Teleport: true } },
  });
  await wrapper.setProps({ show: true });
  await wrapper.vm.$nextTick();
  const selects = wrapper.findAll('select');
  expect((selects[0].element as HTMLSelectElement).options[0].disabled).toBe(true);
  expect((selects[0].element as HTMLSelectElement).value).toBe('1');

  // Re-query before each interaction: under the Teleport stub the modal body
  // re-mounts per parent render, so element handles captured earlier go
  // stale. Production teleports patch in place; only the stub remounts.
  await wrapper.findAll('select')[2].setValue('3');
  await wrapper.findAll('select')[5].setValue('2');
  await wrapper.findAll('.modal-positive')[0].trigger('click');
  expect(sessionActions.createSession).toHaveBeenCalledWith(
    'COM-B',
    expect.objectContaining({ baudRate: 57600, parity: 'even' }),
  );
  expect(wrapper.emitted('update:show')).toContainEqual([false]);

  const savePresetButton = wrapper
    .findAll('button')
    .find((button) => button.attributes('title') === t('create.savePresetTitle'));
  expect(savePresetButton).toBeDefined();
  await savePresetButton!.trigger('click');
  const presetNameInput = wrapper.findAll('input').at(-1)!;
  await presetNameInput.setValue('Bench setup');
  await wrapper.findAll('.modal-positive')[1].trigger('click');
  const presetSelect = wrapper.findAll('select')[1];
  expect((presetSelect.element as HTMLSelectElement).options.length).toBeGreaterThan(1);
  await presetSelect.setValue('0');
  const deletePresetButton = wrapper
    .findAll('button')
    .find((button) => button.attributes('title') === t('create.deletePresetTitle'));
  expect(deletePresetButton).toBeDefined();
  await deletePresetButton!.trigger('click');
  expect((wrapper.findAll('select')[1].element as HTMLSelectElement).options.length).toBe(1);
});

test('App reflects the active theme and mounts the application shell through the root providers', async () => {
  setupSessions();
  const app = useAppStore();
  const wrapper = mount(App, { global: { stubs: { AppShell: true } } });
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  app.setTheme('light');
  await wrapper.vm.$nextTick();
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
});

test('AiWindow never broadcasts visibility and only debounces content-size updates', async () => {
  vi.useFakeTimers();
  const callbacks: Array<() => void> = [];
  const frameCallbacks: FrameRequestCallback[] = [];
  class TestResizeObserver {
    constructor(callback: () => void) {
      callbacks.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  });
  const originalInnerHeight = window.innerHeight;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 });
  setupSessions();
  const wrapper = mount(AiWindow, { global: { stubs: { AiPanel: true } } });
  const content = wrapper.find('.ai-window-content');
  (content.element as HTMLElement).getBoundingClientRect = () =>
    ({ width: 800.2, height: 500.4 }) as DOMRect;
  await wrapper.vm.$nextTick();
  await Promise.resolve();
  // Visibility is OS-window state owned by Rust (show/hide/close emit there);
  // this webview mounts while the window is hidden and must stay silent so it
  // can never desync the main-window toggle. The authority request the AI
  // renderer legitimately emits on mount is unrelated.
  const visibilityCalls = nativeMocks.tauriEmit.mock.calls.filter(
    (call) => call[0] === 'ai-window-state',
  );
  expect(visibilityCalls).toEqual([]);
  expect(callbacks).toHaveLength(1);
  callbacks[0]!();
  callbacks[0]!();
  await vi.advanceTimersByTimeAsync(60);
  expect(nativeMocks.resizeAiWindow).toHaveBeenCalledWith(801, 501);
  expect(nativeMocks.resizeAiWindow).toHaveBeenCalledTimes(1);
  frameCallbacks.shift()!(0);
  await Promise.resolve();
  await Promise.resolve();
  expect(nativeMocks.resizeAiWindow).toHaveBeenLastCalledWith(801, 602);
  await vi.advanceTimersByTimeAsync(120);

  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
  callbacks[0]!();
  await vi.advanceTimersByTimeAsync(60);
  frameCallbacks.shift()!(0);
  await Promise.resolve();
  await Promise.resolve();
  expect(nativeMocks.resizeAiWindow).toHaveBeenCalledTimes(3);
  expect(nativeMocks.resizeAiWindow).toHaveBeenLastCalledWith(801, 501);
  await wrapper.unmount();
  expect(nativeMocks.tauriEmit.mock.calls.filter((call) => call[0] === 'ai-window-state')).toEqual(
    [],
  );
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: originalInnerHeight,
  });
  vi.unstubAllGlobals();
});
