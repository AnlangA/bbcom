// @vitest-environment happy-dom

import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { usePacketVirtualScroll } from '@/features/terminal/application/use-packet-virtual-scroll.ts';

type FrameCallback = (time: number) => void;

test('auto-scroll pins while parked at the tail, ignores frames while unpinned or disabled, and re-pins on re-enable', async () => {
  vi.useFakeTimers();
  const rafCallbacks: FrameCallback[] = [];
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameCallback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  };
  try {
    const frames = ref(5);
    const auto = ref(true);
    const captured: ReturnType<typeof usePacketVirtualScroll>[] = [];
    const Host = defineComponent({
      setup() {
        const api = usePacketVirtualScroll({ frameCount: frames, autoScroll: auto });
        captured.push(api);
        return () => h('div');
      },
    });
    const wrapper = mount(Host);
    await nextTick();
    const api = captured[0]!;

    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });
    api.scrollRef.value = scroller as HTMLDivElement;

    // Parked at the tail (max scrollTop = scrollHeight - clientHeight = 1200):
    // a frame arrival schedules exactly one coalesced RAF that snaps to the
    // tail.
    scroller.scrollTop = 1200;
    api.onScroll();
    frames.value += 1;
    await nextTick();
    assert.equal(rafCallbacks.length, 1, 'one coalesced pin scheduled');
    rafCallbacks[0]!(0);
    assert.equal(scroller.scrollTop, 2000, 'pin jumps to the tail');

    // Parked far above the bottom: frame arrivals schedule nothing.
    scroller.scrollTop = 0;
    api.onScroll();
    rafCallbacks.length = 0;
    frames.value += 1;
    await nextTick();
    assert.equal(rafCallbacks.length, 0, 'no pin while unpinned');

    // Auto-scroll disabled: even parked at the tail, nothing schedules.
    auto.value = false;
    scroller.scrollTop = 1200;
    api.onScroll();
    rafCallbacks.length = 0;
    frames.value += 1;
    await nextTick();
    assert.equal(rafCallbacks.length, 0, 'no pin while auto-scroll disabled');

    // Re-enabling clears the unpinned state and schedules exactly one pin
    // even before the next frame arrives.
    scroller.scrollTop = 0;
    api.onScroll();
    rafCallbacks.length = 0;
    auto.value = true;
    await nextTick();
    assert.equal(rafCallbacks.length, 1, 'enabling auto-scroll pins immediately');
    rafCallbacks[0]!(0);
    assert.equal(scroller.scrollTop, 2000, 'tail restored after re-enable');

    wrapper.unmount();
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    vi.useRealTimers();
  }
});
