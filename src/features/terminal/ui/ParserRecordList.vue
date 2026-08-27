<template>
  <div class="pp-list-root">
    <div
      ref="scrollRef"
      class="pp-list scrollbar-thin"
      role="list"
      tabindex="0"
      :aria-label="t('parser.recordList')"
      @scroll="onScroll"
      @keydown="onListKeydown"
    >
      <div v-if="records.length === 0" class="pp-empty">
        {{ emptyLabel }}
      </div>
      <div
        v-else
        class="pp-virtual-space"
        :style="{
          height: `${listTotalHeight}px`,
          width: `${listTotalWidth}px`,
        }"
      >
        <div
          v-for="row in renderedRows"
          :id="recordDomId(row.record)"
          :key="recordStableId(row.record)"
          :ref="measureElement"
          class="pp-frame"
          :class="[
            `direction-${recordDirection(row.record).toLowerCase()}`,
            `status-${recordStatus(row.record)}`,
            { selected: selectedRecordId === recordStableId(row.record), smp: isSmp(row.record) },
          ]"
          role="listitem"
          tabindex="-1"
          :aria-current="selectedRecordId === recordStableId(row.record) ? 'true' : undefined"
          :data-index="row.index"
          :style="{
            transform: `translateY(${row.start}px)`,
            width: `${listTotalWidth}px`,
            height: `${row.size}px`,
          }"
          :title="recordTitle(row.record)"
          @click="emit('select', row.record)"
          @dblclick="emit('focus-inspector')"
        >
          <div
            v-for="col in visibleListColumns"
            :key="col.key"
            class="pp-cell"
            :class="`pp-cell-${col.key}`"
            :style="{ transform: `translateX(${col.start}px)`, width: `${col.size}px` }"
          >
            <template v-if="col.key === 'idx'">#{{ row.index + 1 }}</template>
            <span v-else-if="col.key === 'direction'" class="direction-badge">
              {{ recordDirection(row.record) }}
            </span>
            <template v-else-if="col.key === 'time'">
              {{ recordTimestamp(row.record) }}
            </template>
            <span v-else-if="col.key === 'transaction'" class="transaction-badge">
              {{ transactionLabel(row.record) }}
            </span>
            <template v-else-if="col.key === 'route'">{{ smpRoute(row.record) }}</template>
            <template v-else-if="col.key === 'seq'"
              >#{{ row.record.header?.sequence ?? '—' }}</template
            >
            <span
              v-else-if="col.key === 'status'"
              class="status-badge"
              :title="recordDiagnosticSummary(row.record)"
            >
              {{ statusLabel(recordStatus(row.record)) }}
            </span>
            <template v-else-if="col.key === 'rtt'">
              <template v-if="row.record.rttMs !== undefined">
                {{ row.record.rttMs.toFixed(1) }}ms
              </template>
            </template>
            <span v-else-if="col.key === 'framing' && row.record.parserKind" class="framing-badge">
              {{ parserKindLabel(row.record.parserKind) }}
            </span>
            <template v-else-if="col.key === 'hex'">
              {{ frameHexPreview(row.record.data) }}
            </template>
            <template v-else-if="col.key === 'len'">{{ row.record.data.length }}B</template>
            <button
              v-else-if="col.key === 'copy'"
              class="pp-copy"
              type="button"
              :title="t('parser.copy')"
              :aria-label="t('parser.copy')"
              @click.stop="emit('copy-bytes', row.record.data)"
              @keydown.enter.stop
              @keydown.space.stop
            >
              <Copy class="icon-sm" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, toRef, watch } from 'vue';
import { Copy } from '@lucide/vue';
import { useParserRecordList } from '@/features/terminal/application/use-parser-record-list';
import { bindParserVirtualWheel } from '@/lib/parser-virtual-list';
import {
  PARSER_LIST_HEX_PREVIEW_BYTES,
  PARSER_LIST_ROW_HEIGHT,
  type ParserListKind,
} from '@/lib/parser-virtual-list';
import {
  protocolRecordDirection,
  protocolRecordStatus,
  protocolRecordTransaction,
  type SearchableProtocolRecord,
} from '@/lib/parser-panel';
import { formatHex } from '@/lib/format';
import { locale, t } from '@/lib/i18n';
import { smpDiagnosticMessageZh } from '@/lib/mcumgr-smp-metadata';
import type { ParserInspectorRecord } from './ParserFrameDetail.vue';

