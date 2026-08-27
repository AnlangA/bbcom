<template>
  <div class="parser-panel" @keydown.esc="onPanelEscape">
    <ParserConfigBar
      :editing="configEditing"
      :config-summary="configSummary"
      :recovery-warning="parserRecoveryWarning"
      :validation-error="configValidationError"
      :preset-id="draftPresetId"
      :preset-options="presetOptions"
      :preset-description="draftPresetDescription"
      :kind-options="kindOptions"
      :len-size-options="lenSizeOptions"
      :transport-options="transportOptions"
      :kind="draftConfig.kind"
      :delimiter-hex="delimiterHexDraft"
      :include-delimiter="draftIncludeDelimiter"
      :fixed-size="draftFixedSize"
      :len-offset="draftLengthOffset"
      :len-size="draftLengthSize"
      :len-big-endian="draftLengthBigEndian"
      :len-adjust="draftLengthAdjust"
      :smp-transport="draftSmpTransport"
      :smp-max-packet-bytes="draftSmpMaxPacketBytes"
      :smp-reassembly-timeout-ms="draftSmpReassemblyTimeoutMs"
      :reparse-existing="reparseExisting"
      @close="emit('close')"
      @edit="beginConfigEdit"
      @apply="applyDraftConfig"
      @cancel="cancelConfigEdit"
      @apply-preset="applyPresetToDraft"
      @update:kind="updateDraftKind"
      @update:delimiter-hex="updateDraftDelimiterHex"
      @update:include-delimiter="draftIncludeDelimiter = $event"
      @update:fixed-size="draftFixedSize = $event"
      @update:len-offset="draftLengthOffset = $event"
      @update:len-size="updateDraftLengthSize"
      @update:len-big-endian="draftLengthBigEndian = $event"
      @update:len-adjust="draftLengthAdjust = $event"
      @update:smp-transport="updateDraftSmpTransport"
      @update:smp-max-packet-bytes="draftSmpMaxPacketBytes = $event"
      @update:smp-reassembly-timeout-ms="draftSmpReassemblyTimeoutMs = $event"
      @update:reparse-existing="reparseExisting = $event"
    />

    <ParserStatsBar
      :smp-mode="smpMode"
      :frame-count="parsedFrames.length"
      :visible-count="filteredRecords.length"
      :total-bytes="totalBytes"
      :dropped-frames="droppedFrames"
      :dropped-bytes="droppedBytes"
      :throughput-bps="throughputBps"
      :largest-frame="largestFrame"
      v-model:search-term="searchTerm"
      v-model:direction-filter="directionFilter"
      v-model:status-filter="statusFilter"
      v-model:transaction-filter="transactionFilter"
      v-model:group-filter="groupFilter"
      v-model:command-filter="commandFilter"
      v-model:sequence-filter="sequenceFilter"
      v-model:auto-follow="autoFollow"
    />

    <div ref="parserBodyRef" class="parser-body">
      <div
        ref="scrollRef"
        class="pp-list scrollbar-thin"
        role="list"
        tabindex="0"
        :aria-label="t('parser.recordList')"
        @scroll="onScroll"
        @keydown="onListKeydown"
      >
        <div v-if="filteredRecords.length === 0" class="pp-empty">
          {{ parsedFrames.length === 0 ? t('parser.empty') : t('packet.noMatch') }}
        </div>
        <div v-else class="pp-virtual-space" :style="{ height: `${totalSize}px` }">
          <div
            v-for="row in virtualRows"
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
            :style="{ transform: `translateY(${row.start}px)` }"
            :title="recordTitle(row.record)"
            @click="selectRecord(row.record)"
            @dblclick="focusInspector"
          >
            <span class="pp-idx">#{{ row.index + 1 }}</span>
            <span class="direction-badge">{{ recordDirection(row.record) }}</span>
            <span v-if="recordTimestamp(row.record)" class="record-time">
              {{ recordTimestamp(row.record) }}
            </span>

            <template v-if="isSmp(row.record)">
              <span class="transaction-badge">{{ transactionLabel(row.record) }}</span>
              <span class="smp-route">{{ smpRoute(row.record) }}</span>
              <span class="smp-seq">#{{ row.record.header?.sequence ?? '—' }}</span>
              <span class="status-badge" :title="recordDiagnosticSummary(row.record)">
                {{ statusLabel(recordStatus(row.record)) }}
              </span>
              <span v-if="row.record.rttMs !== undefined" class="smp-rtt">
                {{ row.record.rttMs.toFixed(1) }}ms
              </span>
            </template>
            <template v-else>
              <span v-if="row.record.parserKind" class="framing-badge">
                {{ parserKindLabel(row.record.parserKind) }}
              </span>
              <span class="pp-hex">
                {{ frameHexPreview(row.record.data) }}
              </span>
            </template>

            <span class="pp-len">{{ row.record.data.length }}B</span>
            <button
              class="pp-copy"
              type="button"
              :title="t('parser.copy')"
              :aria-label="t('parser.copy')"
              @click.stop="copyBytes(row.record.data)"
              @keydown.enter.stop
              @keydown.space.stop
            >
              <Copy class="icon-sm" />
            </button>
          </div>
        </div>
      </div>

      <div
        class="inspector-resize-handle"
        :class="{ compact: inspectorCompact, dragging: inspectorResizing }"
        role="separator"
        :aria-label="t('parser.inspector.resize')"
        :aria-orientation="inspectorOrientation"
        :aria-controls="inspectorPaneId"
        :aria-valuemin="inspectorMinSize"
        :aria-valuemax="inspectorMaxSize"
        :aria-valuenow="inspectorSize"
        :aria-valuetext="`${inspectorSize}px`"
        :title="t('parser.inspector.resizeHint')"
        tabindex="0"
        @pointerdown="startInspectorResize"
        @pointerup="stopInspectorResize"
        @keydown="onInspectorResizeKeydown"
        @dblclick="resetInspectorSize"
      >
        <span class="inspector-resize-grip" aria-hidden="true"></span>
      </div>

      <ParserFrameDetail
        :pane-id="inspectorPaneId"
        :compact="inspectorCompact"
        :inline-size="inspectorInlineSize"
        :block-size="inspectorBlockSize"
        :frame="selectedRecord"
        @copy="selectedRecord && copyBytes(selectedRecord.data)"
        @copy-ascii="selectedRecord && copyAscii(selectedRecord)"
        @copy-bytes="copyBytes"
        @copy-text="copyText"
        @close="closeInspector"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { Copy } from '@lucide/vue';
