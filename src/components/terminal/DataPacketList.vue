<template>
  <div class="packet-list">
    <div class="packet-toolbar">
      <div class="filter-left">
        <n-button-group size="tiny">
          <n-button :type="dirFilter === 'ALL' ? 'primary' : 'default'" @click="dirFilter = 'ALL'">全部</n-button>
          <n-button :type="dirFilter === 'TX' ? 'primary' : 'default'" @click="dirFilter = 'TX'">TX</n-button>
          <n-button :type="dirFilter === 'RX' ? 'primary' : 'default'" @click="dirFilter = 'RX'">RX</n-button>
        </n-button-group>
        <n-input
          v-model:value="searchInput"
          placeholder="搜索数据..."
          size="tiny"
          clearable
          style="width: 160px"
        />
      </div>
      <div class="filter-right">
        <span class="frame-count">{{ filteredFrames.length }} / {{ frames.length }}</span>
      </div>
    </div>
    <div class="packet-row packet-header" :style="gridStyle">
      <span class="col-dir">方向</span>
      <span v-if="appStore.showTimestamp" class="col-time">时间</span>
      <span class="col-data">数据</span>
      <span class="col-mode">模式</span>
    </div>
    <div ref="scrollRef" class="packet-items" @scroll="onScroll">
      <div :style="{ height: `${totalSize}px`, width: '100%', position: 'relative' }">
        <div
          v-for="row in virtualItems"
          :key="filteredFrames[row.index].id"
          :style="{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${row.size}px`,
            transform: `translateY(${row.start}px)`,
          }"
          class="packet-row packet-item"
          :class="{ tx: filteredFrames[row.index].direction === 'TX', rx: filteredFrames[row.index].direction === 'RX' }"
          @contextmenu.prevent="(e: MouseEvent) => showContextMenu(e, filteredFrames[row.index])"
        >
          <span class="col-dir direction">{{ filteredFrames[row.index].direction }}</span>
          <span v-if="appStore.showTimestamp" class="col-time timestamp">{{ filteredFrames[row.index].timestamp }}</span>
          <span class="col-data data">{{ formatData(filteredFrames[row.index]) }}</span>
          <span class="col-mode mode">{{ displayLabel() }}</span>
        </div>
      </div>
    </div>
    <n-dropdown
      :x="ctxX"
      :y="ctxY"
      :show="ctxShow"
      :options="ctxOptions"
      placement="bottom-start"
      @select="handleCtxSelect"
      @clickoutside="ctxShow = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { NButtonGroup, NButton, NInput, NDropdown, useMessage } from 'naive-ui';
import { useAppStore } from '../../stores/app';
import { formatHex } from '../../lib/hex';
import type { DataFrame } from '../../types';

const props = defineProps<{
  frames: DataFrame[];
}>();

const appStore = useAppStore();
const message = useMessage();
const scrollRef = ref<HTMLDivElement | null>(null);

const ROW_HEIGHT = 28;
const shouldAutoScroll = ref(true);
const searchInput = ref('');
const searchQuery = ref('');
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const ctxShow = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
let ctxFrame: DataFrame | null = null;

const ctxOptions = [
  { label: '复制 HEX', key: 'hex' },
  { label: '复制 ASCII', key: 'ascii' },
  { label: '复制完整行', key: 'row' },
];

watch(searchInput, (val) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery.value = val;
  }, 150);
});

const dirFilter = ref<'ALL' | 'TX' | 'RX'>('ALL');

const gridStyle = computed(() => ({
  gridTemplateColumns: appStore.showTimestamp ? '50px 160px 1fr 50px' : '50px 1fr 50px',
}));

const textDecoder = new TextDecoder();
const formatCache = new Map<string, string>();

function formatData(frame: DataFrame): string {
  const key = `${frame.id}:${appStore.displayMode}`;
  const cached = formatCache.get(key);
  if (cached !== undefined) return cached;
  const result = appStore.displayMode === 'HEX'
    ? formatHex(frame.data)
    : textDecoder.decode(new Uint8Array(frame.data));
  formatCache.set(key, result);
  if (formatCache.size > 12000) {
    const keys = [...formatCache.keys()];
    for (let i = 0; i < 2000; i++) formatCache.delete(keys[i]!);
  }
  return result;
}

const filteredFrames = computed(() => {
  let result = props.frames;
  if (dirFilter.value !== 'ALL') {
    result = result.filter((f) => f.direction === dirFilter.value);
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase();
    result = result.filter((f) => {
      const hex = formatHex(f.data).toLowerCase();
      const ascii = textDecoder.decode(new Uint8Array(f.data)).toLowerCase();
      return hex.includes(q) || ascii.includes(q);
    });
  }
  return result;
});

const virtualizer = useVirtualizer(
  computed(() => ({
    count: filteredFrames.value.length,
    getScrollElement: () => scrollRef.value,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  })),
);

const virtualItems = computed(() => virtualizer.value.getVirtualItems());
const totalSize = computed(() => virtualizer.value.getTotalSize());

function onScroll() {
  if (!scrollRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = scrollRef.value;
  shouldAutoScroll.value = scrollHeight - scrollTop - clientHeight < ROW_HEIGHT * 2;
  virtualizer.value.measure();
}

watch(
  () => props.frames.length,
  () => {
    virtualizer.value.measure();
    if (shouldAutoScroll.value && appStore.autoScroll) {
      nextTick(() => {
        requestAnimationFrame(() => {
          if (scrollRef.value) {
            scrollRef.value.scrollTop = scrollRef.value.scrollHeight;
          }
        });
      });
    }
  },
);

function displayLabel(): string {
  return appStore.displayMode;
}

function showContextMenu(e: MouseEvent, frame: DataFrame) {
  ctxFrame = frame;
  ctxX.value = e.clientX;
  ctxY.value = e.clientY;
  ctxShow.value = true;
}

async function handleCtxSelect(key: string) {
  ctxShow.value = false;
  if (!ctxFrame) return;
  let text = '';
  switch (key) {
    case 'hex':
      text = formatHex(ctxFrame.data);
      break;
    case 'ascii':
      text = textDecoder.decode(new Uint8Array(ctxFrame.data));
      break;
    case 'row':
      text = `[${ctxFrame.timestamp}] ${ctxFrame.direction} | ${formatHex(ctxFrame.data)}`;
      break;
  }
  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch {
    // clipboard not available
  }
}
</script>

<style scoped>
.packet-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.packet-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  background: #252526;
  border-bottom: 1px solid #3c3c3c;
}

.filter-left {
  display: flex;
  gap: 6px;
  align-items: center;
}

.filter-right {
  font-size: 11px;
  color: #888;
  font-family: var(--font-mono);
}

.frame-count {
  color: #888;
}

.packet-row {
  display: grid;
  gap: 6px;
  padding: 4px 8px;
  font-family: 'Menlo', 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  line-height: 20px;
  align-items: center;
}

.packet-header {
  font-weight: 600;
  border-bottom: 1px solid #3c3c3c;
  color: #999;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: #2a2a2a;
  position: sticky;
  top: 0;
  z-index: 1;
}

.packet-items {
  overflow-y: auto;
  flex: 1;
}

.packet-item {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  transition: background 0.15s;
  cursor: pointer;
}

.packet-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.packet-item.tx .direction {
  color: #4caf50;
  font-weight: 600;
}

.packet-item.rx .direction {
  color: #42a5f5;
  font-weight: 600;
}

.col-dir { text-align: center; }
.col-time { color: #888; white-space: nowrap; }
.col-data { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-mode { text-align: center; color: #666; font-size: 10px; }
</style>
