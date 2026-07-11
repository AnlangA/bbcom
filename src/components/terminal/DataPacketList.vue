<template>
  <div class="packet-list">
    <div class="packet-toolbar">
      <div class="filter-left">
        <AppSelect
          v-model:value="directionFilter"
          :options="directionOptions"
          size="tiny"
          style="width: 86px"
        />
        <n-input
          v-model:value="searchInput"
          :placeholder="
            appStore.searchMode === 'HEX' ? t('packet.searchHex') : t('packet.searchText')
          "
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
            >{{ t('packet.text') }}</n-button
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
            >{{ t('packet.frame') }}</n-button
          >
          <n-button
            :type="appStore.packetViewMode === 'MERGED' ? 'primary' : 'default'"
            @click="appStore.setPacketViewMode('MERGED')"
            >{{ t('packet.merged') }}</n-button
          >
        </n-button-group>
      </div>
      <div class="filter-right">
        <n-dropdown
          :options="copyOptions"
          @select="handleCopySelect"
          :disabled="copyFrameCount === 0"
        >
          <n-button size="tiny" quaternary :disabled="copyFrameCount === 0">
            <template #icon>
              <Copy class="icon-sm" />
            </template>
            {{ t('packet.copy') }}
          </n-button>
        </n-dropdown>
        <span class="frame-count">{{ filteredFrameCount }} / {{ totalFrameCount }}</span>
      </div>
    </div>
    <div class="packet-row packet-header" :style="{ gridTemplateColumns: columns }">
      <span class="col-dir">{{ t('packet.direction') }}</span>
      <span v-if="appStore.showTimestamp" class="col-time">{{ t('packet.time') }}</span>
      <span class="col-data">{{ t('packet.data') }}</span>
      <span class="col-mode">{{ t('packet.mode') }}</span>
    </div>
    <div
      ref="scrollRef"
      class="packet-items"
      tabindex="0"
      @scroll.passive="onScroll"
      @keydown="onKeydown"
    >
      <div v-if="visibleFrameCount === 0" class="packet-empty">
        {{ totalFrameCount === 0 ? t('packet.empty') : t('packet.noMatch') }}
      </div>
      <div :style="{ height: `${totalSize}px`, width: '100%', position: 'relative' }">
        <PacketRow
          v-for="row in rows"
          :key="row.key"
          v-memo="[
            row.key,
            row.start,
            row.size,
            row.contentVersion,
            appStore.displayMode,
            appStore.ansiColorEnabled,
            appStore.showTimestamp,
            row.highlightClass,
          ]"
          :style="row.style"
          :frame="row.frame"
          :formatted="row.formatted"
          :timestamp="row.timestamp"
          :show-timestamp="row.showTimestamp"
          :columns="row.columns"
          :display-label="row.displayLabel"
          :use-html="row.useHtml"
          :highlight-class="row.highlightClass"
          :highlight-label="row.highlightLabel"
          @contextmenu="onRowContextMenu"
        />
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
import { NButtonGroup, NButton, NInput, NDropdown, useMessage } from 'naive-ui';
import AppSelect from '../ui/AppSelect.vue';
import { Copy, Search } from '@lucide/vue';
import { useAppStore } from '../../stores/app';
import { usePacketFilter } from '../../composables/usePacketFilter';
import { usePacketFormatter } from '../../composables/usePacketFormatter';
import { usePacketVirtualScroll } from '../../composables/usePacketVirtualScroll';
import PacketRow from './PacketRow.vue';
import { t } from '../../lib/i18n';
import {
  buildPacketRows,
  framesForPacketCopy,
  packetBatchCopyText,
  packetColumns,
  packetContextCopyText,
  packetCopySizeStatus,
  packetDisplayLabel,
  packetKeyboardCopyText,
  packetSelectionIndex,
  packetUsesHtml,
  scrollTopForVirtualIndex,
  type PacketBatchCopyKey,
  type PacketContextCopyKey,
  type PacketRowData,
} from '../../lib/packet-list';
import type { DataFrame, DirectionFilter, HighlightRule } from '../../types';

