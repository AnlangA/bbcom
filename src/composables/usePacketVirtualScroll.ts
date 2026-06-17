import { computed, onUnmounted, ref, watch, type Ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';

interface PacketVirtualScrollOptions {
  frameCount: Ref<number>;
  autoScroll: Ref<boolean>;
}

const ROW_HEIGHT = 28;

/**
 * Pure threshold test for "user is parked near the bottom of the scroll area",
 * exported for unit testing. New frames should auto-scroll only when this is
 * true. The 2× row-height slack lets the user scroll up a little without
 * immediately losing auto-follow.
 */
export function isPinnedToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < ROW_HEIGHT * 2;
}

/**
 * Virtual scrolling for the packet list.
 *
 * Rows are a fixed height (ROW_HEIGHT), so the virtualizer never needs a manual
 * `measure()` call: @tanstack/vue-virtual recomputes the visible range on its
 * own internal scroll/resize listeners, and `useVirtualizer` re-derives the
 * instance whenever `count` changes (the options are a computed). Calling
 * `measure()` on every scroll tick (as this previously did) forced a full O(n)
 * offset recompute on every frame of auto-scroll — the dominant scroll jank.
 *
 * Auto-scroll is coalesced through a single in-flight RAF guard. At high baud
 * `frameCount` can tick once per flush; without coalescing every tick queued
 * its own `nextTick → RAF → scrollTo({ behavior: 'smooth' })`, and the resulting
 * competing smooth-scroll animations fought each other for the scroll position.
 * Now at most one RAF is ever pending, and streaming pins the tail with an
 * instant jump (no animation) so it tracks the data rate instead of lagging it
 * — the behavior of every professional serial terminal.
 */
export function usePacketVirtualScroll({ frameCount, autoScroll }: PacketVirtualScrollOptions) {
  const scrollRef = ref<HTMLDivElement | null>(null);
  const shouldAutoScroll = ref(true);

  const virtualizer = useVirtualizer(
    computed(() => ({
      count: frameCount.value,
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
    shouldAutoScroll.value = isPinnedToBottom(scrollTop, scrollHeight, clientHeight);
  }

  // Single-flight auto-scroll: a non-null rafId means a pin-to-bottom is
  // already scheduled, so further frame-count ticks within the same frame are
  // folded into the one pending jump.
  let autoScrollRafId: number | null = null;

  function pinToBottom() {
    autoScrollRafId = null;
    const el = scrollRef.value;
    if (!el) return;
    // Instant jump (not smooth): during streaming, an animated scroll lags the
    // data rate and visibly stutters. Pinning the tail directly keeps the
    // newest frame in view at any baud.
    el.scrollTop = el.scrollHeight;
  }

  watch(frameCount, () => {
    if (!shouldAutoScroll.value || !autoScroll.value) return;
    if (autoScrollRafId !== null) return; // already scheduled — coalesce
    autoScrollRafId = requestAnimationFrame(pinToBottom);
  });

  onUnmounted(() => {
    if (autoScrollRafId !== null) {
      cancelAnimationFrame(autoScrollRafId);
      autoScrollRafId = null;
    }
  });

  return {
    scrollRef,
    virtualItems,
    totalSize,
    onScroll,
  };
}
