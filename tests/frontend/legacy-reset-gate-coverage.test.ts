// @vitest-environment happy-dom

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import LegacyResetGate from '../../src/components/migration/LegacyResetGate.vue';
import {
  LEGACY_RESET_CONTEXT_KEY,
  type LegacyResetContext,
  type LegacyResetViewModel,
} from '../../src/features/migration/index.ts';

interface GateSetupState {
  passphrase: string;
  passphraseConfirmation: string;
  discardChallenge: string | null;
  start: () => Promise<void>;
  createBackup: () => Promise<void>;
  requestDiscard: () => void;
  confirmDiscard: () => void;
  activateEmpty: () => Promise<void>;
  cancel: () => void;
  onKeydown: (event: KeyboardEvent) => void;
}

function setupState(wrapper: VueWrapper): GateSetupState {
  return (wrapper.vm.$ as unknown as { setupState: GateSetupState }).setupState;
}

function snapshot(
  status: LegacyResetViewModel['status'],
  overrides: Partial<LegacyResetViewModel> = {},
): LegacyResetViewModel {
  return {
    status,
    messageKey: null,
    canCancel: false,
    discardChallengePending: false,
    resetAuthorizedBy: null,
    ...overrides,
  };
}

function mountGate(initial = snapshot('backup-required')) {
  let current = initial;
  let listener: ((value: LegacyResetViewModel) => void) | null = null;
  const stop = vi.fn();
  const start = vi.fn(async () => ({ outcome: 'completed', snapshot: current }));
  const createVerifiedBackup = vi.fn(async () => ({ outcome: 'completed', snapshot: current }));
  const requestDiscard = vi.fn(() => ({ outcome: 'challenge', challenge: 'discard-challenge' }));
  const confirmDiscard = vi.fn();
  const activateEmptyV1 = vi.fn(async () => ({ outcome: 'completed', snapshot: current }));
  const cancel = vi.fn();
  const coordinator = {
    snapshot: () => current,
    subscribe(callback: (value: LegacyResetViewModel) => void) {
      listener = callback;
      return stop;
    },
    requestDiscard,
    confirmDiscard,
    activateEmptyV1,
    cancel,
  };
  const context = { coordinator, start, createVerifiedBackup } as unknown as LegacyResetContext;
  const wrapper = mount(LegacyResetGate, {
    attachTo: document.body,
    global: { provide: { [LEGACY_RESET_CONTEXT_KEY as symbol]: context } },
    slots: { default: '<main data-test="application">application</main>' },
  });
  return {
    wrapper,
    start,
    createVerifiedBackup,
    requestDiscard,
    confirmDiscard,
    activateEmptyV1,
    cancel,
    stop,
    emit(value: LegacyResetViewModel) {
      current = value;
      listener?.(value);
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('LegacyResetGate interactions', () => {
  test('requires matching passphrases, clears successful secrets, and confirms discard explicitly', async () => {
    const gate = mountGate(snapshot('backup-required', { canCancel: true }));
    await flushPromises();
    expect(gate.start).toHaveBeenCalledOnce();
    expect(gate.wrapper.find('[data-test="application"]').exists()).toBe(false);
    expect(gate.wrapper.find('button.primary').attributes('disabled')).toBeDefined();

    const inputs = gate.wrapper.findAll('input');
    await inputs[0].setValue('long-enough-passphrase');
    await inputs[1].setValue('different-passphrase');
    expect(gate.wrapper.find('.legacy-reset-error').exists()).toBe(true);
    expect(gate.wrapper.find('button.primary').attributes('disabled')).toBeDefined();

    await inputs[1].setValue('long-enough-passphrase');
    expect(gate.wrapper.find('button.primary').attributes('disabled')).toBeUndefined();
    await gate.wrapper.find('button.primary').trigger('click');
    await flushPromises();
    expect(gate.createVerifiedBackup).toHaveBeenCalledWith('long-enough-passphrase');
    expect(setupState(gate.wrapper).passphrase).toBe('');
    expect(setupState(gate.wrapper).passphraseConfirmation).toBe('');

    await gate.wrapper.find('button.danger-secondary').trigger('click');
    expect(gate.requestDiscard).toHaveBeenCalledOnce();
    await nextTick();
    expect(gate.wrapper.find('button.danger').exists()).toBe(true);
    await gate.wrapper.find('button.danger').trigger('click');
    expect(gate.confirmDiscard).toHaveBeenCalledWith('discard-challenge');

    gate.emit(snapshot('backup-required', { discardChallengePending: false }));
    await nextTick();
    expect(setupState(gate.wrapper).discardChallenge).toBeNull();
    gate.wrapper.unmount();
    expect(gate.stop).toHaveBeenCalledOnce();
  });

  test('runs activation and each retry route while leaving rollback failure terminal', async () => {
    const gate = mountGate(snapshot('ready-to-reset'));
    await flushPromises();
    await gate.wrapper.find('button.primary').trigger('click');
    expect(gate.activateEmptyV1).toHaveBeenCalledOnce();

    gate.emit(
      snapshot('failed', {
        messageKey: 'migration.reset.legacy_read_failed',
      }),
    );
    await nextTick();
    await gate.wrapper.find('button.primary').trigger('click');
    expect(gate.start).toHaveBeenCalledTimes(2);

    gate.emit(snapshot('failed', { messageKey: 'migration.reset.cancelled' }));
    await nextTick();
    expect(gate.wrapper.find('button.primary').exists()).toBe(true);

    gate.emit(snapshot('failed', { messageKey: 'migration.reset.backup_failed' }));
    await nextTick();
    const backupInputs = gate.wrapper.findAll('input');
    await backupInputs[0].setValue('retry-passphrase');
    await backupInputs[1].setValue('retry-passphrase');
    await gate.wrapper.find('button.primary').trigger('click');
    expect(gate.createVerifiedBackup).toHaveBeenLastCalledWith('retry-passphrase');

    gate.emit(
      snapshot('failed', {
        messageKey: 'migration.reset.backup_verification_failed',
      }),
    );
    await nextTick();
    expect(gate.wrapper.find('button.primary').exists()).toBe(true);

    gate.emit(snapshot('failed', { messageKey: 'migration.reset.target_failed' }));
    await nextTick();
    await gate.wrapper.find('button.primary').trigger('click');
    expect(gate.activateEmptyV1).toHaveBeenCalledTimes(2);

    gate.emit(snapshot('failed', { messageKey: 'migration.reset.marker_rollback_failed' }));
    await nextTick();
    expect(gate.wrapper.find('button.primary').exists()).toBe(false);
    expect(gate.wrapper.find('.legacy-reset-message').exists()).toBe(true);
    gate.wrapper.unmount();
  });

  test('renders every busy status, releases the application slot, and supports cancellation', async () => {
    const gate = mountGate(snapshot('checking', { canCancel: true }));
    await flushPromises();
    for (const status of ['checking', 'backing-up', 'verifying', 'resetting'] as const) {
      gate.emit(snapshot(status, { canCancel: true }));
      await nextTick();
      expect(gate.wrapper.find('.legacy-reset-message').exists()).toBe(true);
      await gate.wrapper.find('.legacy-reset-gate').trigger('keydown', { key: 'Escape' });
    }
    expect(gate.cancel).toHaveBeenCalledTimes(4);

    gate.emit(snapshot('completed'));
    await nextTick();
    expect(gate.wrapper.find('[data-test="application"]').exists()).toBe(true);
    expect(gate.wrapper.find('.legacy-reset-gate').exists()).toBe(false);
    gate.wrapper.unmount();
  });

  test('traps keyboard focus in the alert dialog and handles an empty focus ring', async () => {
    const gate = mountGate(snapshot('backup-required', { canCancel: true }));
    await flushPromises();
    const focusable = gate.wrapper.findAll('input, button:not([disabled])');
    const first = focusable[0].element as HTMLElement;
    const last = focusable.at(-1)?.element as HTMLElement;
    first.focus();
    await gate.wrapper.find('.legacy-reset-gate').trigger('keydown', {
      key: 'Tab',
      shiftKey: true,
    });
    expect(document.activeElement).toBe(last);
    last.focus();
    await gate.wrapper.find('.legacy-reset-gate').trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    await gate.wrapper.find('.legacy-reset-gate').trigger('keydown', { key: 'ArrowDown' });

    gate.emit(snapshot('failed', { messageKey: 'migration.reset.marker_rollback_failed' }));
    await nextTick();
    await gate.wrapper.find('.legacy-reset-gate').trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(gate.wrapper.find('.legacy-reset-card').element);
    gate.wrapper.unmount();
  });

  test('fails closed and focuses the dialog when reset integration is unavailable', async () => {
    const wrapper = mount(LegacyResetGate, {
      attachTo: document.body,
      slots: { default: '<main data-test="application">application</main>' },
    });
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="application"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('.legacy-reset-card').element);
    await setupState(wrapper).start();
    await setupState(wrapper).createBackup();
    setupState(wrapper).requestDiscard();
    setupState(wrapper).confirmDiscard();
    await setupState(wrapper).activateEmpty();
    setupState(wrapper).cancel();
    wrapper.unmount();
  });
});