const props = defineProps<{
  frames: DataFrame[];
  framesVersion: number;
  highlights?: HighlightRule[];
}>();

const appStore = useAppStore();
const message = useMessage();
const framesRef = toRef(props, 'frames');
const framesVersion = toRef(props, 'framesVersion');
const totalFrameCount = computed(() => {
  void framesVersion.value;
  return props.frames.length;
});

const ctxShow = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
let ctxFrame: DataFrame | null = null;
const selectedFrameId = ref<string | null>(null);

const ctxOptions = computed(() => [
  { label: t('packet.copyHex'), key: 'hex' },
  { label: t('packet.copyAscii'), key: 'ascii' },
  { label: t('packet.copyUtf8'), key: 'utf8' },
  { label: t('packet.copyPlain'), key: 'plain' },
  { label: t('packet.copyRow'), key: 'row' },
]);

const copyOptions = computed(() => [
  { label: t('packet.copyFilteredHex'), key: 'filtered-hex' },
  { label: t('packet.copyFilteredText'), key: 'filtered-text' },
  { label: t('packet.copyAllHex'), key: 'all-hex' },
  { label: t('packet.copyAllText'), key: 'all-text' },
]);

const directionOptions = computed<{ label: string; value: DirectionFilter }[]>(() => [
  { label: t('packet.directionAll'), value: 'ALL' },
  { label: 'TX', value: 'TX' },
  { label: 'RX', value: 'RX' },
]);

const columns = computed(() => packetColumns(appStore.showTimestamp));

const { formatFrame, getHexSearchData, getTextSearchData, stripAnsi, clearCaches } =
  usePacketFormatter({
    displayMode: computed(() => appStore.displayMode),
    ansiColorEnabled: computed(() => appStore.ansiColorEnabled),
  });

watch(
  () => [framesVersion.value, props.frames.length] as const,
  ([, newLen], [, oldLen]) => {
    if (newLen < oldLen) {
      clearCaches();
    }
  },
);

const {
  directionFilter,
  searchInput,
  filteredFrames,
  filteredFrameCount,
  visibleFrames,
  visibleFrameCount,
  materializeFrame,
} = usePacketFilter({
  frames: framesRef,
  framesVersion,
  searchMode: computed(() => appStore.searchMode),
  packetViewMode: computed(() => appStore.packetViewMode),
  getHexSearchData,
  getTextSearchData,
  onFramesReplaced: clearCaches,
});

const { scrollRef, virtualItems, totalSize, onScroll } = usePacketVirtualScroll({
  frameCount: visibleFrameCount,
  autoScroll: computed(() => appStore.autoScroll),
});

const displayLabel = computed(() =>
  packetDisplayLabel(appStore.packetViewMode, appStore.displayMode),
);

// A MERGED query can span source chunks, so its visible logical rows—not the
// per-source-frame filter count—determine whether filtered copy is available.
const copyFrameCount = computed(() =>
  appStore.packetViewMode === 'MERGED' ? visibleFrameCount.value : filteredFrameCount.value,
);

const useHtml = computed(() => packetUsesHtml(appStore.displayMode, appStore.ansiColorEnabled));

// Pre-map the virtualized items into stable row descriptors. Formatting runs
// here (shared LRU cache), so each visible row carries an already-formatted
// string; combined with v-memo on <PacketRow>, unchanged rows skip the v-html
// diff entirely when only the buffer grows.
const rows = computed<PacketRowData[]>(() => {
  // The frames array is mutated in place, so row construction must depend on
  // the explicit frame pulse even when the array reference and length are stable
  // after buffer trimming.
  void framesVersion.value;
  void visibleFrameCount.value;

  return buildPacketRows({
    virtualItems: virtualItems.value,
    frames: visibleFrames.value,
    showTimestamp: appStore.showTimestamp,
    columns: columns.value,
    displayLabel: displayLabel.value,
    useHtml: useHtml.value,
    highlights: props.highlights,
    formatFrame,
    getHexSearchData,
    getTextSearchData,
  });
});

