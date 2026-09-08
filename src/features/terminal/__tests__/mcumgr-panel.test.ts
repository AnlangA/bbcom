// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { computed, defineComponent, h, ref } from 'vue';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { NMessageProvider } from 'naive-ui';
import McumgrPanel from '../ui/mcumgr/McumgrPanel.vue';
import type { McumgrClientStatus } from '@/types';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';
import { t } from '@/lib/i18n';

enableAutoUnmount(afterEach);
afterEach(() => vi.unstubAllGlobals());

function fixture(result = '') {
  const status = ref<McumgrClientStatus>({ kind: 'idle' });
  const lastResult = ref(result);
  const cancel = vi.fn(() => {
    status.value = { kind: 'idle' };
  });
  const execute = vi.fn().mockResolvedValue(null);
  const runOsEcho = vi.fn().mockResolvedValue(null);
  const controller = {
    busy: computed(() => status.value.kind === 'busy' || status.value.kind === 'progress'),
    status,
    lastResult,
    cancel,
    execute,
    runOsEcho,
    patchConfig: vi.fn(),
    setResult: (value: string) => {
      lastResult.value = value;
    },
  } as unknown as SessionMcumgrController;
  const wrapper = mount(
    defineComponent({
      setup: () => () =>
        h(NMessageProvider, null, {
          default: () =>
            h(McumgrPanel, {
              sessionId: 'mcumgr-ui-test',
              config: {
                autoFrameSize: true,
                frameSize: 512,
                timeoutMs: 3000,
                retries: 2,
                shellHistory: [],
              },
              isConnected: false,
              mcumgr: controller,
            }),
        }),
    }),
    { attachTo: document.body },
  );
  return { wrapper, status, lastResult, cancel, execute, runOsEcho };
}

test('system tools preserve echo, query payloads, reset confirmation and busy guards', async () => {
  const { wrapper, status, execute, runOsEcho } = fixture();
  const input = wrapper.get(`input[aria-label="${t('mcumgr.os.echo')}"]`);
  await input.setValue('device-check');
  await input.trigger('keydown', { key: 'Enter' });
  expect(runOsEcho).toHaveBeenCalledExactlyOnceWith('device-check');
  for (const [label, action, op] of [
    ['tasks', 'tasks', { kind: 'os-tasks' }],
    ['mpstat', 'mpstat', { kind: 'os-memory-pools' }],
    ['datetime', 'datetime', { kind: 'os-datetime' }],
    ['params', 'params', { kind: 'os-params' }],
    ['info', 'info', { kind: 'os-info', format: null }],
    ['bootloader', 'bootloader', { kind: 'os-bootloader-info' }],
  ] as const) {
    await wrapper.get(`button[aria-label="${t(`mcumgr.os.${label}`)}"]`).trigger('click');
    expect(execute).toHaveBeenLastCalledWith(action, op);
  }
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.stubGlobal('confirm', confirm);
  const reset = wrapper.findAll('.reset-row button')[0];
  await reset.trigger('click');
  expect(execute).toHaveBeenCalledTimes(6);
  await reset.trigger('click');
  expect(confirm).toHaveBeenCalledWith(t('mcumgr.confirm.reset'));
  expect(execute).toHaveBeenLastCalledWith('reset', { kind: 'os-reset', force: false });
  status.value = { kind: 'busy', action: 'tasks' };
  await flushPromises();
  expect(wrapper.get('.query-tool').attributes('disabled')).toBeDefined();
  await input.trigger('keydown', { key: 'Enter' });
  await reset.trigger('click');
  expect(execute).toHaveBeenCalledTimes(7);
  expect(runOsEcho).toHaveBeenCalledTimes(1);
});

test('MCUMgr tabs support keyboard navigation and an executing transfer remains cancellable', async () => {
  const { wrapper, status, cancel } = fixture();
  const tabs = wrapper.findAll('[role="tab"]');
  expect(tabs).toHaveLength(8);
  for (const tab of tabs)
    expect(document.getElementById(tab.attributes('aria-controls'))).not.toBeNull();
  await tabs[0].trigger('keydown', { key: 'ArrowRight' });
  await flushPromises();
  expect(tabs[1].attributes('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tabs[1].element);
  expect(wrapper.get('[role="tabpanel"]:not([hidden])').attributes('aria-labelledby')).toBe(
    tabs[1].attributes('id'),
  );

  status.value = {
    kind: 'progress',
    action: 'image-upload',
    phase: 'upload',
    offset: 25,
    total: 100,
  };
  await flushPromises();
  expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('25');
  const upgrade = wrapper.get(`button[aria-label="${t('mcumgr.image.update')}"]`);
  expect(upgrade.attributes('disabled')).toBeDefined();
  await wrapper
    .findAll('button')
    .find((button) => button.text() === t('common.cancel'))!
    .trigger('click');
  expect(cancel).toHaveBeenCalledOnce();
});

test('MCUMgr results can wrap, expand, copy and clear without changing their raw content', async () => {
  const text = '{\n  "version": "1.2.3"\n}';
  const { wrapper, lastResult } = fixture(text);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await wrapper.get(`button[aria-label="${t('mcumgr.result.wrap')}"]`).trigger('click');
  expect(wrapper.get('.mc-result').classes()).not.toContain('wrap');
  await wrapper.get(`button[aria-label="${t('mcumgr.result.expand')}"]`).trigger('click');
  expect(wrapper.get('.mc-workspace').classes()).toContain('result-expanded');
  await wrapper.get(`button[aria-label="${t('mcumgr.result.copy')}"]`).trigger('click');
  expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  await wrapper.findAll('[role="tab"]')[2].trigger('click');
  expect(wrapper.get('.mc-workspace').classes()).not.toContain('result-expanded');
  expect(lastResult.value).toBe(text);
  await wrapper.get(`button[aria-label="${t('common.clear')}"]`).trigger('click');
  expect(lastResult.value).toBe('');
  expect(wrapper.find('.mc-result-empty').exists()).toBe(true);
});
