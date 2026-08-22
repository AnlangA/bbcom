<template>
  <div class="packet-list">
    <div class="packet-toolbar">
      <div class="filter-left">
        <AppSelect
          v-model:value="directionFilter"
          :options="directionOptions"
          :aria-label="t('packet.direction')"
          size="tiny"
          style="width: 86px"
        />
        <n-input
          v-model:value="searchInput"
          :placeholder="
            appStore.searchMode === 'HEX' ? t('packet.searchHex') : t('packet.searchText')
          "
          :aria-label="
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
            :aria-pressed="appStore.searchMode === 'TEXT'"
            @click="appStore.setSearchMode('TEXT')"
            >{{ t('packet.text') }}</n-button
          >
          <n-button
            :type="appStore.searchMode === 'HEX' ? 'primary' : 'default'"
            :aria-pressed="appStore.searchMode === 'HEX'"
            @click="appStore.setSearchMode('HEX')"
            >HEX</n-button
          >
        </n-button-group>
        <n-button-group size="tiny">
          <n-button
            :type="appStore.packetViewMode === 'FRAME' ? 'primary' : 'default'"
            :aria-pressed="appStore.packetViewMode === 'FRAME'"
            @click="appStore.setPacketViewMode('FRAME')"
            >{{ t('packet.frame') }}</n-button
          >
          <n-button
            :type="appStore.packetViewMode === 'MERGED' ? 'primary' : 'default'"
            :aria-pressed="appStore.packetViewMode === 'MERGED'"
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
      role="region"
      :aria-label="t('packet.data')"
      @scroll.passive="onScroll"
      @keydown="onKeydown"
    >
      <div v-if="visibleFrameCount === 0" class="packet-empty">
        <div class="packet-empty-card">
          <component :is="emptyIcon" class="icon-lg packet-empty-icon" aria-hidden="true" />
          <span class="packet-empty-title">
            {{ totalFrameCount === 0 ? t('packet.empty') : t('packet.noMatch') }}
          </span>
          <span class="packet-empty-hint">
            {{ totalFrameCount === 0 ? t('packet.emptyHint') : t('packet.noMatchHint') }}
          </span>
        </div>
      </div>
      <div :style="{ height: `${totalSize}px`, width: '100%', position: 'relative' }">
        <div
          v-for="row in rows"
          :key="row.key"
          :ref="measureElement"
          :data-index="row.index"
          :style="row.style"
          v-memo="[
            row.key,
            row.style.transform,
            row.contentVersion,
            appStore.displayMode,
            appStore.ansiColorEnabled,
            appStore.preserveLogLineBreaks,
            appStore.softWrapEnabled,
            appStore.showTimestamp,
            row.highlightClass,
            row.striped,
            row.frame.id === selectedFrameId,
          ]"
        >
          <PacketRow
            :frame="row.frame"
            :formatted="row.formatted"
            :timestamp="row.timestamp"
            :show-timestamp="appStore.showTimestamp"
            :columns="columns"
            :display-label="displayLabel"
            :use-html="useHtml"
            :preserve-line-breaks="preserveLineBreaks"
            :plain-line-breaks="plainLineBreaks"
            :soft-wrap="softWrapEnabled"
            :hex-mode="hexWrapMode"
            :highlight-class="row.highlightClass"
            :highlight-label="row.highlightLabel"
            :striped="row.striped"
            :selected="row.frame.id === selectedFrameId"
            @contextmenu="onRowContextMenu"
          />
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
import { computed, inject, onMounted, onUnmounted, ref, toRef, watch } from 'vue';
import { NButtonGroup, NButton, NInput, NDropdown, useMessage } from 'naive-ui';
import AppSelect from '@/design-system/AppSelect.vue';
import { Cable, Copy, Search } from '@lucide/vue';
import { useAppStore } from '@/features/settings/store/app-store';
import { usePacketFilter } from '@/features/terminal/application/use-packet-filter';
import { SESSION_UI_STATE_KEY } from '@/features/sessions/runtime/session-ui-state';
import { usePacketFormatter } from '@/features/terminal/application/use-packet-formatter';
import { usePacketVirtualScroll } from '@/features/terminal/application/use-packet-virtual-scroll';
import PacketRow from './PacketRow.vue';
import { t } from '@/lib/i18n';
import {
  buildPacketRows,
  framesForPacketCopy,
  packetBatchCopyText,
  packetColumns,
  packetContextCopyText,
  packetCopySizeStatus,
  packetDisplayLabel,
  packetRowHeight,
  packetKeyboardCopyText,
  packetSelectionIndex,
  packetUsesHtml,
  scrollTopForVirtualIndex,
  type PacketBatchCopyKey,
  type PacketContextCopyKey,
  type PacketRowData,
} from '@/lib/packet-list';
import type { DataFrame, DirectionFilter, HighlightRule } from '@/types';

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

// Both icons are already bundled elsewhere (Cable: PortSelector), so the empty
// state adds no new icon to the bundle.
const emptyIcon = computed(() => (totalFrameCount.value === 0 ? Cable : Search));

const ctxShow = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
let ctxFrame: DataFrame | null = null;
const selectedFrameId = ref<string | null>(null);
const frameReplacementVersion = ref(0);

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

