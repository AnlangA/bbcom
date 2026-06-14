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
        >
          <template #prefix>
            <Search class="icon-sm search-icon" />
          </template>
        </n-input>
        <n-button-group size="tiny">
          <n-button
            :type="appStore.searchMode === 'TEXT' ? 'primary' : 'default'"
            @click="appStore.setSearchMode('TEXT')"
            >文本</n-button
          >
          <n-button
            :type="appStore.searchMode === 'HEX' ? 'primary' : 'default'"
            @click="appStore.setSearchMode('HEX')"
            >HEX</n-button
          >
        </n-button-group>
        <n-button-group size="tiny">
          <n-button
            :type="appStore.packetViewMode === 'FRAME' ? 'primary' : 'default'"
            @click="appStore.setPacketViewMode('FRAME')"
            >按帧</n-button
          >
          <n-button
            :type="appStore.packetViewMode === 'MERGED' ? 'primary' : 'default'"
            @click="appStore.setPacketViewMode('MERGED')"
            >合并</n-button
          >
        </n-button-group>
      </div>
      <div class="filter-right">
        <n-dropdown
          :options="copyOptions"
          @select="handleCopySelect"
          :disabled="filteredFrames.length === 0"
        >
          <n-button size="tiny" quaternary :disabled="filteredFrames.length === 0">
            <template #icon>
              <Copy class="icon-sm" />
            </template>
            复制
          </n-button>
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
          :class="{
            tx: visibleFrames[row.index].direction === 'TX',
            rx: visibleFrames[row.index].direction === 'RX',
          }"
          @contextmenu.prevent="(e: MouseEvent) => showContextMenu(e, visibleFrames[row.index])"
        >
          <span class="col-dir direction">{{ visibleFrames[row.index].direction }}</span>
          <span v-if="appStore.showTimestamp" class="col-time timestamp">{{
            formatTimestamp(visibleFrames[row.index].timestamp)
          }}</span>
          <span
            v-if="appStore.displayMode !== 'HEX' && appStore.ansiColorEnabled"
            class="col-data data ansi-data"
            v-html="formatFrame(visibleFrames[row.index])"
          ></span>
          <span v-else class="col-data data">{{ formatFrame(visibleFrames[row.index]) }}</span>
          <span class="col-mode mode">{{ displayLabel }}</span>
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
import { Copy, Search } from 'lucide-vue-next';
import { useAppStore } from '../../stores/app';
import {
  formatHex,
  formatLogLine,
  formatUtf8,
  formatAscii,
  formatTimestamp,
  stripAnsiEscapes,
} from '../../lib/format';
import { logger } from '../../lib/logger';
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
const MAX_COPY_BYTES = 2 * 1024 * 1024;
const MAX_COPY_FRAMES = 5000;

const gridStyle = computed(() => ({
  gridTemplateColumns: appStore.showTimestamp ? '50px 160px 1fr 50px' : '50px 1fr 50px',
}));

const { formatFrame, getHexSearchData, getTextSearchData, clearCaches } = usePacketFormatter({
  displayMode: computed(() => appStore.displayMode),
  ansiColorEnabled: computed(() => appStore.ansiColorEnabled),
});

watch(
  () => props.frames.length,
  (newLen, oldLen) => {
    if (newLen < oldLen) {
      clearCaches();
    }
  },
);

const { directionFilter, searchInput, filteredFrames, visibleFrames } = usePacketFilter({
  frames: framesRef,
  searchMode: computed(() => appStore.searchMode),
  packetViewMode: computed(() => appStore.packetViewMode),
  getHexSearchData,
  getTextSearchData,
});

const { scrollRef, virtualItems, totalSize, onScroll } = usePacketVirtualScroll({
  visibleFrames,
  frameCount: computed(() => props.frames.length),
  autoScroll: computed(() => appStore.autoScroll),
});

const displayLabel = computed(() =>
  appStore.packetViewMode === 'MERGED' ? `${appStore.displayMode}*` : appStore.displayMode,
);

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
      text = stripAnsiEscapes(formatAscii(ctxFrame.data));
      break;
    case 'row': {
      // Plain text only — formatFrame would emit HTML (ansi_to_html spans) in
      // colored modes, which is useless when pasted.
      const plain =
        appStore.displayMode === 'HEX'
          ? formatHex(ctxFrame.data)
          : stripAnsiEscapes(formatUtf8(ctxFrame.data));
      text = formatLogLine(ctxFrame.timestamp, ctxFrame.direction, plain);
      break;
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch (e) {
    logger.warn('context copy failed:', e);
    message.error('复制失败');
  }
}

async function handleCopySelect(key: string) {
  const frames = key.startsWith('all') ? props.frames : filteredFrames.value;
  const totalBytes = frames.reduce((sum, frame) => sum + frame.data.length, 0);
  if (frames.length > MAX_COPY_FRAMES || totalBytes > MAX_COPY_BYTES) {
    message.warning('复制内容过大，请先筛选或使用导出');
    return;
  }
  const asHex = key.endsWith('hex');
  const text = frames
    .map((frame) => {
      const data = asHex ? formatHex(frame.data) : formatUtf8(frame.data);
      return formatLogLine(frame.timestamp, frame.direction, data);
    })
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  } catch (e) {
    logger.warn('bulk copy failed:', e);
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
  background: var(--bg-primary);
}

.packet-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 42px;
  padding: 7px 12px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.filter-left {
  display: flex;
  gap: 7px;
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

.search-icon {
  color: var(--text-dim);
}

.frame-count {
  color: var(--text-secondary);
  padding: 2px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
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
  background: var(--bg-secondary);
  position: sticky;
  top: 0;
  z-index: 1;
  padding-left: 8px;
}

.packet-items {
  overflow-y: auto;
  flex: 1;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.012), transparent 120px), var(--bg-primary);
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
  background:
    linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px),
    linear-gradient(180deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: radial-gradient(circle at center, black 0, transparent 72%);
}

.packet-item {
  border-bottom: 1px solid var(--border-subtle);
  transition: background var(--transition-fast);
  cursor: pointer;
  /* Virtualized rows have a fixed height; clip multi-line ANSI/UTF-8 content
     so it cannot overlap the next absolutely-positioned row. */
  overflow: hidden;
}

.packet-item:hover {
  background-color: var(--bg-hover);
}

.packet-item.tx .direction {
  color: var(--text-inverse);
  background: var(--accent-green);
}

.packet-item.rx .direction {
  color: #06111f;
  background: var(--accent-blue);
}

.packet-item.tx {
  border-left: 2px solid var(--accent-green);
  padding-left: 8px;
  background-image: linear-gradient(90deg, var(--accent-green-subtle), transparent 140px);
}

.packet-item.rx {
  border-left: 2px solid var(--accent-blue);
  padding-left: 8px;
  background-image: linear-gradient(90deg, var(--accent-blue-subtle), transparent 140px);
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

.direction {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 18px;
  border-radius: var(--radius-full);
  font-weight: var(--font-weight-bold);
  line-height: 18px;
}

.col-data {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.3px;
  /* Single-line cells fill the 22px track (no visual change); for wrapped
     ANSI/UTF-8 content, top-align so the clipped row shows the first line. */
  align-self: start;
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
  letter-spacing: 0;
}
</style>
