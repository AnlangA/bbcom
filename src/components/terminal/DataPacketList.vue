<template>
  <div class="packet-list">
    <div class="packet-toolbar">
      <div class="filter-left">
        <n-select
          v-model:value="dirFilter"
          :options="directionOptions"
          size="tiny"
          style="width: 86px"
        />
        <n-input
          v-model:value="searchInput"
          :placeholder="appStore.searchMode === 'HEX' ? '搜索 HEX...' : '搜索文本...'"
          size="tiny"
          clearable
          style="width: 160px"
        />
        <n-button-group size="tiny">
          <n-button :type="appStore.searchMode === 'TEXT' ? 'primary' : 'default'" @click="appStore.setSearchMode('TEXT')">文本</n-button>
          <n-button :type="appStore.searchMode === 'HEX' ? 'primary' : 'default'" @click="appStore.setSearchMode('HEX')">HEX</n-button>
        </n-button-group>
        <n-button-group size="tiny">
          <n-button :type="appStore.packetViewMode === 'FRAME' ? 'primary' : 'default'" @click="appStore.setPacketViewMode('FRAME')">按帧</n-button>
          <n-button :type="appStore.packetViewMode === 'MERGED' ? 'primary' : 'default'" @click="appStore.setPacketViewMode('MERGED')">合并</n-button>
        </n-button-group>
      </div>
      <div class="filter-right">
        <n-dropdown :options="copyOptions" @select="handleCopySelect" :disabled="filteredFrames.length === 0">
          <n-button size="tiny" quaternary :disabled="filteredFrames.length === 0">复制</n-button>
        </n-dropdown>
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
          :key="visibleFrames[row.index].id"
          :style="{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${row.size}px`,
            transform: `translateY(${row.start}px)`,
            ...gridStyle,
          }"
          class="packet-row packet-item"
          :class="{ tx: visibleFrames[row.index].direction === 'TX', rx: visibleFrames[row.index].direction === 'RX' }"
          @contextmenu.prevent="(e: MouseEvent) => showContextMenu(e, visibleFrames[row.index])"
        >
          <span class="col-dir direction">{{ visibleFrames[row.index].direction }}</span>
          <span v-if="appStore.showTimestamp" class="col-time timestamp">{{ visibleFrames[row.index].timestamp }}</span>
          <span
            v-if="appStore.displayMode === 'ANSI'"
            class="col-data data ansi-data"
            v-html="formatData(visibleFrames[row.index])"
          ></span>
          <span v-else class="col-data data">{{ formatData(visibleFrames[row.index]) }}</span>
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
import { NButtonGroup, NButton, NInput, NDropdown, NSelect, useMessage } from 'naive-ui';
import { useAppStore } from '../../stores/app';
import { formatHex, formatUtf8, formatAscii } from '../../lib/format';
import { LRUCache } from '../../lib/lru-cache';
import { CACHE_SIZE } from '../../types';
import AnsiToHtml from 'ansi-to-html';
import type { DataFrame, DirectionFilter } from '../../types';

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
  { label: '复制 UTF-8', key: 'utf8' },
  { label: '复制纯文本 (无 ANSI)', key: 'plain' },
  { label: '复制完整行', key: 'row' },
];

const copyOptions = [
  { label: '复制当前筛选 HEX', key: 'filtered-hex' },
  { label: '复制当前筛选文本', key: 'filtered-text' },
  { label: '复制全部 HEX', key: 'all-hex' },
  { label: '复制全部文本', key: 'all-text' },
];

watch(searchInput, (val) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery.value = val;
  }, 150);
});

const dirFilter = ref<DirectionFilter>('ALL');
const directionOptions: { label: string; value: DirectionFilter }[] = [
  { label: '全部', value: 'ALL' },
  { label: 'TX', value: 'TX' },
  { label: 'RX', value: 'RX' },
];

const gridStyle = computed(() => ({
  gridTemplateColumns: appStore.showTimestamp ? '50px 160px 1fr 50px' : '50px 1fr 50px',
}));

const formatCache = new LRUCache<string, string>(CACHE_SIZE);
const ansiConverter = new AnsiToHtml({
  fg: '#e5e5e5',
  bg: '#1a1a1a',
  newline: false,
  escapeXML: true,
  stream: false,
});