function showContextMenu(e: MouseEvent, frame: DataFrame) {
  ctxFrame = frame;
  ctxX.value = e.clientX;
  ctxY.value = e.clientY;
  ctxShow.value = true;
  selectFrame(frame);
}

function selectFrame(frame: DataFrame) {
  selectedFrameId.value = frame.id;
}

function onKeydown(e: KeyboardEvent) {
  if (!scrollRef.value) return;
  const frames = visibleFrames.value;
  if (frames.length === 0) return;

  const nextIndex = packetSelectionIndex(frames, selectedFrameId.value, e.key);
  if (nextIndex !== null) {
    e.preventDefault();
    selectFrame(frames[nextIndex]);
    scrollToIndex(nextIndex);
  } else if (e.key === 'c' && (e.ctrlKey || e.metaKey) && selectedFrameId.value) {
    e.preventDefault();
    const frame = frames.find((f) => f.id === selectedFrameId.value);
    if (frame) {
      const materialized = materializeFrame(frame);
      const text = packetKeyboardCopyText(materialized, formatFrame);
      navigator.clipboard.writeText(text).then(
        () => message.success(t('packet.copied')),
        () => message.error(t('packet.copyFailed')),
      );
    }
  }
}

function scrollToIndex(index: number) {
  if (!scrollRef.value) return;
  const nextScrollTop = scrollTopForVirtualIndex(
    index,
    virtualItems.value,
    scrollRef.value.scrollTop,
    scrollRef.value.clientHeight,
  );
  if (nextScrollTop !== null) {
    scrollRef.value.scrollTop = nextScrollTop;
  }
}

function onRowContextMenu(e: MouseEvent, frame: DataFrame) {
  showContextMenu(e, frame);
}

async function handleCtxSelect(key: string) {
  ctxShow.value = false;
  if (!ctxFrame) return;
  const text = packetContextCopyText(key as PacketContextCopyKey, materializeFrame(ctxFrame), {
    formatFrame,
    stripAnsi,
  });

  try {
    await navigator.clipboard.writeText(text);
    message.success(t('packet.copied'));
  } catch {
    message.error(t('packet.copyFailed'));
  }
}

async function handleCopySelect(key: string) {
  const copyKey = key as PacketBatchCopyKey;
  const mergedFilteredCopy = appStore.packetViewMode === 'MERGED' && !copyKey.startsWith('all');
  const frames = mergedFilteredCopy
    ? visibleFrames.value
    : framesForPacketCopy(copyKey, props.frames, filteredFrames.value);
  const { tooLarge } = packetCopySizeStatus(frames);
  if (tooLarge) {
    message.warning(t('packet.copyTooLarge'));
    return;
  }
  // A visible rope exposes only its 64 KiB display tail. Materialize it after
  // the size guard and only for the user-initiated filtered-copy action.
  const copyFrames = mergedFilteredCopy ? frames.map(materializeFrame) : frames;
  const text = packetBatchCopyText(copyKey, copyFrames);
  try {
    await navigator.clipboard.writeText(text);
    message.success(t('packet.copied'));
  } catch {
    message.error(t('packet.copyFailed'));
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
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.packet-items {
  overflow-y: auto;
  flex: 1;
  background: linear-gradient(180deg, var(--surface-lift), transparent 120px), var(--bg-primary);
  position: relative;
  outline: none;
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
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px),
    linear-gradient(180deg, var(--grid-line) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: radial-gradient(circle at center, black 0, transparent 72%);
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

.col-mode {
  text-align: center;
  color: var(--text-dim);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0;
}
</style>