import {
  MAX_SMP_PARSER_MAX_PACKET_BYTES,
  MAX_SMP_REASSEMBLY_TIMEOUT_MS,
  MIN_SMP_PARSER_MAX_PACKET_BYTES,
  MIN_SMP_REASSEMBLY_TIMEOUT_MS,
  type ParserConfig,
  type ParserKind,
  type SmpParserTransport,
} from '@/lib/protocol-parser';
import { PARSER_PRESETS } from '@/lib/parser-presets';
import {
  configForKind,
  DEFAULT_DELIMITER_CONFIG,
  delimiterConfig,
  filterProtocolRecords,
  fixedConfig,
  formatDelimiterHex,
  frameAsciiText,
  lengthConfig,
  parseStrictDelimiterHex,
  parsedFrameStats,
  protocolRecordDirection,
  protocolRecordStatus,
  protocolRecordTransaction,
  smpConfig,
  type ProtocolRecordDirectionFilter,
  type ProtocolRecordStatusFilter,
  type ProtocolRecordTransactionFilter,
  type SearchableProtocolRecord,
} from '@/lib/parser-panel';
import { formatHex } from '@/lib/format';
import { locale, t } from '@/lib/i18n';
import { smpDiagnosticMessageZh } from '@/lib/mcumgr-smp-metadata';
import { parserStateRecoveredInvalidSmp } from '@/lib/session-persistence';
import { usePacketVirtualScroll } from '@/features/terminal/application/use-packet-virtual-scroll';
import { useParserInspectorResize } from '@/features/terminal/application/use-parser-inspector-resize';
import { useSessionDocument } from '@/features/sessions';
import ParserConfigBar from './ParserConfigBar.vue';
import ParserStatsBar from './ParserStatsBar.vue';
import ParserFrameDetail, { type ParserInspectorRecord } from './ParserFrameDetail.vue';

type ParserPanelRecord = SearchableProtocolRecord &
  ParserInspectorRecord & {
    rttMs?: number;
  };

