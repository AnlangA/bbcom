<template>
  <div ref="scrollRef" class="byte-dump scrollbar-thin" role="region" :aria-label="ariaLabel">
    <span ref="chProbeRef" class="ch-probe" aria-hidden="true">0</span>
    <div v-if="rowCount === 0" class="dump-empty">0 B</div>
    <div
      v-else
      class="byte-dump-space"
      :style="{ height: `${rowTotalSize}px`, width: `${colTotalSize}px` }"
    >
      <div
        v-for="row in visibleRows"
        :key="row.offset"
        class="detail-row"
        :style="{
          transform: `translateY(${row.start}px)`,
          width: `${colTotalSize}px`,
          height: `${rowHeight}px`,
        }"
      >
        <template v-for="col in visibleColumns" :key="col.index">
          <span
            v-if="col.kind === 'offset'"
            class="dump-offset"
            :style="{ transform: `translateX(${col.start}px)`, width: `${col.size}px` }"
            >{{ formatOffset(row.offset) }}</span
          >
          <span
            v-else-if="col.kind === 'hex' && col.byteIndex < row.bytes.length"
            class="dump-byte"
            :class="{ highlighted: byteInRange(row.offset + col.byteIndex) }"
            :style="{ transform: `translateX(${col.start}px)`, width: `${col.size}px` }"
            >{{ row.bytes[col.byteIndex]?.hex }}</span
          >
          <span
            v-else-if="col.kind === 'ascii'"
            class="dump-ascii"
            :style="{ transform: `translateX(${col.start}px)`, width: `${col.size}px` }"
            >{{ row.ascii }}</span
          >
        </template>
        <span class="sr-only">{{ row.bytes.map((byte) => byte.hex).join(' ') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { byteAscii, byteHex } from '@/lib/protocol-parser';
import {
  bindParserVirtualWheel,
  boundParserVirtualItems,
  PARSER_DUMP_BYTES_PER_ROW,
  PARSER_DUMP_COL_OVERSCAN,
  PARSER_DUMP_COLUMN_COUNT,
  PARSER_DUMP_DEFAULT_CH_PX,
  PARSER_DUMP_MAX_DOM_COLS,
  PARSER_DUMP_MAX_DOM_ROWS,
  PARSER_DUMP_ROW_HEIGHT,
  PARSER_DUMP_ROW_OVERSCAN,
  PARSER_VIRTUAL_INITIAL_RECT,
  parserFallbackVirtualItems,
  parserDumpColumnIndexForByte,
  parserDumpColumnKind,
  parserDumpColumnSizePx,
  parserDumpHexByteIndex,
  parserDumpOffsetChars,
  parserDumpRowCount,
  parserDumpRowStart,
  parserDumpTotalWidthPx,
} from '@/lib/parser-virtual-list';

const props = defineProps<{
  data: Uint8Array;
  highlight?: { start: number; end: number } | null;
  ariaLabel: string;
}>();

const scrollRef = ref<HTMLDivElement | null>(null);
const chProbeRef = ref<HTMLSpanElement | null>(null);
const chPx = ref(PARSER_DUMP_DEFAULT_CH_PX);
const rowHeight = PARSER_DUMP_ROW_HEIGHT;
const rowCount = computed(() => parserDumpRowCount(props.data.length));
const offsetChars = computed(() => parserDumpOffsetChars(props.data.length));

const dumpRowVirtualizer = useVirtualizer(
  computed(() => {
    const element = scrollRef.value;
    return {
      count: rowCount.value,
      getScrollElement: () => scrollRef.value ?? element,
      estimateSize: () => PARSER_DUMP_ROW_HEIGHT,
      overscan: PARSER_DUMP_ROW_OVERSCAN,
      initialRect: PARSER_VIRTUAL_INITIAL_RECT,
    };
  }),
);

const dumpColVirtualizer = useVirtualizer(
  computed(() => {
    const element = scrollRef.value;
    return {
      horizontal: true as const,
      count: rowCount.value === 0 ? 0 : PARSER_DUMP_COLUMN_COUNT,
      getScrollElement: () => scrollRef.value ?? element,
      estimateSize: (index: number) => parserDumpColumnSizePx(index, chPx.value, offsetChars.value),
      overscan: PARSER_DUMP_COL_OVERSCAN,
      initialRect: PARSER_VIRTUAL_INITIAL_RECT,
    };
  }),
);

const rowTotalSize = computed(() => {
  const size = dumpRowVirtualizer.value.getTotalSize();
  return size > 0 ? size : rowCount.value * PARSER_DUMP_ROW_HEIGHT;
});
const colTotalSize = computed(() => {
  const size = dumpColVirtualizer.value.getTotalSize();
  return size > 0 ? size : parserDumpTotalWidthPx(chPx.value, offsetChars.value);
});
const visibleColumns = computed(() => {
  const virtualItems = dumpColVirtualizer.value.getVirtualItems();
  const items = virtualItems.length
    ? virtualItems
    : parserFallbackVirtualItems(
        rowCount.value === 0 ? 0 : PARSER_DUMP_COLUMN_COUNT,
        (index) => parserDumpColumnSizePx(index, chPx.value, offsetChars.value),
        PARSER_DUMP_MAX_DOM_COLS,
      );
  return boundParserVirtualItems(items, PARSER_DUMP_MAX_DOM_COLS).map((item) => ({
    index: item.index,
    start: item.start,
    size: item.size,
    kind: parserDumpColumnKind(item.index),
    byteIndex: parserDumpHexByteIndex(item.index),
  }));
});
const visibleRows = computed(() => {
  const virtualItems = dumpRowVirtualizer.value.getVirtualItems();
  const items = virtualItems.length
    ? virtualItems
    : parserFallbackVirtualItems(
        rowCount.value,
        () => PARSER_DUMP_ROW_HEIGHT,
        PARSER_DUMP_MAX_DOM_ROWS,
      );
  return boundParserVirtualItems(items, PARSER_DUMP_MAX_DOM_ROWS).map((item) => {
    const offset = parserDumpRowStart(item.index);
    const slice = props.data.subarray(
      offset,
      Math.min(offset + PARSER_DUMP_BYTES_PER_ROW, props.data.length),
    );
    return {
      start: item.start,
      offset,
      bytes: Array.from(slice, (byte, index) => ({
        offset: offset + index,
        hex: byteHex(byte).toUpperCase(),
      })),
      ascii: Array.from(slice, byteAscii).join(''),
    };
  });
});

function byteInRange(offset: number): boolean {
  const range = props.highlight;
  return Boolean(range && offset >= range.start && offset < range.end);
}

function formatOffset(offset: number): string {
  return offset.toString(16).toUpperCase().padStart(offsetChars.value, '0');
}

function scrollToByte(offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || rowCount.value === 0) return;
  const index = Math.min(rowCount.value - 1, Math.floor(offset / PARSER_DUMP_BYTES_PER_ROW));
  dumpRowVirtualizer.value.scrollToIndex?.(index, { align: 'center' });
  dumpColVirtualizer.value.scrollToIndex?.(parserDumpColumnIndexForByte(offset), {
    align: 'center',
  });
}

watch(
  () => props.data,
  () => {
    const el = scrollRef.value;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
  },
);

function syncChSize() {
  const width = chProbeRef.value?.getBoundingClientRect().width ?? 0;
  if (width > 0 && width !== chPx.value) chPx.value = width;
}

let chObserver: ResizeObserver | null = null;
let unbindWheel: (() => void) | null = null;

onMounted(() => {
  syncChSize();
  if (scrollRef.value)
    unbindWheel = bindParserVirtualWheel(scrollRef.value, PARSER_DUMP_ROW_HEIGHT);
  void nextTick(() => {
    dumpRowVirtualizer.value.measure?.();
    dumpColVirtualizer.value.measure?.();
  });
  if (!scrollRef.value || typeof ResizeObserver === 'undefined') return;
  chObserver = new ResizeObserver(syncChSize);
  chObserver.observe(scrollRef.value);
});

onUnmounted(() => {
  unbindWheel?.();
  unbindWheel = null;
  chObserver?.disconnect();
  chObserver = null;
});

defineExpose({ scrollToByte });
</script>

<style scoped>
.byte-dump {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
}

.byte-dump-space {
  position: relative;
  min-width: 100%;
}

.ch-probe {
  position: absolute;
  width: 1ch;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.dump-empty {
  display: grid;
  min-height: 120px;
  place-items: center;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
}

.detail-row {
  position: absolute;
  top: 0;
  left: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.dump-offset,
.dump-byte,
.dump-ascii {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  height: 100%;
  box-sizing: border-box;
}

.dump-offset {
  color: var(--text-dim);
}

.dump-byte {
  justify-content: center;
  border-radius: 2px;
  color: var(--accent-blue);
  font-variant-numeric: tabular-nums;
}

.dump-byte.highlighted {
  color: var(--text-primary);
  background: var(--color-primary-muted);
  outline: 2px solid var(--color-primary-muted);
}

.dump-ascii {
  color: var(--text-secondary);
  white-space: pre;
}
</style>