// Retention: when mounted under a session runtime (SessionView provides the
// key), the search box and direction filter live on the runtime so switching
// session tabs and back does not lose them.
const retainedUiState = inject(SESSION_UI_STATE_KEY, null);

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
  onFramesReplaced: () => {
    clearCaches();
    frameReplacementVersion.value += 1;
  },
  directionFilter: retainedUiState?.packetDirection,
  searchInput: retainedUiState?.packetSearch,
});

// HEXASCII is a fixed-width hex dump: always multi-line, independent of the
// log line-break toggle. HEX stays a single line; text modes follow the toggle.
const preserveLineBreaks = computed(() => {
  if (appStore.displayMode === 'HEX') return false;
  if (appStore.displayMode === 'HEXASCII') return true;
  return appStore.preserveLogLineBreaks;
});

// The dump's ASCII gutter may contain text like "I: " that the log-record
// prefix heuristic would re-flow, so HEXASCII rows split on raw '\n' only.
const plainLineBreaks = computed(() => appStore.displayMode === 'HEXASCII');

const softWrapEnabled = computed(() => appStore.softWrapEnabled);

const hexWrapMode = computed(
  () =>
    softWrapEnabled.value &&
    (appStore.displayMode === 'HEX' || appStore.displayMode === 'HEXASCII'),
);

const layoutVersion = ref(0);
let resizeObserver: ResizeObserver | null = null;
let resizeRafId: number | null = null;

function formatFrameForDisplay(frame: DataFrame): string {
  return formatFrame(frame, {
    preserveLineBreaks: preserveLineBreaks.value,
    plainLineBreaks: plainLineBreaks.value,
  });
}

const rowSizeVersion = computed(() =>
  [
    appStore.displayMode,
    appStore.preserveLogLineBreaks,
    appStore.softWrapEnabled,
    appStore.showTimestamp,
    layoutVersion.value,
    frameReplacementVersion.value,
    appStore.packetViewMode === 'MERGED' ? framesVersion.value : 0,
  ].join(':'),
);

const {
  scrollRef,
  virtualItems,
  totalSize,
  measureElement,
  onScroll,
  scrollToIndex: scrollToVirtualIndex,
} = usePacketVirtualScroll({
  frameCount: visibleFrameCount,
  autoScroll: computed(() => appStore.autoScroll),
  rowSize: (index) =>
    packetRowHeight(visibleFrames.value[index], appStore.displayMode, preserveLineBreaks.value),
  itemKey: (index) => visibleFrames.value[index]?.id ?? index,
  rowSizeVersion,
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
  void preserveLineBreaks.value;
  void plainLineBreaks.value;
  void appStore.ansiColorEnabled;

  return buildPacketRows({
    virtualItems: virtualItems.value,
    frames: visibleFrames.value,
    highlights: props.highlights,
    formatFrame: formatFrameForDisplay,
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
    return;
  }
  // The row is outside the rendered window (e.g. the first keyboard selection
  // while parked at the tail): let the virtualizer compute the offset from
  // its measurement cache and estimates so the selection becomes visible.
  scrollToVirtualIndex(index);
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

onMounted(() => {
  const el = scrollRef.value;
  if (!el) return;
  resizeObserver = new ResizeObserver(() => {
    if (resizeRafId !== null) return;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      layoutVersion.value += 1;
    });
  });
  resizeObserver.observe(el);
});

onUnmounted(() => {
  if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
  resizeObserver?.disconnect();
  resizeObserver = null;
});
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
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.filter-left {
  display: flex;
  gap: var(--space-sm);
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
}

.filter-right {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  font-family: var(--font-mono);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.search-icon {
  color: var(--text-dim);
}

.frame-count {
  color: var(--text-secondary);
  padding: var(--space-2xs) var(--space-sm);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
}

/* .packet-row grid and .col-* column rules live in styles/packet-columns.css,
   shared with PacketRow.vue so header and rows cannot drift apart. */
.packet-header {
  font-weight: 600;
  border-bottom: 1px solid var(--border-subtle);
  border-left: 2px solid transparent;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--bg-secondary);
  padding-left: var(--space-sm);
  box-shadow: var(--shadow-sm);
}

.packet-items {
  overflow-y: auto;
  flex: 1;
  background: linear-gradient(180deg, var(--surface-lift), transparent 120px), var(--bg-primary);
  position: relative;
  outline: none;
}

/* The list is keyboard-focusable (arrow-key selection); keep a visible focus
   cue since the default outline is removed. */
.packet-items:focus-visible {
  box-shadow: inset 0 0 0 1px var(--border-focus);
}

.packet-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

/* Grid backdrop lives in a pseudo-element so the mask fades only the grid,
   never the empty-state content. */
.packet-empty::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px),
    linear-gradient(180deg, var(--grid-line) 1px, transparent 1px);
  background-size: 32px 32px;
  mask-image: radial-gradient(circle at center, black 0, transparent 72%);
}

.packet-empty-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-lg) var(--space-xl);
  max-width: 320px;
  text-align: center;
}

.packet-empty-icon {
  color: var(--text-dim);
  opacity: 0.85;
  margin-bottom: var(--space-2xs);
}

.packet-empty-title {
  color: var(--text-muted);
  font-size: var(--font-size-data);
  font-weight: var(--font-weight-medium);
  letter-spacing: 0.2px;
}

.packet-empty-hint {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}
</style>