const props = defineProps<{
  sessionId: string;
  /** Snapshot produced by the resident parser runtime (legacy byte frames or SMP records). */
  parsedFrames: readonly ParserPanelRecord[];
  droppedFrames: number;
  droppedBytes: number;
  throughputBps: number;
  parserResetVersion: number;
  /** Runtime-only replay preference; intentionally not persisted in parserState. */
  onApplyReplayPreference?: (enabled: boolean) => void;
}>();

const emit = defineEmits<{ (event: 'close'): void }>();

const documentStore = useSessionDocument(props.sessionId);
const message = useMessage();
const parserBodyRef = ref<HTMLElement | null>(null);
const {
  paneId: inspectorPaneId,
  compact: inspectorCompact,
  resizing: inspectorResizing,
  orientation: inspectorOrientation,
  size: inspectorSize,
  inlineSize: inspectorInlineSize,
  blockSize: inspectorBlockSize,
  minSize: inspectorMinSize,
  maxSize: inspectorMaxSize,
  startResize: startInspectorResize,
  stopResize: stopInspectorResize,
  onResizeKeydown: onInspectorResizeKeydown,
  resetInspectorSize,
} = useParserInspectorResize(parserBodyRef);

const kindOptions = computed(() => [
  { label: t('parser.kind.delimiter'), value: 'delimiter' },
  { label: t('parser.kind.fixed'), value: 'fixed' },
  { label: t('parser.kind.length'), value: 'length' },
  { label: t('parser.kind.mcumgrSmp'), value: 'mcumgr-smp' },
]);
const lenSizeOptions = [
  { label: '1B', value: 1 },
  { label: '2B', value: 2 },
  { label: '4B', value: 4 },
];
const transportOptions = computed(() => [
  { label: t('parser.smp.transport.serialConsole'), value: 'serial-console' },
  { label: t('parser.smp.transport.rawUart'), value: 'raw-uart' },
]);
const presetOptions = computed(() =>
  PARSER_PRESETS.map((preset) => ({
    label: locale.value === 'zh' ? (preset.nameZh ?? preset.name) : preset.name,
    value: preset.id,
  })),
);

const session = computed(() => documentStore.session.value ?? undefined);
const parserState = computed(
  () =>
    session.value?.parserState ?? {
      config: DEFAULT_DELIMITER_CONFIG,
      presetId: 'at-crlf',
    },
);
const currentConfig = computed<ParserConfig>(() => parserState.value.config);
const parserRecoveryWarning = computed(() =>
  parserStateRecoveredInvalidSmp(parserState.value) ? t('parser.validation.smpRecovered') : '',
);

const configEditing = ref(false);
const draftConfig = ref<ParserConfig>(cloneConfig(currentConfig.value));
const draftPresetId = ref<string | null>(parserState.value.presetId);
const draftPresetDescription = computed(() => {
  const preset = PARSER_PRESETS.find((candidate) => candidate.id === draftPresetId.value);
  if (!preset) return '';
  return locale.value === 'zh' ? (preset.descriptionZh ?? preset.description) : preset.description;
});
const delimiterHexDraft = ref(initialDelimiterHex(draftConfig.value));
const reparseExisting = ref(true);
const appliedReparseExisting = ref(true);

const draftIncludeDelimiter = computed({
  get: () => delimiterConfig(draftConfig.value).includeDelimiter,
  set: (includeDelimiter: boolean) => {
    draftConfig.value = { ...delimiterConfig(draftConfig.value), includeDelimiter };
    draftPresetId.value = null;
  },
});
const draftFixedSize = computed<number | null>({
  get: () => fixedConfig(draftConfig.value).frameSize,
  set: (frameSize) => {
    draftConfig.value = { kind: 'fixed', frameSize: frameSize ?? 0 };
    draftPresetId.value = null;
  },
});
const draftLengthOffset = computed<number | null>({
  get: () => lengthConfig(draftConfig.value).lengthOffset,
  set: (lengthOffset) => {
    draftConfig.value = { ...lengthConfig(draftConfig.value), lengthOffset: lengthOffset ?? -1 };
    draftPresetId.value = null;
  },
});
const draftLengthSize = computed({
  get: () => lengthConfig(draftConfig.value).lengthSize,
  set: (lengthSize: number) => {
    if (lengthSize !== 1 && lengthSize !== 2 && lengthSize !== 4) return;
    draftConfig.value = { ...lengthConfig(draftConfig.value), lengthSize };
    draftPresetId.value = null;
  },
});
const draftLengthBigEndian = computed({
  get: () => lengthConfig(draftConfig.value).bigEndian,
  set: (bigEndian: boolean) => {
    draftConfig.value = { ...lengthConfig(draftConfig.value), bigEndian };
    draftPresetId.value = null;
  },
});
const draftLengthAdjust = computed<number | null>({
  get: () => lengthConfig(draftConfig.value).lengthAdjust,
  set: (lengthAdjust) => {
    draftConfig.value = { ...lengthConfig(draftConfig.value), lengthAdjust: lengthAdjust ?? -1 };
    draftPresetId.value = null;
  },
});
const draftSmpTransport = computed(() => smpConfig(draftConfig.value).transport);
const draftSmpMaxPacketBytes = computed<number | null>({
  get: () => smpConfig(draftConfig.value).maxPacketBytes,
  set: (maxPacketBytes) => {
    draftConfig.value = { ...smpConfig(draftConfig.value), maxPacketBytes: maxPacketBytes ?? 0 };
    draftPresetId.value = null;
  },
});
const draftSmpReassemblyTimeoutMs = computed<number | null>({
  get: () => smpConfig(draftConfig.value).reassemblyTimeoutMs,
  set: (reassemblyTimeoutMs) => {
    draftConfig.value = {
      ...smpConfig(draftConfig.value),
      reassemblyTimeoutMs: reassemblyTimeoutMs ?? 0,
    };
    draftPresetId.value = null;
  },
});

