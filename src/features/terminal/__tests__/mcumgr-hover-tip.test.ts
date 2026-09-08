// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { h } from 'vue';
import { NTooltip } from 'naive-ui';
import McumgrHoverTip from '../ui/mcumgr/McumgrHoverTip.vue';

enableAutoUnmount(afterEach);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function mountTip() {
  const action = vi.fn();
  const keydown = vi.fn();
  const wrapper = mount(McumgrHoverTip, {
    attachTo: document.body,
    props: { text: 'Read image state' },
    slots: { default: () => h('button', { onClick: action, onKeydown: keydown }, 'Read') },
  });
  const trigger = wrapper.get('.mc-hover-tip');
  const tooltip = wrapper.getComponent(NTooltip);
  return { wrapper, trigger, tooltip, action, keydown };
}

test('click dismisses visible help without swallowing the action and a new hover can reopen it', async () => {
  const { wrapper, trigger, tooltip, action } = mountTip();
  await trigger.trigger('mouseenter');
  await vi.advanceTimersByTimeAsync(200);
  expect(tooltip.props('show')).toBe(true);

  await wrapper.get('button').trigger('click');
  expect(action).toHaveBeenCalledOnce();
  expect(tooltip.props('show')).toBe(false);

  tooltip.vm.$emit('update:show', true);
  await wrapper.vm.$nextTick();
  expect(tooltip.props('show')).toBe(false);

  await trigger.trigger('mouseleave');
  await trigger.trigger('mouseenter');
  await vi.advanceTimersByTimeAsync(200);
  expect(tooltip.props('show')).toBe(true);
});

test('pointer activation cancels a pending hover reveal before the click action runs', async () => {
  const { wrapper, trigger, tooltip, action } = mountTip();
  await trigger.trigger('mouseenter');
  await vi.advanceTimersByTimeAsync(100);
  await wrapper.get('button').trigger('pointerdown');
  await vi.advanceTimersByTimeAsync(200);
  expect(tooltip.props('show')).toBe(false);
  expect(action).not.toHaveBeenCalled();

  await wrapper.get('button').trigger('click');
  expect(action).toHaveBeenCalledOnce();
  expect(tooltip.props('show')).toBe(false);
});

test.each(['Enter', ' '])(
  'keyboard activation with %j dismisses help and preserves the slot event',
  async (key) => {
    const { wrapper, trigger, tooltip, keydown } = mountTip();
    await trigger.trigger('mouseenter');
    await vi.advanceTimersByTimeAsync(200);
    expect(tooltip.props('show')).toBe(true);

    await wrapper.get('button').trigger('keydown', { key });
    expect(keydown).toHaveBeenCalledOnce();
    expect((keydown.mock.calls[0][0] as KeyboardEvent).defaultPrevented).toBe(false);
    expect(tooltip.props('show')).toBe(false);
  },
);

test('disabling help closes it without reopening when the command finishes under the pointer', async () => {
  const { wrapper, trigger, tooltip } = mountTip();
  await trigger.trigger('mouseenter');
  await vi.advanceTimersByTimeAsync(200);
  expect(tooltip.props('show')).toBe(true);

  await wrapper.setProps({ disabled: true });
  expect(tooltip.props('show')).toBe(false);
  await wrapper.setProps({ disabled: false });
  tooltip.vm.$emit('update:show', true);
  await wrapper.vm.$nextTick();
  expect(tooltip.props('show')).toBe(false);

  await trigger.trigger('mouseleave');
  await trigger.trigger('mouseenter');
  await vi.advanceTimersByTimeAsync(200);
  expect(tooltip.props('show')).toBe(true);
});
