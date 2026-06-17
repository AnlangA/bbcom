import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { useAiWindowState } from '../../src/composables/useAiWindowState.ts';

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

  assert.equal(
    api.visible.value,
    false,
    'on failure visible does not stay optimistically true',
  );
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
