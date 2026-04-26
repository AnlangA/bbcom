import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import type { DataFrame } from '../types';

interface PacketVirtualScrollOptions {
  visibleFrames: Ref<DataFrame[]>;
  frameCount: Ref<number>;
  autoScroll: Ref<boolean>;
}

const ROW_HEIGHT = 28;

export function usePacketVirtualScroll({
  visibleFrames,
  frameCount,
  autoScroll,
}: PacketVirtualScrollOptions) {
  const scrollRef = ref<HTMLDivElement | null>(null);
  const shouldAutoScroll = ref(true);
  let measureTimer: ReturnType<typeof setTimeout> | null = null;

  const virtualizer = useVirtualizer(
    computed(() => ({
      count: visibleFrames.value.length,
      getScrollElement: () => scrollRef.value,
      estimateSize: () => ROW_HEIGHT,
      overscan: 20,
    })),
  );

  const virtualItems = computed(() => virtualizer.value.getVirtualItems());
  const totalSize = computed(() => virtualizer.value.getTotalSize());

  function scheduleMeasure() {
    if (measureTimer) return;
    measureTimer = setTimeout(() => {
      measureTimer = null;
      virtualizer.value.measure();
    }, 80);
  }

  function onScroll() {
    if (!scrollRef.value) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.value;
    shouldAutoScroll.value = scrollHeight - scrollTop - clientHeight < ROW_HEIGHT * 2;
    scheduleMeasure();
  }

  watch(frameCount, () => {
    virtualizer.value.measure();
    if (shouldAutoScroll.value && autoScroll.value) {
      void nextTick(() => {
        requestAnimationFrame(() => {
          if (scrollRef.value) {
            scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
          }
        });
      });
    }
  });

  watch(visibleFrames, () => {
    virtualizer.value.measure();
  });

  return {
    scrollRef,
    virtualItems,
    totalSize,
    onScroll,
  };
}