const configSummary = computed(() => summarizeConfig(currentConfig.value));
const draftValidation = computed(() => validateDraft(draftConfig.value, delimiterHexDraft.value));
const configValidationError = computed(() => draftValidation.value.error);

watch(
  currentConfig,
  (config) => {
    if (!configEditing.value) syncDraft(config, parserState.value.presetId);
  },
  { deep: true },
);

function beginConfigEdit() {
  syncDraft(currentConfig.value, parserState.value.presetId);
  reparseExisting.value = appliedReparseExisting.value;
  configEditing.value = true;
}

function cancelConfigEdit() {
  syncDraft(currentConfig.value, parserState.value.presetId);
  reparseExisting.value = appliedReparseExisting.value;
  configEditing.value = false;
  void nextTick(() => document.querySelector<HTMLElement>('.parser-panel .pp-edit')?.focus());
}

function syncDraft(config: ParserConfig, presetId: string | null) {
  draftConfig.value = cloneConfig(config);
  draftPresetId.value = presetId;
  delimiterHexDraft.value = initialDelimiterHex(config);
}

function updateDraftKind(value: string) {
  if (!isParserKind(value) || draftConfig.value.kind === value) return;
  draftConfig.value = configForKind(draftConfig.value, value);
  delimiterHexDraft.value = initialDelimiterHex(draftConfig.value);
  draftPresetId.value = null;
}

function updateDraftDelimiterHex(value: string) {
  delimiterHexDraft.value = value;
  draftPresetId.value = null;
}

function updateDraftSmpTransport(value: string) {
  if (value !== 'serial-console' && value !== 'raw-uart') return;
  draftConfig.value = { ...smpConfig(draftConfig.value), transport: value };
  draftPresetId.value = null;
}

function updateDraftLengthSize(value: number) {
  if (value !== 1 && value !== 2 && value !== 4) return;
  draftLengthSize.value = value;
}

function applyPresetToDraft(id: string) {
  const preset = PARSER_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) return;
  draftConfig.value = cloneConfig(preset.config);
  delimiterHexDraft.value = initialDelimiterHex(draftConfig.value);
  draftPresetId.value = id;
}

function applyDraftConfig() {
  const result = draftValidation.value;
  if (!result.config) return;
  props.onApplyReplayPreference?.(reparseExisting.value);
  appliedReparseExisting.value = reparseExisting.value;
  documentStore.setParserState(props.sessionId, result.config, draftPresetId.value);
  configEditing.value = false;
  void nextTick(() => document.querySelector<HTMLElement>('.parser-panel .pp-edit')?.focus());
}