export type ParserRecordListRecord = SearchableProtocolRecord &
  ParserInspectorRecord & {
    rttMs?: number;
  };

const props = defineProps<{
  records: readonly ParserRecordListRecord[];
  smpMode: boolean;
  selectedRecordId: string | null;
  autoFollow: boolean;
  emptyLabel: string;
}>();

const emit = defineEmits<{
  select: [record: ParserRecordListRecord];
  'copy-bytes': [bytes: Uint8Array];
  'focus-inspector': [];
}>();

const recordCount = computed(() => props.records.length);
const listKind = computed<ParserListKind>(() => (props.smpMode ? 'smp' : 'legacy'));

const {
  scrollRef,
  virtualRows,
  visibleListColumns,
  listTotalHeight,
  listTotalWidth,
  measureElement,
  onScroll,
  scrollToIndex,
} = useParserRecordList({
  recordCount,
  listKind,
  autoScroll: toRef(props, 'autoFollow'),
  itemKey: (index) => {
    const record = props.records[index];
    return record ? recordStableId(record) : index;
  },
});

const renderedRows = computed(() =>
  virtualRows.value.flatMap((row) => {
    const record = props.records[row.index];
    return record ? [{ ...row, record }] : [];
  }),
);

function recordStableId(record: ParserRecordListRecord): string {
  return (
    record.id ??
    `legacy:${record.captureSeq ?? 'none'}:${record.direction ?? 'RX'}:${record.offset}:${record.data.length}`
  );
}

function recordDomId(record: ParserRecordListRecord): string {
  let hash = 2166136261;
  for (const character of recordStableId(record)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `parser-record-${hash >>> 0}`;
}

function isSmp(record: ParserRecordListRecord): boolean {
  return record.kind === 'smp';
}

function recordDirection(record: ParserRecordListRecord): 'TX' | 'RX' {
  return protocolRecordDirection(record);
}

function recordStatus(record: ParserRecordListRecord) {
  return protocolRecordStatus(record);
}

function recordTimestamp(record: ParserRecordListRecord): string {
  if (record.timestamp === undefined) return '';
  const date = new Date(record.timestamp);
  return Number.isNaN(date.getTime())
    ? String(record.timestamp)
    : date.toLocaleTimeString([], { hour12: false });
}

function transactionLabel(record: ParserRecordListRecord): string {
  const transaction = protocolRecordTransaction(record);
  if (transaction === 'request') return t('parser.transaction.requestShort');
  if (transaction === 'response') return t('parser.transaction.responseShort');
  if (transaction === 'unmatched') return t('parser.transaction.unmatchedShort');
  return 'SMP';
}

function smpRoute(record: ParserRecordListRecord): string {
  const header = record.header;
  const group =
    (locale.value === 'zh' ? header?.groupNameZh : header?.groupName) ??
    header?.groupName ??
    header?.group ??
    '?';
  const command =
    (locale.value === 'zh' ? header?.commandNameZh : header?.commandName) ??
    header?.commandName ??
    header?.command ??
    '?';
  return `${String(group)} / ${String(command)}`;
}

function statusLabel(status: ReturnType<typeof protocolRecordStatus>): string {
  return t(`parser.status.${status}`);
}

function parserKindLabel(kind: 'delimiter' | 'fixed' | 'length'): string {
  return t(`parser.kind.${kind}`);
}

function recordTitle(record: ParserRecordListRecord): string {
  const prefix = t('parser.offsetTitle', { offset: record.offset });
  if (record.kind === 'smp' && locale.value === 'zh') {
    return `${prefix} · ${transactionLabel(record)} · ${smpRoute(record)} · #${String(record.header?.sequence ?? '—')}`;
  }
  return record.summary ? `${prefix} · ${record.summary}` : prefix;
}

function recordDiagnosticSummary(record: ParserRecordListRecord): string {
  return record.diagnostics?.map((diagnostic) => diagnosticText(diagnostic)).join('\n') ?? '';
}

function diagnosticText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value);
  const diagnostic = value as Record<string, unknown>;
  const code = String(diagnostic.code ?? '');
  const message = String(diagnostic.message ?? diagnostic.messageZh ?? (code || value));
  return locale.value === 'zh'
    ? String(diagnostic.messageZh ?? smpDiagnosticMessageZh(code, message))
    : message;
}

