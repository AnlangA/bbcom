// @vitest-environment happy-dom

import { nextTick, reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { beforeEach, expect, test, vi } from 'vitest';
import AiLogAssistant from '../../src/components/ai/AiLogAssistant.vue';
import AiTerminalAssistant from '../../src/components/send-panel/AiTerminalAssistant.vue';
import type { AiWindowSession } from '../../src/types/ai.ts';

const ui = vi.hoisted(() => ({
  app: null as null | { aiKeyConfigured: boolean },
  message: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
  warn: vi.fn(),
}));

vi.mock('../../src/stores/app', () => ({ useAppStore: () => ui.app }));
vi.mock('../../src/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => ui.warn(...args), debug: vi.fn() },
}));
vi.mock('naive-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('naive-ui')>()),
  useMessage: () => ui.message,
}));

const binding = Object.freeze({
  workspaceId: 'workspace-a',
  sessionId: 'session-1',
  revision: 7,
  requestId: 'request-1',
});

function sessionFixture(overrides: Partial<AiWindowSession> = {}): AiWindowSession {
  return {
    id: 'session-1',
    portName: 'COM1',
    baudRate: 115200,
    isConnected: true,
    txBytes: 1,
    rxBytes: 2,
    txFrames: 1,
    rxFrames: 2,
    terminalAiModel: 'glm-4.5-air',
    logAiModel: 'glm-4.5-air',
    logAiContextMode: 'latest-10k',
    logAiFrameLimit: 200,
    logAiMessages: [],
    ...overrides,
  };
}

function bridgeFixture() {
  return {
    workspaceId: ref('workspace-a'),
    revision: ref(7),
    createRequestBinding: vi.fn(() => binding),
    refreshSession: vi.fn(async () => sessionFixture()),
    getLogContext: vi.fn(async () => ({
      sessionId: 'session-1',
      text: 'RX 4f 4b',
      truncated: false,
      frameCount: 1,
      charLimit: 10_000,
    })),
    addLogAiMessage: vi.fn(async () => undefined),
    runRequest: vi.fn(),
    isBindingCurrent: vi.fn(() => true),
    releaseRequestBinding: vi.fn(async () => undefined),
    cancelRequest: vi.fn(async () => undefined),
    setLogAiModel: vi.fn(async () => undefined),
    setLogAiContextMode: vi.fn(async () => undefined),
    setLogAiFrameLimit: vi.fn(async () => undefined),
    clearLogAiMessages: vi.fn(async () => undefined),
    setTerminalAiModel: vi.fn(async () => undefined),
    applyCommand: vi.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

beforeEach(() => {
  ui.app = reactive({ aiKeyConfigured: false });
  ui.message.warning.mockClear();
  ui.message.error.mockClear();
  ui.message.success.mockClear();
  ui.warn.mockClear();
});

test('terminal assistant handles key, binding, success, copy, apply, stale, and failure paths', async () => {
  const bridge = bridgeFixture();
  bridge.runRequest.mockResolvedValue({
    ...binding,
    result: {
      kind: 'terminal',
      command: 'AT+RST',
      explanation: 'Reset the modem',
      risk: 'caution',
    },
  });
  const wrapper = mount(AiTerminalAssistant, {
    props: { session: sessionFixture(), bridge: bridge as never },
  });
  const input = wrapper.find('.prompt-row input');
  await input.setValue(' reset modem ');
  await wrapper.find('.prompt-row button').trigger('click');
  expect(ui.message.warning).toHaveBeenCalledOnce();

  ui.app!.aiKeyConfigured = true;
  bridge.createRequestBinding.mockReturnValueOnce(null);
  await wrapper.find('.prompt-row button').trigger('click');
  expect(ui.message.warning).toHaveBeenCalledTimes(2);

  await wrapper.find('.prompt-row button').trigger('click');
  await settle();
  expect(bridge.runRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: 'request-1',
      kind: 'terminal',
      prompt: 'reset modem',
      shell: 'linux/busybox',
    }),
    binding,
  );
  expect(wrapper.find('.result-row').classes()).toContain('risk-caution');
  expect(wrapper.find('.command').text()).toBe('AT+RST');

  const clipboardWrite = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  const actions = wrapper.findAll('.result-actions button');
  await actions[0]!.trigger('click');
  await actions[1]!.trigger('click');
  await settle();
  expect(clipboardWrite).toHaveBeenCalledWith('AT+RST');
  expect(ui.message.success).toHaveBeenCalledOnce();
  expect(bridge.applyCommand).toHaveBeenCalledWith('AT+RST', binding);

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
  });
  await actions[0]!.trigger('click');
  await settle();
  expect(ui.warn).toHaveBeenCalled();
  expect(ui.message.error).toHaveBeenCalled();

  bridge.isBindingCurrent.mockReturnValue(false);
  await actions[1]!.trigger('click');
  expect(wrapper.find('.result-row').exists()).toBe(false);

  bridge.isBindingCurrent.mockReturnValue(true);
  bridge.runRequest.mockResolvedValueOnce({
    ...binding,
    result: { kind: 'log', answer: 'wrong kind' },
  });
  await input.setValue('again');
  await wrapper.find('.prompt-row button').trigger('click');
  await settle();
  expect(ui.message.error).toHaveBeenCalled();

  bridge.runRequest.mockResolvedValueOnce({
    ...binding,
    result: {
      kind: 'terminal',
      command: 'AT',
      explanation: 'Probe',
      risk: 'safe',
    },
  });
  bridge.revision.value = 8;
  await settle();
  await wrapper.find('.prompt-row button').trigger('click');
  await settle();
  expect(wrapper.find('.result-row').exists()).toBe(false);
});