function validateDraft(
  config: ParserConfig,
  delimiterHex: string,
): { config: ParserConfig | null; error: string } {
  if (config.kind === 'delimiter') {
    const parsed = parseStrictDelimiterHex(delimiterHex);
    if (!parsed.ok) {
      return {
        config: null,
        error:
          parsed.reason === 'empty'
            ? t('parser.validation.delimiterEmpty')
            : parsed.reason === 'too-long'
              ? t('parser.validation.delimiterTooLong')
              : t('parser.validation.delimiterSyntax'),
      };
    }
    return { config: { ...config, delimiter: parsed.bytes }, error: '' };
  }
  if (config.kind === 'fixed') {
    if (!integerInRange(config.frameSize, 1, 65_535)) {
      return { config: null, error: t('parser.validation.frameSize') };
    }
    return { config: cloneConfig(config), error: '' };
  }
  if (config.kind === 'length') {
    if (!integerInRange(config.lengthOffset, 0, 255)) {
      return { config: null, error: t('parser.validation.lengthOffset') };
    }
    if (!integerInRange(config.lengthAdjust, 0, 65_535)) {
      return { config: null, error: t('parser.validation.lengthAdjust') };
    }
    return { config: cloneConfig(config), error: '' };
  }
  if (
    !integerInRange(
      config.maxPacketBytes,
      MIN_SMP_PARSER_MAX_PACKET_BYTES,
      MAX_SMP_PARSER_MAX_PACKET_BYTES,
    )
  ) {
    return { config: null, error: t('parser.validation.smpMaxPacket') };
  }
  if (
    !integerInRange(
      config.reassemblyTimeoutMs,
      MIN_SMP_REASSEMBLY_TIMEOUT_MS,
      MAX_SMP_REASSEMBLY_TIMEOUT_MS,
    )
  ) {
    return { config: null, error: t('parser.validation.smpTimeout') };
  }
  return { config: cloneConfig(config), error: '' };
}

function cloneConfig(config: ParserConfig): ParserConfig {
  if (config.kind === 'delimiter') return { ...config, delimiter: [...config.delimiter] };
  return { ...config };
}

function initialDelimiterHex(config: ParserConfig): string {
  return config.kind === 'delimiter' ? formatDelimiterHex(config.delimiter) : '';
}

function isParserKind(value: string): value is ParserKind {
  return value === 'delimiter' || value === 'fixed' || value === 'length' || value === 'mcumgr-smp';
}

function integerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function summarizeConfig(config: ParserConfig): string {
  if (config.kind === 'delimiter') {
    const delimiter = formatDelimiterHex(config.delimiter);
    return `${t('parser.kind.delimiter')} · ${delimiter} · ${config.includeDelimiter ? t('parser.includeDelimiter') : t('parser.config.excludeDelimiter')}`;
  }
  if (config.kind === 'fixed') {
    return `${t('parser.kind.fixed')} · ${config.frameSize}B`;
  }
  if (config.kind === 'length') {
    return `${t('parser.kind.length')} · off ${config.lengthOffset} · ${config.lengthSize}B · ${config.bigEndian ? 'BE' : 'LE'} · adj ${config.lengthAdjust}`;
  }
  return `${t('parser.kind.mcumgrSmp')} · ${transportLabel(config.transport)} · ${config.maxPacketBytes}B · ${config.reassemblyTimeoutMs}ms`;
}

function transportLabel(transport: SmpParserTransport): string {
  return transport === 'serial-console'
    ? t('parser.smp.transport.serialConsole')
    : t('parser.smp.transport.rawUart');
}

const selectedRecordId = ref<string | null>(null);
const searchTerm = ref('');
const directionFilter = ref<ProtocolRecordDirectionFilter>('all');
const statusFilter = ref<ProtocolRecordStatusFilter>('all');
const transactionFilter = ref<ProtocolRecordTransactionFilter>('all');
const groupFilter = ref('');
const commandFilter = ref('');
const sequenceFilter = ref('');
const autoFollow = ref(true);
const smpMode = computed(() => currentConfig.value.kind === 'mcumgr-smp');

const filteredRecords = computed(() =>
  filterProtocolRecords(props.parsedFrames, {
    searchTerm: searchTerm.value,
    direction: directionFilter.value,
    status: statusFilter.value,
    transaction: smpMode.value ? transactionFilter.value : 'all',
    group: smpMode.value ? groupFilter.value : '',
    command: smpMode.value ? commandFilter.value : '',
    sequence: smpMode.value ? sequenceFilter.value : '',
  }),
);

