import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type ComponentPublicInstance,
  type Ref,
} from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { isPinnedToBottom } from '@/features/terminal/application/use-packet-virtual-scroll';
import {
  PARSER_LIST_COL_OVERSCAN,
  PARSER_LIST_COLUMN_GAP,
  PARSER_LIST_ROW_HEIGHT,
  PARSER_LIST_ROW_OVERSCAN,
  PARSER_LIST_ROW_PAD,
  PARSER_VIRTUAL_INITIAL_RECT,
  parserFallbackVirtualItems,
  parserListColumns,
  parserListContentWidth,
  parserListTotalHeight,
  type ParserListKind,
} from '@/lib/parser-virtual-list';

interface ParserRecordListOptions {
  recordCount: Ref<number>;
  listKind: Ref<ParserListKind>;
  autoScroll: Ref<boolean>;
  itemKey: (index: number) => string | number;
}

export function useParserRecordList({
  recordCount,
  listKind,
  autoScroll,
  itemKey,
}: ParserRecordListOptions) {
  const scrollRef = ref<HTMLDivElement | null>(null);
  const shouldAutoScroll = ref(true);

  const rowVirtualizer = useVirtualizer(
    computed(() => {
      const element = scrollRef.value;
      return {
        count: recordCount.value,
        getScrollElement: () => scrollRef.value ?? element,
        estimateSize: () => PARSER_LIST_ROW_HEIGHT,
        getItemKey: itemKey,
        overscan: PARSER_LIST_ROW_OVERSCAN,
        initialRect: PARSER_VIRTUAL_INITIAL_RECT,
      };
    }),
  );

  const columnVirtualizer = useVirtualizer(
    computed(() => {
      const element = scrollRef.value;
      const columns = parserListColumns(listKind.value);
      return {
        horizontal: true as const,
        count: columns.length,
        getScrollElement: () => scrollRef.value ?? element,
        estimateSize: (index: number) => columns[index]?.width ?? 48,
        overscan: PARSER_LIST_COL_OVERSCAN,
        paddingStart: PARSER_LIST_ROW_PAD,
        paddingEnd: PARSER_LIST_ROW_PAD,
        gap: PARSER_LIST_COLUMN_GAP,
        initialRect: PARSER_VIRTUAL_INITIAL_RECT,
      };
    }),
  );

  const listTotalHeight = computed(() => parserListTotalHeight(recordCount.value));
  const listTotalWidth = computed(() => {
    const measured = columnVirtualizer.value.getTotalSize();
    return measured > 0 ? measured : parserListContentWidth(listKind.value);
  });

  const virtualRows = computed(() => {
    const virtualItems = rowVirtualizer.value.getVirtualItems();
    const items =
      virtualItems.length > 0
        ? virtualItems
        : parserFallbackVirtualItems(
            recordCount.value,
            () => PARSER_LIST_ROW_HEIGHT,
            recordCount.value,
          );
    return items.map((item) => ({
      index: item.index,
      start: item.start,
      size: item.size,
    }));
  });

  const visibleListColumns = computed(() => {
    const columns = parserListColumns(listKind.value);
    const virtualItems = columnVirtualizer.value.getVirtualItems();
    const items =
      virtualItems.length > 0
        ? virtualItems
        : parserFallbackVirtualItems(
            columns.length,
            (index) => columns[index]?.width ?? 48,
            columns.length,
          );
    return items.flatMap((item) => {
      const column = columns[item.index];
      return column ? [{ key: column.key, start: item.start, size: item.size }] : [];
    });
  });

  function remeasure() {
    rowVirtualizer.value.measure?.();
    columnVirtualizer.value.measure?.();
  }

  watch(scrollRef, (element) => {
    if (!element) return;
    remeasure();
  });

  function measureElement(element: Element | ComponentPublicInstance | null) {
    rowVirtualizer.value.measureElement(element as Element | null);
  }

  function scrollToIndex(index: number) {
    rowVirtualizer.value.scrollToIndex(index, { align: 'start' });
  }

  function onScroll() {
    if (!scrollRef.value) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.value;
    shouldAutoScroll.value = isPinnedToBottom(scrollTop, scrollHeight, clientHeight);
  }

  let autoScrollRafId: number | null = null;

  function pinToBottom() {
    autoScrollRafId = null;
    const element = scrollRef.value;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }

  watch(recordCount, () => {
    if (!shouldAutoScroll.value || !autoScroll.value) return;
    if (autoScrollRafId !== null) return;
    autoScrollRafId = requestAnimationFrame(pinToBottom);
  });

  watch(autoScroll, (enabled) => {
    if (!enabled) return;
    shouldAutoScroll.value = true;
    if (autoScrollRafId === null) {
      autoScrollRafId = requestAnimationFrame(pinToBottom);
    }
  });

  let resizeObserver: ResizeObserver | null = null;

  onMounted(() => {
    void nextTick(remeasure);
    const element = scrollRef.value;
    if (!element || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(() => remeasure());
    resizeObserver.observe(element);
  });

  onUnmounted(() => {
    if (autoScrollRafId !== null) {
      cancelAnimationFrame(autoScrollRafId);
      autoScrollRafId = null;
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  return {
    scrollRef,
    virtualRows,
    visibleListColumns,
    listTotalHeight,
    listTotalWidth,
    measureElement,
    onScroll,
    scrollToIndex,
  };
}
