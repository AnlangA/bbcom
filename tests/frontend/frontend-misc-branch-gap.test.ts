// @vitest-environment happy-dom

import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick } from 'vue';
import ShutdownDialog from '../../src/components/app-shell/ShutdownDialog.vue';
import SessionRebindDialog from '../../src/components/session/SessionRebindDialog.vue';
import { useSessionActions } from '../../src/composables/useSessionActions.ts';
import { APPLICATION_SHUTDOWN_KEY } from '../../src/features/shutdown/application-shutdown-context.ts';
import { useAppStore } from '../../src/stores/app.ts';
import { useSerialStore } from '../../src/stores/serial.ts';
import { useSessionStore } from '../../src/stores/sessions.ts';
import type { ApplicationShutdownSnapshot } from '../../src/features/shutdown/application-shutdown-bootstrap.ts';
import type { PortConfig, SerialSession } from '../../src/types/index.ts';

const dialogMock = vi.hoisted(() => ({ warning: vi.fn() }));

vi.mock('naive-ui', () => ({
  createDiscreteApi: () => ({ dialog: dialogMock }),
  NModal: defineComponent({
    name: 'NModal',
    props: ['show', 'positiveButtonProps'],
    emits: ['update:show', 'positive-click', 'negative-click'],
    setup(props, { emit, slots }) {
      return () =>
        props.show
          ? h('div', { class: 'modal-stub' }, [
              slots.default?.(),
              h('button', { class: 'positive', onClick: () => emit('positive-click') }),
              h('button', { class: 'negative', onClick: () => emit('negative-click') }),
              h('button', { class: 'hide', onClick: () => emit('update:show', false) }),
            ])
          : null;
    },
  }),
}));

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

function idleSnapshot(): ApplicationShutdownSnapshot {
  return {
    coordinator: {
      state: 'idle',
      attemptId: null,
      acceptsNewWork: true,
      forced: false,
      report: null,
    },
    boundaryError: null,
  };
}

function failedSnapshot(boundaryError: ApplicationShutdownSnapshot['boundaryError'] = null) {
  return {
    coordinator: {
      state: 'failed' as const,
      attemptId: 'attempt-1',
      acceptsNewWork: false,
      forced: false,
      report: {
        attemptId: 'attempt-1',
        state: 'failed' as const,
        forced: false,
        elapsedMs: 12,
        participants: [
          {
            name: 'settings',
            status: 'failed' as const,
            elapsedMs: 12,
            messageKey: 'shutdown.participant.failed' as const,
          },
        ],
      },
    },
    boundaryError,
  };
}