const selectedRecord = computed(
  () =>
    props.parsedFrames.find((record) => recordStableId(record) === selectedRecordId.value) ?? null,
);
const filteredRecordCount = computed(() => filteredRecords.value.length);
const { scrollRef, virtualItems, totalSize, measureElement, onScroll, scrollToIndex } =
  usePacketVirtualScroll({
    frameCount: filteredRecordCount,
    autoScroll: autoFollow,
    rowSize: () => 44,
    itemKey: (index) => {
      const record = filteredRecords.value[index];
      return record ? recordStableId(record) : index;
    },
  });

const virtualRows = computed(() =>
  virtualItems.value.flatMap((item) => {
    const record = filteredRecords.value[item.index];
    return record ? [{ record, index: item.index, start: item.start, size: item.size }] : [];
  }),
);

watch(smpMode, (enabled) => {
  if (enabled) return;
  transactionFilter.value = 'all';
  groupFilter.value = '';
  commandFilter.value = '';
  sequenceFilter.value = '';
});

onMounted(() => {
  if (!autoFollow.value || filteredRecords.value.length === 0) return;
  void nextTick(() => scrollToIndex(filteredRecords.value.length - 1));
});

watch(
  () => props.parserResetVersion,
  () => {
    selectedRecordId.value = null;
  },
);

const stats = computed(() => parsedFrameStats(props.parsedFrames));
const totalBytes = computed(() => stats.value.totalBytes);
const largestFrame = computed(() => stats.value.largestFrame);

function selectRecord(record: ParserPanelRecord) {
  selectedRecordId.value = recordStableId(record);
}

function onListKeydown(event: KeyboardEvent) {
  if (filteredRecords.value.length === 0) return;
  const currentIndex = filteredRecords.value.findIndex(
    (record) => recordStableId(record) === selectedRecordId.value,
  );
  let nextIndex: number;
  if (event.key === 'ArrowDown')
    nextIndex = Math.min(filteredRecords.value.length - 1, currentIndex + 1);
  else if (event.key === 'ArrowUp')
    nextIndex = Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1);
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = filteredRecords.value.length - 1;
  else if (event.key === 'Enter') nextIndex = currentIndex < 0 ? 0 : currentIndex;
  else return;

  event.preventDefault();
  const record = filteredRecords.value[nextIndex];
  if (!record) return;
  selectRecord(record);
  scrollToIndex(nextIndex);
  void nextTick(() => document.getElementById(recordDomId(record))?.focus());
}

function onPanelEscape(event: KeyboardEvent) {
  if (configEditing.value) {
    event.stopPropagation();
    cancelConfigEdit();
    return;
  }
  if (selectedRecordId.value) {
    event.stopPropagation();
    selectedRecordId.value = null;
    scrollRef.value?.focus();
  }
}

async function focusInspector() {
  await nextTick();
  document.querySelector<HTMLElement>('.parser-panel .detail-content')?.focus();
}

function recordStableId(record: ParserPanelRecord): string {
  return (
    record.id ??
    `legacy:${record.captureSeq ?? 'none'}:${record.direction ?? 'RX'}:${record.offset}:${record.data.length}`
  );
}

