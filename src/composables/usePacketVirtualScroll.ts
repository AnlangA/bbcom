import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import type { DataFrame } from '../types';

interface PacketVirtualScrollOptions {
  visibleFrames: Ref<DataFrame[]>;
  frameCount: Ref<number>;
  autoScroll: Ref<boolean>;
}

const ROW_HEIGHT = 28;

/**
 * Virtual scrolling for the packet list.
 *
 * Rows are a fixed height (ROW_HEIGHT), so the virtualizer never needs a manual
 * `measure()` call: @tanstack/vue-virtual recomputes the visible range on its
 * own internal scroll/resize listeners, and `useVirtualizer` re-derives the
 * instance whenever `count` changes (the options are a computed). Calling
 * `measure()` on every scroll tick (as this previously did) forced a full O(n)
 * offset recompute on every frame of auto-scroll — the dominant scroll jank.
 */
export function usePacketVirtualScroll({
  visibleFrames,
  frameCount,
  autoScroll,
}: PacketVirtualScrollOptions) {
  const scrollRef = ref<HTMLDivElement | null>(null);
  const shouldAutoScroll = ref(true);

  const virtualizer = useVirtualizer(
    computed(() => ({
      count: visibleFrames.value.length,
      getScrollElement: () => scrollRef.value,
      estimateSize: () => ROW_HEIGHT,
      overscan: 15,
    })),
  );

  const virtualItems = computed(() => virtualizer.value.getVirtualItems());
  const totalSize = computed(() => virtualizer.value.getTotalSize());

  function onScroll() {
    if (!scrollRef.value) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.value;
    // Track whether the user is parked near the bottom so new frames can
    // auto-scroll only when appropriate. The virtualizer handles its own range
    // updates on scroll — we do NOT remeasure here.
    shouldAutoScroll.value = scrollHeight - scrollTop - clientHeight < ROW_HEIGHT * 2;
  }

  watch(frameCount, () => {
    if (shouldAutoScroll.value && autoScroll.value) {
      void nextTick(() => {
        requestAnimationFrame(() => {
          if (scrollRef.value) {
            scrollRef.value.scrollTo({
              top: scrollRef.value.scrollHeight,
              behavior: 'smooth',
            });
          }
        });
      });
    }
  });

  return {
    scrollRef,
    virtualItems,
    totalSize,
    onScroll,
  };
}
