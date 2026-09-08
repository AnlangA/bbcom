// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { t } from '@/lib/i18n';
import { createSessionRecord } from '@/lib/session-persistence';
import SessionConnectionControls from '../ui/SessionConnectionControls.vue';
import SessionToolbar from '../ui/SessionToolbar.vue';

enableAutoUnmount(afterEach);

const connectionProps = {
  isConnected: true,
  isConnecting: false,
  reconnecting: false,
  baudRate: 115200,
  capturePaused: false,
  canClear: true,
  sendingBreak: false,
};

test('opening can be cancelled separately and closing cannot issue another open', async () => {
  const wrapper = mount(SessionConnectionControls, {
    props: { ...connectionProps, isConnected: false },
    attachTo: document.body,
  });
  const primary = wrapper.get('.connection-toggle');
  const captureControls = wrapper.findAll('.capture-action').map((button) => button.element);
  await primary.trigger('click');
  expect(wrapper.emitted('connect')).toEqual([[]]);

  await wrapper.setProps({ isConnecting: true });
  expect(primary.text()).toBe(t('serial.action.opening'));
  expect(primary.attributes('disabled')).toBeDefined();
  await primary.trigger('click');
  expect(wrapper.emitted('connect')).toHaveLength(1);
  await wrapper.get(`button[aria-label="${t('serial.action.cancelOpen')}"]`).trigger('click');
  expect(wrapper.emitted('disconnect')).toEqual([[]]);

  await wrapper.setProps({ isConnecting: false, isClosing: true });
  expect(primary.text()).toBe(t('serial.action.closing'));
  expect(primary.attributes('disabled')).toBeDefined();
  expect(wrapper.get('.connection-cancel-slot button').isVisible()).toBe(false);
  expect(wrapper.findAll('.capture-action').map((button) => button.element)).toEqual(
    captureControls,
  );

  await wrapper.setProps({ isClosing: false, isConnected: true });
  expect(primary.text()).toBe(t('serial.action.close'));
  await primary.trigger('click');
  expect(wrapper.emitted('disconnect')).toHaveLength(2);

  await wrapper.setProps({ isConnected: false, closeFailed: true });
  expect(primary.text()).toBe(t('serial.action.retryClose'));
  await primary.trigger('click');
  expect(wrapper.emitted('disconnect')).toHaveLength(3);
  expect(wrapper.emitted('connect')).toHaveLength(1);
});

test('automatic reconnection can be stopped but MCUmgr ownership locks both actions', async () => {
  const wrapper = mount(SessionConnectionControls, {
    props: { ...connectionProps, isConnected: false, reconnecting: true },
    attachTo: document.body,
  });
  expect(wrapper.get('.connection-toggle').attributes('disabled')).toBeDefined();
  const cancel = wrapper.get(`button[aria-label="${t('serial.action.cancelReconnect')}"]`);
  await cancel.trigger('click');
  expect(wrapper.emitted('disconnect')).toEqual([[]]);
  await wrapper.setProps({ connectionLocked: true });
  expect(cancel.isVisible()).toBe(false);
  await cancel.trigger('click');
  expect(wrapper.emitted('disconnect')).toHaveLength(1);
});

test('exclusive port ownership disables Break and rebinding until the port is released', async () => {
  const wrapper = mount(SessionConnectionControls, {
    props: { ...connectionProps, connectionLocked: true },
  });
  const breakButton = wrapper.get(`button[title="${t('session.break.title')}"]`);
  expect(breakButton.attributes('disabled')).toBeDefined();
  await breakButton.trigger('click');
  expect(wrapper.emitted('send-break')).toBeUndefined();

  await wrapper.setProps({ isConnected: false, needsRebind: true });
  const rebindButton = wrapper
    .findAll('button')
    .find((button) => button.text() === t('session.rebind'))!;
  expect(rebindButton.attributes('disabled')).toBeDefined();
  await rebindButton.trigger('click');
  expect(wrapper.emitted('rebind')).toBeUndefined();

  await wrapper.setProps({ connectionLocked: false });
  await rebindButton.trigger('click');
  expect(wrapper.emitted('rebind')).toEqual([[]]);
});

test('paused capture can be resumed after the device disconnects', async () => {
  const wrapper = mount(SessionConnectionControls, {
    props: { ...connectionProps, isConnected: false, capturePaused: true },
  });
  await wrapper.get(`button[title="${t('session.resume.title')}"]`).trigger('click');
  expect(wrapper.emitted('toggle-pause')).toEqual([[]]);

  await wrapper.setProps({ capturePaused: false });
  expect(wrapper.find(`button[title="${t('session.resume.title')}"]`).exists()).toBe(false);
});

test('a runtime frame count enables clearing when the optional data flag is omitted', async () => {
  const session = createSessionRecord('toolbar-capture', 'COM1', {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    rxFrameGapMs: 5,
    dtr: false,
    rts: false,
  });
  const wrapper = mount(SessionToolbar, {
    props: {
      session,
      isConnected: false,
      isConnecting: false,
      reconnecting: false,
      error: null,
      sendingBreak: false,
      isExporting: false,
      viewMode: 'terminal',
      captureFrameCount: 3,
    },
    global: { plugins: [createPinia()] },
  });
  const clearButton = wrapper
    .findAll('button')
    .find((button) => button.text() === t('session.clear'))!;
  expect(clearButton.attributes('disabled')).toBeUndefined();
  await clearButton.trigger('click');
  expect(wrapper.emitted('clear')).toEqual([[]]);

  await wrapper.setProps({ captureFrameCount: 0 });
  expect(clearButton.attributes('disabled')).toBeDefined();
});