function shutdownHarness(initial: ApplicationShutdownSnapshot) {
  let listener: ((snapshot: ApplicationShutdownSnapshot) => void) | undefined;
  let current = initial;
  const detach = vi.fn();
  const controller = {
    snapshot: () => current,
    subscribe: (next: (snapshot: ApplicationShutdownSnapshot) => void) => {
      listener = next;
      return detach;
    },
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    wait: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    force: vi.fn(async () => undefined),
    retryPublication: vi.fn(async () => undefined),
  };
  return {
    controller,
    detach,
    emit(snapshot: ApplicationShutdownSnapshot) {
      current = snapshot;
      listener?.(snapshot);
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  dialogMock.warning.mockReset();
});

test('ShutdownDialog covers decisions, publication retry, focus trapping, and optional context', async () => {
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  const harness = shutdownHarness(idleSnapshot());
  const wrapper = mount(ShutdownDialog, {
    attachTo: document.body,
    global: { provide: { [APPLICATION_SHUTDOWN_KEY as symbol]: harness.controller } },
  });
  assert.equal(wrapper.find('.shutdown-dialog').exists(), false);

  harness.emit(failedSnapshot());
  await nextTick();
  await nextTick();
  assert.match(wrapper.text(), /settings/);
  const buttons = wrapper.findAll('button');
  assert.equal(document.activeElement, buttons[0].element);

  buttons[0].element.focus();
  await wrapper.get('.shutdown-backdrop').trigger('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, buttons[2].element);
  await wrapper.get('.shutdown-backdrop').trigger('keydown', { key: 'Tab' });
  assert.equal(document.activeElement, buttons[0].element);
  await wrapper.get('.shutdown-backdrop').trigger('keydown', { key: 'x' });

  await buttons[0].trigger('click');
  await buttons[1].trigger('click');
  await wrapper.get('.shutdown-backdrop').trigger('keydown', { key: 'Escape' });
  await buttons[2].trigger('click');
  assert.ok(wrapper.find('.shutdown-warning').exists());
  await buttons[2].trigger('click');
  await nextTick();
  assert.equal(harness.controller.wait.mock.calls.length, 1);
  assert.equal(harness.controller.cancel.mock.calls.length, 2);
  assert.equal(harness.controller.force.mock.calls.length, 1);

  harness.emit({
    ...failedSnapshot('close-request'),
    coordinator: { ...failedSnapshot().coordinator, state: 'timed-out' },
  });
  await nextTick();
  assert.ok(wrapper.find('[data-action="retry-publication"]').exists());
  await wrapper.get('.shutdown-backdrop').trigger('keydown', { key: 'Escape' });
  assert.equal(harness.controller.cancel.mock.calls.length, 2);
  await wrapper.get('[data-action="retry-publication"]').trigger('click');
  assert.equal(harness.controller.retryPublication.mock.calls.length, 1);

  harness.emit(idleSnapshot());
  await nextTick();
  await nextTick();
  assert.equal(document.activeElement, outside);
  wrapper.unmount();
  assert.equal(harness.detach.mock.calls.length, 1);
  outside.remove();

  const missing = mount(ShutdownDialog);
  assert.equal(missing.find('.shutdown-dialog').exists(), false);
  missing.unmount();
});

const AppSelectStub = defineComponent({
  name: 'AppSelect',
  props: ['value', 'options'],
  emits: ['update:value'],
  template: '<div class="select-stub" />',
});

function emptyWaveform() {
  return { channels: [], samples: [], frameCursor: { consumed: 0, lastFrameId: null } };
}

test('SessionRebindDialog disables used ports and handles missing, invalid, and successful rebound', async () => {
  const sessions = useSessionStore();
  const serial = useSerialStore();
  const targetId = sessions.createSession('OLD', config);
  const usedId = sessions.createSession('COM2', config);
  sessions.setConnected(usedId, true);
  const target = sessions.sessions.find((session) => session.id === targetId)!;
  const used = sessions.sessions.find((session) => session.id === usedId)!;
  sessions.replaceWorkspaceSessions(
    [target, used].map((session, index) => ({
      session,
      sortOrder: index,
      rebind: { required: true as const, displayName: session.portName, kind: 'live' as const },
      waveform: emptyWaveform(),
    })),
    targetId,
  );
  sessions.setConnected(usedId, true);
  serial.setAvailablePorts(['COM1', 'COM2']);

  const wrapper = mount(SessionRebindDialog, {
    props: { show: true, sessionId: targetId, portConfig: config },
    global: { stubs: { AppSelect: AppSelectStub } },
  });
  const select = wrapper.getComponent(AppSelectStub);
  const options = select.props('options') as Array<{
    value: string;
    disabled: boolean;
    label: string;
  }>;
  assert.deepEqual(
    options.map(({ value, disabled }) => ({ value, disabled })),
    [
      { value: 'COM1', disabled: false },
      { value: 'COM2', disabled: true },
    ],
  );

  await wrapper.get('.positive').trigger('click');
  assert.equal(wrapper.emitted('rebound'), undefined);
  select.vm.$emit('update:value', '\u0000');
  await nextTick();
  await wrapper.get('.positive').trigger('click');
  assert.ok(wrapper.find('[role="alert"]').exists());

  await wrapper.setProps({ sessionId: 'missing-session' });
  select.vm.$emit('update:value', 'COM1');
  await nextTick();
  await wrapper.get('.positive').trigger('click');
  assert.ok(wrapper.find('[role="alert"]').exists());

  await wrapper.setProps({ show: false, sessionId: targetId });
  await wrapper.setProps({ show: true });
  wrapper.getComponent(AppSelectStub).vm.$emit('update:value', 'COM1');
  await nextTick();
  await wrapper.get('.positive').trigger('click');
  assert.deepEqual(wrapper.emitted('rebound'), [['COM1']]);
  assert.ok(wrapper.emitted('update:show')?.some((event) => event[0] === false));
  await wrapper.get('.negative').trigger('click');
  await wrapper.get('.hide').trigger('click');
});

function newSession(port: string): { id: string; session: SerialSession } {
  const store = useSessionStore();
  const id = store.createSession(port, config);
  return { id, session: store.sessions.find((candidate) => candidate.id === id)! };
}

test('useSessionActions covers guards, importance predicates, close confirmation, and clear confirmation', async () => {
  const sessions = useSessionStore();
  const serial = useSerialStore();
  const app = useAppStore();
  const actions = useSessionActions();

  assert.equal(actions.createSession('', config), null);
  sessions.setWorkspaceMutationPermissions({ userMutations: false, runtimeCapture: false });
  assert.equal(actions.createSession('BLOCKED', config), null);
  actions.requestCloseSession('missing');
  actions.requestClearFrames('missing');
  sessions.setWorkspaceMutationPermissions({ userMutations: true, runtimeCapture: true });

  app.setPendingAiCommand('AT');
  const created = actions.createSession('COM-CREATE', config)!;
  assert.equal(sessions.sessions.find((session) => session.id === created)?.sendDraft, 'AT');
  assert.equal(serial.portConfig.baudRate, config.baudRate);

  const plain = newSession('PLAIN');
  sessions.markWorkspacePersisted();
  assert.equal(actions.isImportantSession('missing'), false);
  assert.equal(actions.isImportantSession(plain.id), false);
  actions.requestClearFrames(plain.id);
  actions.requestCloseSession(plain.id);
  await Promise.resolve();
  assert.equal(
    sessions.sessions.some((session) => session.id === plain.id),
    false,
  );

  const framed = newSession('FRAMED');
  sessions.markWorkspacePersisted();
  sessions.addFrame(framed.id, { direction: 'RX', data: new Uint8Array([1]) });
  assert.equal(actions.isImportantSession(framed.id), true);
  actions.requestClearFrames(framed.id);
  const clear = dialogMock.warning.mock.calls.at(-1)?.[0];
  clear.onPositiveClick();
  assert.equal(framed.session.frames.length, 0);

  framed.session.pausedFrames.push({
    id: 'paused',
    direction: 'RX',
    timestamp: 1,
    data: new Uint8Array([1]),
  });
  assert.equal(actions.isImportantSession(framed.id), true);
  framed.session.pausedFrames.length = 0;
  framed.session.isConnected = true;
  assert.equal(actions.isImportantSession(framed.id), true);
  framed.session.isConnected = false;
  framed.session.autoLogEnabled = true;
  assert.equal(actions.isImportantSession(framed.id), true);
  framed.session.autoLogEnabled = false;
  sessions.setModbusConfig(framed.id, { timeoutMs: 2_000 });
  assert.equal(actions.isImportantSession(framed.id), true);

  actions.requestCloseSession(framed.id);
  const close = dialogMock.warning.mock.calls.at(-1)?.[0];
  assert.match(close.content, /FRAMED/);
  close.onPositiveClick();
  await Promise.resolve();

  sessions.setWorkspaceMutationPermissions({ userMutations: false, runtimeCapture: false });
  actions.requestCloseSession(created);
  actions.requestClearFrames(created);
});