function getFormattedData(frame: DataFrame): string {
  const key = `${frame.id}:${appStore.displayMode}`;
  const cached = formatCache.get(key);
  if (cached !== undefined) return cached;

  let result: string;
  switch (appStore.displayMode) {
    case 'HEX':
      result = formatHex(frame.data);
      break;
    case 'ANSI':
      result = ansiConverter.toHtml(formatAscii(frame.data));
      break;
    case 'UTF8':
      result = formatUtf8(frame.data);
      break;
    case 'ASCII':
    default:
      result = formatAscii(frame.data);
      break;
  }

  formatCache.set(key, result);
  return result;
}

function stripAnsi(text: string): string {
  return text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
}

function formatData(frame: DataFrame): string {
  return getFormattedData(frame);
}

// Clear cache when frames are trimmed
watch(() => props.frames.length, (newLen, oldLen) => {
  if (newLen < oldLen) {
    formatCache.clear();
  }
});

const filteredFrames = computed(() => {
  let result = props.frames;
  if (dirFilter.value !== 'ALL') {
    result = result.filter((f) => f.direction === dirFilter.value);
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.trim().toLowerCase();
    result = result.filter((f) => {
      if (appStore.searchMode === 'HEX') {
        const needle = q.replace(/[^0-9a-f]/g, '');
        return formatHex(f.data).replace(/\s/g, '').toLowerCase().includes(needle);
      }
      let formatted = getFormattedData(f);
      if (appStore.displayMode === 'ANSI') {
        formatted = stripAnsi(formatted);
      }
      return formatted.toLowerCase().includes(q);
    });
  }
  return result;
});

const visibleFrames = computed<DataFrame[]>(() => {
  if (appStore.packetViewMode === 'FRAME') return filteredFrames.value;
  const merged: DataFrame[] = [];
  let current: DataFrame | null = null;
  for (const frame of filteredFrames.value) {
    if (!current || current.direction !== frame.direction) {
      current = { ...frame, id: `merged-${frame.id}`, data: [...frame.data] };
      merged.push(current);
    } else {
      current.data = current.data.concat(frame.data);
    }
  }
  return merged;
});

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
  return appStore.packetViewMode === 'MERGED' ? `${appStore.displayMode}*` : appStore.displayMode;
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
      text = formatAscii(ctxFrame.data);
      break;
    case 'utf8':
      text = formatUtf8(ctxFrame.data);
      break;
    case 'plain':
      text = stripAnsi(formatAscii(ctxFrame.data));
      break;
    case 'row':
      text = `[${ctxFrame.timestamp}] ${ctxFrame.direction} | ${getFormattedData(ctxFrame)}`;
      break;
  }

  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch {
    message.error('复制失败');
  }
}

async function handleCopySelect(key: string) {
  const frames = key.startsWith('all') ? props.frames : filteredFrames.value;
  const asHex = key.endsWith('hex');
  const text = frames.map((frame) => {
    const data = asHex ? formatHex(frame.data) : formatUtf8(frame.data);
    return `[${frame.timestamp}] ${frame.direction} | ${data}`;
  }).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch {
    message.error('复制失败');
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
  padding: 7px 10px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.filter-left {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
}

.filter-right {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  display: flex;
  align-items: center;
  gap: 8px;
}

.frame-count {
  color: var(--text-muted);
}

.packet-row {
  display: grid;
  gap: 8px;
  padding: 3px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 22px;
  align-items: center;
}

.packet-header {
  font-weight: 600;
  border-bottom: 1px solid var(--border-subtle);
  border-left: 2px solid transparent;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--bg-tertiary);
  position: sticky;
  top: 0;
  z-index: 1;
  padding-left: 8px;
}

.packet-items {
  overflow-y: auto;
  flex: 1;
  background: var(--bg-primary);
}

.packet-item {
  border-bottom: 1px solid var(--border-subtle);
  transition: background var(--transition-fast);
  cursor: pointer;
}

.packet-item:hover {
  background: var(--bg-hover);
}

.packet-item.tx .direction {
  color: var(--accent-green);
  font-weight: 700;
}

.packet-item.rx .direction {
  color: var(--accent-blue);
  font-weight: 700;
}

.packet-item.tx {
  border-left: 2px solid var(--accent-green);
  padding-left: 8px;
}

.packet-item.rx {
  border-left: 2px solid var(--accent-blue);
  padding-left: 8px;
}

.col-dir {
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.5px;
}

.col-time {
  color: var(--text-muted);
  white-space: nowrap;
  font-size: 11px;
}

.col-data {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.3px;
}

.ansi-data {
  white-space: pre-wrap;
  word-break: break-all;
}

.col-mode {
  text-align: center;
  color: var(--text-dim);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
</style>