function recordDomId(record: ParserPanelRecord): string {
  let hash = 2166136261;
  for (const character of recordStableId(record)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `parser-record-${hash >>> 0}`;
}

function isSmp(record: ParserPanelRecord): boolean {
  return record.kind === 'smp';
}

function recordDirection(record: ParserPanelRecord): 'TX' | 'RX' {
  return protocolRecordDirection(record);
}

function recordStatus(record: ParserPanelRecord) {
  return protocolRecordStatus(record);
}

function recordTimestamp(record: ParserPanelRecord): string {
  if (record.timestamp === undefined) return '';
  const date = new Date(record.timestamp);
  return Number.isNaN(date.getTime())
    ? String(record.timestamp)
    : date.toLocaleTimeString([], { hour12: false });
}

function transactionLabel(record: ParserPanelRecord): string {
  const transaction = protocolRecordTransaction(record);
  if (transaction === 'request') return t('parser.transaction.requestShort');
  if (transaction === 'response') return t('parser.transaction.responseShort');
  if (transaction === 'unmatched') return t('parser.transaction.unmatchedShort');
  return 'SMP';
}

function smpRoute(record: ParserPanelRecord): string {
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

function recordTitle(record: ParserPanelRecord): string {
  const prefix = t('parser.offsetTitle', { offset: record.offset });
  if (record.kind === 'smp' && locale.value === 'zh') {
    return `${prefix} · ${transactionLabel(record)} · ${smpRoute(record)} · #${String(record.header?.sequence ?? '—')}`;
  }
  return record.summary ? `${prefix} · ${record.summary}` : prefix;
}

function recordDiagnosticSummary(record: ParserPanelRecord): string {
  return record.diagnostics?.map((diagnostic) => diagnosticText(diagnostic)).join('\n') ?? '';
}

function closeInspector() {
  selectedRecordId.value = null;
  void nextTick(() => scrollRef.value?.focus());
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
  const maxBytes = 22;
  const preview = formatHex(bytes.subarray(0, maxBytes));
  return bytes.length > maxBytes ? `${preview}\u2026` : preview;
}

async function copyBytes(bytes: Uint8Array) {
  await copyText(formatHex(bytes), t('parser.copiedHex'));
}

async function copyAscii(frame: { data: Uint8Array }) {
  await copyText(frameAsciiText(frame), t('parser.copiedAscii'));
}

async function copyText(value: string, successMessage = t('parser.copied')) {
  try {
    await navigator.clipboard.writeText(value);
    message.success(successMessage);
  } catch {
    message.error(t('packet.copyFailed'));
  }
}
</script>

<style scoped>
.parser-panel {
  container: parser-panel / inline-size;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-inset);
}

.parser-body {
  min-height: 0;
  flex: 1;
  display: flex;
  overflow: hidden;
}

.pp-list {
  position: relative;
  min-width: 0;
  flex: 1;
  overflow: auto;
  padding: 6px 8px;
  outline: none;
}

.pp-list:focus-visible {
  box-shadow: inset 0 0 0 2px var(--color-primary-muted);
}

.inspector-resize-handle {
  position: relative;
  z-index: 2;
  width: 8px;
  flex: 0 0 8px;
  align-self: stretch;
  border: 0;
  background: transparent;
  cursor: col-resize;
  outline: none;
  touch-action: none;
}

.inspector-resize-handle::before {
  position: absolute;
  inset: 0 auto 0 50%;
  width: 1px;
  background: var(--border-subtle);
  content: '';
  transform: translateX(-50%);
  transition: background var(--transition-fast);
}

.inspector-resize-grip {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 3px;
  height: 38px;
  border-radius: 999px;
  background: var(--text-dim);
  opacity: 0.35;
  transform: translate(-50%, -50%);
  transition:
    background var(--transition-fast),
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.inspector-resize-handle:hover::before,
.inspector-resize-handle.dragging::before,
.inspector-resize-handle:focus-visible::before {
  background: var(--color-primary);
}

.inspector-resize-handle:hover .inspector-resize-grip,
.inspector-resize-handle.dragging .inspector-resize-grip,
.inspector-resize-handle:focus-visible .inspector-resize-grip {
  background: var(--color-primary);
  opacity: 1;
  transform: translate(-50%, -50%) scaleY(1.12);
}

.inspector-resize-handle:focus-visible {
  box-shadow: inset 0 0 0 2px var(--border-focus);
}

.pp-virtual-space {
  position: relative;
  width: 100%;
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
  right: 0;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 7px;
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

.pp-idx {
  min-width: 42px;
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

.record-time,
.smp-seq,
.smp-rtt {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.transaction-badge {
  color: var(--text-muted);
  background: var(--bg-secondary);
}

.framing-badge {
  color: var(--text-muted);
  background: var(--bg-secondary);
}

.smp-route {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
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

.pp-hex {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--accent-blue);
  letter-spacing: 0.2px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pp-len {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
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
  .parser-body {
    flex-direction: column;
  }

  .inspector-resize-handle {
    width: 100%;
    height: 8px;
    flex-basis: 8px;
    cursor: row-resize;
  }

  .inspector-resize-handle::before {
    inset: 50% 0 auto;
    width: auto;
    height: 1px;
    transform: translateY(-50%);
  }

  .inspector-resize-grip {
    width: 38px;
    height: 3px;
  }

  .inspector-resize-handle:hover .inspector-resize-grip,
  .inspector-resize-handle.dragging .inspector-resize-grip,
  .inspector-resize-handle:focus-visible .inspector-resize-grip {
    transform: translate(-50%, -50%) scaleX(1.12);
  }

  .pp-list {
    min-height: min(140px, 40%);
  }

  .record-time,
  .status-badge {
    display: none;
  }
}

@container parser-panel (max-width: 540px) {
  .smp-rtt,
  .transaction-badge {
    display: none;
  }
}
</style>
