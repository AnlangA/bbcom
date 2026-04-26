<template>
  <div class="packet-list">
    <div class="packet-toolbar">
      <div class="filter-left">
        <n-select
          v-model:value="directionFilter"
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
      <div v-if="visibleFrames.length === 0" class="packet-empty">
        {{ frames.length === 0 ? '暂无串口数据' : '没有匹配的数据帧' }}
      </div>
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
            v-if="appStore.displayMode !== 'HEX' && appStore.ansiColorEnabled"
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
import { computed, ref, toRef, watch } from 'vue';
import { NButtonGroup, NButton, NInput, NDropdown, NSelect, useMessage } from 'naive-ui';
import { useAppStore } from '../../stores/app';
import { formatHex, formatUtf8, formatAscii } from '../../lib/format';
import { usePacketFilter } from '../../composables/usePacketFilter';
import { usePacketFormatter } from '../../composables/usePacketFormatter';
import { usePacketVirtualScroll } from '../../composables/usePacketVirtualScroll';
import type { DataFrame, DirectionFilter } from '../../types';

const props = defineProps<{
  frames: DataFrame[];
}>();

const appStore = useAppStore();
const message = useMessage();
const framesRef = toRef(props, 'frames');

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

const directionOptions: { label: string; value: DirectionFilter }[] = [
  { label: '全部', value: 'ALL' },
  { label: 'TX', value: 'TX' },
  { label: 'RX', value: 'RX' },
];

const gridStyle = computed(() => ({
  gridTemplateColumns: appStore.showTimestamp ? '50px 160px 1fr 50px' : '50px 1fr 50px',
}));

const {
  formatFrame,
  getHexSearchData,
  getTextSearchData,
  stripAnsi,
  clearCaches,
} = usePacketFormatter({
  displayMode: computed(() => appStore.displayMode),
  ansiColorEnabled: computed(() => appStore.ansiColorEnabled),
});

function formatData(frame: DataFrame): string {
  return formatFrame(frame);
}

watch(() => props.frames.length, (newLen, oldLen) => {
  if (newLen < oldLen) {
    clearCaches();
  }
});

const {
  directionFilter,
  searchInput,
  filteredFrames,
  visibleFrames,
} = usePacketFilter({
  frames: framesRef,
  searchMode: computed(() => appStore.searchMode),
  packetViewMode: computed(() => appStore.packetViewMode),
  getHexSearchData,
  getTextSearchData,
});

const {
  scrollRef,
  virtualItems,
  totalSize,
  onScroll,
} = usePacketVirtualScroll({
  visibleFrames,
  frameCount: computed(() => props.frames.length),
  autoScroll: computed(() => appStore.autoScroll),
});

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
      text = `[${ctxFrame.timestamp}] ${ctxFrame.direction} | ${formatFrame(ctxFrame)}`;
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
  gap: var(--space-sm);
  flex-wrap: wrap;
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
  padding: 1px 6px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
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
  position: relative;
}

.packet-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 12px;
  pointer-events: none;
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
  background-image: linear-gradient(90deg, rgba(76, 175, 80, 0.06), transparent 120px);
}

.packet-item.rx {
  border-left: 2px solid var(--accent-blue);
  padding-left: 8px;
  background-image: linear-gradient(90deg, rgba(33, 150, 243, 0.06), transparent 120px);
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