function frameHexPreview(bytes: Uint8Array): string {
  const maxBytes = PARSER_LIST_HEX_PREVIEW_BYTES;
  const preview = formatHex(bytes.subarray(0, maxBytes));
  return bytes.length > maxBytes ? `${preview}\u2026` : preview;
}

function onListKeydown(event: KeyboardEvent) {
  if (props.records.length === 0) return;
  const currentIndex = props.records.findIndex(
    (record) => recordStableId(record) === props.selectedRecordId,
  );
  let nextIndex: number;
  if (event.key === 'ArrowDown') nextIndex = Math.min(props.records.length - 1, currentIndex + 1);
  else if (event.key === 'ArrowUp')
    nextIndex = Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1);
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = props.records.length - 1;
  else if (event.key === 'Enter') nextIndex = currentIndex < 0 ? 0 : currentIndex;
  else return;

  event.preventDefault();
  const record = props.records[nextIndex];
  if (!record) return;
  emit('select', record);
  scrollToIndex(nextIndex);
  void nextTick(() => document.getElementById(recordDomId(record))?.focus());
}

function focusList() {
  scrollRef.value?.focus();
}

defineExpose({ scrollToIndex, focusList, scrollRef });

let unbindWheel: (() => void) | null = null;

onMounted(() => {
  if (scrollRef.value) {
    unbindWheel = bindParserVirtualWheel(scrollRef.value, PARSER_LIST_ROW_HEIGHT);
  }
  if (!props.autoFollow || props.records.length === 0) return;
  void nextTick(() => scrollToIndex(props.records.length - 1));
});

onUnmounted(() => {
  unbindWheel?.();
  unbindWheel = null;
});

watch(
  () => props.records.length,
  (count, previous) => {
    if (!props.autoFollow || count === 0 || count <= previous) return;
    void nextTick(() => scrollToIndex(count - 1));
  },
);
</script>

<style scoped>
.pp-list-root {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.pp-list {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 6px 8px;
  outline: none;
}

.pp-list:focus-visible {
  box-shadow: inset 0 0 0 2px var(--color-primary-muted);
}

.pp-virtual-space {
  position: relative;
  min-width: 100%;
}

.pp-empty {
  padding: 32px 12px;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  text-align: center;
}

.pp-frame {
  position: absolute;
  top: 0;
  left: 0;
  min-width: 100%;
  min-height: 40px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast);
}

.pp-cell {
  position: absolute;
  top: 4px;
  left: 0;
  display: flex;
  align-items: center;
  height: calc(100% - 8px);
  overflow: hidden;
  white-space: nowrap;
}

.pp-frame:hover {
  background: var(--bg-hover);
}

.pp-frame.selected {
  border-color: var(--color-primary-muted);
  background: var(--bg-active);
}

.pp-frame.status-warning {
  box-shadow: inset 3px 0 0 var(--accent-orange);
}

.pp-frame.status-error {
  box-shadow: inset 3px 0 0 var(--color-error);
}

.pp-cell-idx,
.pp-cell-time,
.pp-cell-seq,
.pp-cell-rtt,
.pp-cell-len {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.direction-badge,
.framing-badge,
.transaction-badge,
.status-badge {
  min-width: 28px;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 700;
  text-align: center;
}

.direction-badge {
  color: var(--accent-blue);
  background: var(--accent-blue-subtle);
}

.direction-tx .direction-badge {
  color: var(--color-success);
  background: var(--color-primary-muted);
}

.transaction-badge {
  color: var(--text-muted);
  background: var(--bg-secondary);
}

.framing-badge {
  color: var(--text-muted);
  background: var(--bg-secondary);
}

.status-badge {
  color: var(--text-muted);
  background: var(--bg-secondary);
}

.status-warning .status-badge {
  color: var(--accent-orange);
  background: var(--accent-orange-subtle);
}

.status-error .status-badge {
  color: var(--color-error);
}

.pp-cell-hex {
  color: var(--accent-blue);
  letter-spacing: 0.2px;
}

.pp-copy {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}

.pp-copy:hover,
.pp-copy:focus-visible {
  color: var(--text-primary);
  background: var(--bg-hover);
  outline: none;
}

@container parser-panel (max-width: 820px) {
  .pp-list-root {
    min-height: min(140px, 40%);
  }
}
</style>