test('terminal assistant exposes cancellation only while an activity is pending', async () => {
  ui.app!.aiKeyConfigured = true;
  const bridge = bridgeFixture();
  const request = deferred<never>();
  bridge.runRequest.mockReturnValue(request.promise);
  const wrapper = mount(AiTerminalAssistant, {
    props: { session: sessionFixture(), bridge: bridge as never },
  });
  await wrapper.find('.prompt-row input').setValue('wait');
  await wrapper.find('.prompt-row button').trigger('click');
  await nextTick();
  expect(wrapper.findAll('.prompt-row button')).toHaveLength(2);
  await wrapper.findAll('.prompt-row button')[0]!.trigger('click');
  await settle();
  expect(bridge.cancelRequest).toHaveBeenCalledWith('request-1');
  request.reject(new Error('cancelled'));
  await settle();
  expect(ui.message.error).not.toHaveBeenCalled();
});

test('log assistant validates context, persists a question, renders results, and clears state', async () => {
  const bridge = bridgeFixture();
  bridge.runRequest.mockResolvedValue({
    ...binding,
    result: {
      kind: 'log',
      answer: 'The modem replied OK.',
      evidence: ['RX OK'],
      suggestions: ['Continue setup'],
      truncated: true,
    },
  });
  const session = reactive(
    sessionFixture({
      logAiContextMode: 'latest-n-frames',
      logAiMessages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }],
    }),
  );
  const wrapper = mount(AiLogAssistant, {
    props: { session, bridge: bridge as never },
  });
  const input = wrapper.find('.prompt-row input');
  await input.setValue(' diagnose ');
  await wrapper.findAll('.prompt-row button').at(-1)!.trigger('click');
  expect(ui.message.warning).toHaveBeenCalledOnce();

  ui.app!.aiKeyConfigured = true;
  bridge.createRequestBinding.mockReturnValueOnce(null);
  await wrapper.findAll('.prompt-row button').at(-1)!.trigger('click');
  expect(ui.message.warning).toHaveBeenCalledTimes(2);

  bridge.getLogContext.mockResolvedValueOnce({
    sessionId: 'session-1',
    text: '',
    truncated: false,
    frameCount: 0,
    charLimit: 10_000,
  });
  await wrapper.findAll('.prompt-row button').at(-1)!.trigger('click');
  await settle();
  expect(bridge.releaseRequestBinding).toHaveBeenCalledWith(binding);
  expect(ui.message.warning).toHaveBeenCalledTimes(3);

  await wrapper.findAll('.prompt-row button').at(-1)!.trigger('click');
  await settle();
  expect(bridge.addLogAiMessage).toHaveBeenCalledWith(
    { role: 'user', content: 'diagnose' },
    binding,
  );
  expect(bridge.runRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'log',
      prompt: 'diagnose',
      context: 'RX 4f 4b',
      contextMode: 'latest-10k',
    }),
    binding,
  );
  expect(wrapper.find('.answer').text()).toBe('The modem replied OK.');
  expect(wrapper.findAll('.result-section')).toHaveLength(2);

  await wrapper.findAll('.prompt-row button')[0]!.trigger('click');
  expect(bridge.clearLogAiMessages).toHaveBeenCalledOnce();
  expect(wrapper.find('.result-card').exists()).toBe(false);

  const selects = wrapper.findAll('select');
  await selects[0]!.setValue('1');
  await selects[1]!.setValue('0');
  const numberInput = wrapper.find('.settings-row input');
  await numberInput.setValue('400');
  await numberInput.trigger('change');
  await settle();
  expect(bridge.setLogAiModel).toHaveBeenCalled();
  expect(bridge.setLogAiContextMode).toHaveBeenCalled();
});

test('log assistant releases failed pre-submit bindings and suppresses cancellation errors', async () => {
  ui.app!.aiKeyConfigured = true;
  const bridge = bridgeFixture();
  bridge.refreshSession.mockRejectedValueOnce(new Error('snapshot failed'));
  const wrapper = mount(AiLogAssistant, {
    props: { session: sessionFixture(), bridge: bridge as never },
  });
  const input = wrapper.find('.prompt-row input');
  await input.setValue('first');
  await wrapper.findAll('.prompt-row button').at(-1)!.trigger('click');
  await settle();
  expect(ui.message.error).toHaveBeenCalledOnce();

  const request = deferred<never>();
  bridge.runRequest.mockReturnValueOnce(request.promise);
  await input.setValue('second');
  await wrapper.findAll('.prompt-row button').at(-1)!.trigger('click');
  await nextTick();
  const buttons = wrapper.findAll('.prompt-row button');
  expect(buttons).toHaveLength(3);
  await buttons[1]!.trigger('click');
  await settle();
  expect(bridge.cancelRequest).toHaveBeenCalledWith('request-1');
  request.reject(new Error('cancelled'));
  await settle();
  expect(ui.message.error).toHaveBeenCalledOnce();
});
