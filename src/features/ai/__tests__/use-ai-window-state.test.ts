// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { defineComponent, effectScope, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useAiWindowState } from '@/features/ai/application/use-ai-window-state.ts';

const native = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock('@/features/platform/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/platform/native')>()),
  listenNativeEvent: native.listen,
}));

function setup(deps: {
  getState?: () => Promise<{ visible: boolean }>;
  show?: () => Promise<void>;
  hide?: () => Promise<void>;
}) {
  const scope = effectScope();
  let api!: ReturnType<typeof useAiWindowState>;
  scope.run(() => {
    api = useAiWindowState(deps);
  });
  return api;
}

test('useAiWindowState: refresh reads the current window state into visible', async () => {
  const api = setup({ getState: async () => ({ visible: true }) });
  assert.equal(api.visible.value, false, 'starts hidden');

  await api.refresh();
  assert.equal(api.visible.value, true, 'state applied after refresh');
});

test('useAiWindowState: toggle from hidden calls show() and flips visible true', async () => {
  const calls: string[] = [];
  const api = setup({
    show: async () => {
      calls.push('show');
    },
    hide: async () => {
      calls.push('hide');
    },
  });

  await api.toggle();

  assert.deepEqual(calls, ['show'], 'hidden → show invoked, hide not');
  assert.equal(api.visible.value, true, 'visible flipped to true');
});

test('useAiWindowState: toggle from visible calls hide() and flips visible false', async () => {
  const calls: string[] = [];
  const api = setup({
    getState: async () => ({ visible: true }),
    show: async () => {
      calls.push('show');
    },
    hide: async () => {
      calls.push('hide');
    },
  });
  await api.refresh(); // seed visible=true

  await api.toggle();

  assert.deepEqual(calls, ['hide'], 'visible → hide invoked, show not');
  assert.equal(api.visible.value, false, 'visible flipped to false');
});

test('useAiWindowState: a failed toggle resets visible to false (no stuck optimistic state)', async () => {
  const api = setup({
    show: async () => {
      throw new Error('window manager refused');
    },
  });

  await api.toggle();

  assert.equal(api.visible.value, false, 'on failure visible does not stay optimistically true');
});

test('useAiWindowState: refresh failure falls back to hidden', async () => {
  const api = setup({
    getState: async () => {
      throw new Error('ipc unavailable');
    },
  });
  // Seed visible=true first to prove the failure path clears it.
  api.visible.value = true;

  await api.refresh();

  assert.equal(api.visible.value, false, 'refresh failure resets to hidden');
});

test('useAiWindowState: late event registration and refresh cannot outlive the mounted view', async () => {
  let completeListen!: (cleanup: () => void) => void;
  let completeRefresh!: (state: { visible: boolean }) => void;
  const cleanup = vi.fn();
  native.listen.mockImplementationOnce(
    () =>
      new Promise<() => void>((resolve) => {
        completeListen = resolve;
      }),
  );
  let api!: ReturnType<typeof useAiWindowState>;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useAiWindowState({
          getState: () =>
            new Promise((resolve) => {
              completeRefresh = resolve;
            }),
        });
        return () => h('div');
      },
    }),
  );
  wrapper.unmount();
  completeListen(cleanup);
  completeRefresh({ visible: true });
  await flushPromises();

  expect(cleanup).toHaveBeenCalledOnce();
  expect(api.visible.value).toBe(false);
});
