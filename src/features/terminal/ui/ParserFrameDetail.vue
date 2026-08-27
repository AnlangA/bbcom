<template>
  <aside
    v-if="frame"
    :id="paneId"
    class="pp-detail"
    :style="paneStyle"
    :aria-label="t('parser.inspector')"
    @keydown.esc.prevent.stop="$emit('close')"
  >
    <header class="detail-head">
      <div class="detail-heading">
        <span class="detail-title">{{ t('parser.inspector') }}</span>
        <span class="detail-meta">
          {{ direction }} ·
          <template v-if="frame.kind !== 'smp'">
            {{ t('parser.detail.offset') }} {{ frame.offset }} ·
          </template>
          {{ t('parser.detail.bytes', { count: frame.data.length }) }}
        </span>
      </div>
      <button
        class="detail-action detail-copy"
        type="button"
        :title="t('parser.copy')"
        @click="$emit('copy')"
      >
        <Copy class="icon-sm" />
      </button>
      <button
        class="detail-action detail-copy"
        type="button"
        :title="t('parser.detail.copyAscii')"
        @click="$emit('copy-ascii')"
      >
        <FileText class="icon-sm" />
      </button>
      <button
        class="detail-action detail-close"
        type="button"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="$emit('close')"
      >
        <X class="icon-sm" />
      </button>
    </header>

    <div class="detail-tabs" role="tablist" :aria-label="t('parser.inspector.tabs')">
      <button
        v-for="tab in tabs"
        :id="`${inspectorId}-tab-${tab.key}`"
        :key="tab.key"
        class="detail-tab"
        :class="{ active: activeTab === tab.key }"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.key"
        :aria-controls="`${inspectorId}-panel-${tab.key}`"
        :tabindex="activeTab === tab.key ? 0 : -1"
        @click="activeTab = tab.key"
        @keydown="onTabKeydown($event, tab.key)"
      >
        {{ tab.label }}
        <span v-if="tab.key === 'diagnostics' && diagnostics.length" class="tab-count">
          {{ diagnostics.length }}
        </span>
      </button>
    </div>

    <div
      v-for="tab in tabs"
      :id="`${inspectorId}-panel-${tab.key}`"
      :key="`${tab.key}-panel`"
      class="detail-content scrollbar-thin"
      :class="{ 'is-virtual-dump': tab.key === 'hex' || tab.key === 'raw' }"
      role="tabpanel"
      :aria-labelledby="`${inspectorId}-tab-${tab.key}`"
      :hidden="activeTab !== tab.key"
      :tabindex="activeTab === tab.key ? 0 : -1"
    >
      <template v-if="activeTab === tab.key">
        <dl v-if="activeTab === 'overview'" class="overview-grid">
          <template v-for="field in overviewFields" :key="field.label">
            <dt>{{ field.label }}</dt>
            <dd>
              <button
                v-if="field.range"
                class="field-link"
                type="button"
                @click="selectRange(field.range)"
              >
                {{ field.value }}
              </button>
              <span v-else>{{ field.value }}</span>
            </dd>
          </template>
        </dl>

        <div v-else-if="activeTab === 'header'" class="header-fields">
          <button
            v-for="field in headerFields"
            :key="field.key"
            class="header-field"
            :class="{ selected: rangesEqual(selectedRange, field.range) }"
            type="button"
            :disabled="!field.range"
            @click="field.range && selectRange(field.range)"
          >
            <span>{{ field.label }}</span>
            <strong>{{ field.value }}</strong>
            <small v-if="field.range"> {{ field.range.start }}..{{ field.range.end - 1 }} </small>
          </button>
          <div v-if="headerFields.length === 0" class="detail-empty">
            {{ t('parser.inspector.noHeader') }}
          </div>
        </div>

        <div v-else-if="activeTab === 'cbor'" class="cbor-panel">
          <div v-if="frame.cbor !== undefined" class="panel-actions">
            <button class="text-action" type="button" @click="copyCbor">
              <Copy class="icon-sm" />
              {{ t('parser.inspector.copyCbor') }}
            </button>
          </div>
          <ParserCborTree v-if="frame.cbor !== undefined" :value="frame.cbor" />
          <div v-else class="detail-empty">{{ t('parser.inspector.noCbor') }}</div>
        </div>

        <div v-else-if="activeTab === 'hex'" class="bytes-panel">
          <div v-if="selectedRange" class="panel-actions">
            <button class="text-action" type="button" @click="copySelectedRange">
              <Copy class="icon-sm" />
              {{ t('parser.inspector.copyField') }}
            </button>
          </div>
          <ParserByteDump
            ref="hexDumpRef"
            :data="frame.data"
            :highlight="selectedRange"
            :ariaLabel="t('parser.inspector.hexDump')"
          />
        </div>

        <div v-else-if="activeTab === 'raw'" class="bytes-panel">
          <div class="panel-actions">
            <button class="text-action" type="button" @click="copyRaw">
              <Copy class="icon-sm" />
              {{ t('parser.inspector.copyRaw') }}
            </button>
          </div>
          <ParserByteDump :data="rawBytes" :ariaLabel="t('parser.inspector.rawDump')" />
        </div>

        <div v-else class="diagnostics-panel">
          <div v-if="diagnostics.length" class="panel-actions">
            <button class="text-action" type="button" @click="copyDiagnostics">
              <Copy class="icon-sm" />
              {{ t('parser.inspector.copyDiagnostics') }}
            </button>
          </div>
          <button
            v-for="diagnostic in diagnostics"
            :key="diagnostic.key"
            class="diagnostic"
            :class="`severity-${diagnostic.severity}`"
            type="button"
            :disabled="!diagnostic.range"
            @click="diagnostic.range && selectRange(diagnostic.range)"
          >
            <span class="diagnostic-code">{{ diagnostic.code }}</span>
            <span>{{ diagnostic.message }}</span>
            <small v-if="diagnostic.range">
              {{
                t('parser.inspector.byteRange', {
                  start: diagnostic.range.start,
                  end: diagnostic.range.end - 1,
                })
              }}
            </small>
          </button>
          <div v-if="diagnostics.length === 0" class="detail-empty">
            {{ t('parser.inspector.noDiagnostics') }}
          </div>
        </div>
      </template>
    </div>
  </aside>

  <aside
    v-else
    :id="paneId"
    class="pp-detail pp-detail-empty"
    :style="paneStyle"
    :aria-label="t('parser.inspector')"
  >
    <Binary class="detail-icon" />
    <span>{{ t('parser.inspector.empty') }}</span>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { Binary, Copy, FileText, X } from '@lucide/vue';
import { protocolRecordRawBytes } from '@/lib/parser-panel';
import { byteHex } from '@/lib/protocol-parser';
import { locale, t } from '@/lib/i18n';
import { smpDiagnosticMessageZh } from '@/lib/mcumgr-smp-metadata';
import ParserCborTree from './ParserCborTree.vue';
import ParserByteDump from './ParserByteDump.vue';

export interface ParserByteRange {
  start: number;
  end: number;
}

export interface ParserInspectorHeader {
  version?: number | string;
  op?: number | string;
  opName?: string;
  opNameZh?: string;
  flags?: number | string;
  dataLength?: number;
  group?: number;
  groupName?: string;
  groupNameZh?: string;
  sequence?: number;
  command?: number;
  commandName?: string;
  commandNameZh?: string;
  requestResponse?: string;
}

export interface ParserInspectorRecord {
  data: Uint8Array;
  offset: number;
  kind?: string;
  parserKind?: 'delimiter' | 'fixed' | 'length';
  id?: string;
  direction?: 'TX' | 'RX';
  timestamp?: number;
  captureSeq?: number;
  status?: 'ok' | 'warning' | 'error' | 'pending';
  summary?: string;
  transport?: string;
  transportData?: Uint8Array;
  crcStatus?: string;
  header?: ParserInspectorHeader;
  cbor?: unknown;
  diagnostics?: readonly unknown[];
  requestId?: string;
  responseId?: string;
  rttMs?: number;
  ranges?: unknown;
}

const props = defineProps<{
  paneId?: string;
  compact?: boolean;
  inlineSize?: number;
  blockSize?: number;
  frame: ParserInspectorRecord | null;
  /** Retained for compatibility; the inspector now virtualizes dump rows. */
  dump?: readonly { offset: number; hex: string; ascii: string }[];
}>();

const emit = defineEmits<{
  copy: [];
  'copy-ascii': [];
  'copy-bytes': [Uint8Array];
  'copy-text': [string];
  close: [];
}>();

type DetailTab = 'overview' | 'header' | 'cbor' | 'hex' | 'raw' | 'diagnostics';

const inspectorId = useId();
const hexDumpRef = ref<{ scrollToByte: (offset: number) => void } | null>(null);
const paneStyle = computed(() => {
  if (props.compact && props.blockSize !== undefined) {
    return {
      width: '100%',
      height: `${props.blockSize}px`,
      flexBasis: `${props.blockSize}px`,
    };
  }
  if (!props.compact && props.inlineSize !== undefined) {
    return { width: `${props.inlineSize}px` };
  }
  return {};
});
const activeTab = ref<DetailTab>(props.frame?.kind === 'smp' ? 'overview' : 'hex');
const selectedRange = ref<ParserByteRange | null>(null);

const tabs = computed<Array<{ key: DetailTab; label: string }>>(() => {
  const common: Array<{ key: DetailTab; label: string }> = [
    { key: 'overview', label: t('parser.inspector.overview') },
    { key: 'hex', label: 'HEX' },
    { key: 'raw', label: t('parser.inspector.raw') },
    { key: 'diagnostics', label: t('parser.inspector.diagnostics') },
  ];
  if (props.frame?.kind !== 'smp') return common;
  return [
    common[0],
    { key: 'header', label: t('parser.inspector.header') },
    { key: 'cbor', label: 'CBOR' },
    ...common.slice(1),
  ];
});

const direction = computed(() => (props.frame?.direction === 'TX' ? 'TX' : 'RX'));
const rawBytes = computed(() => protocolRecordRawBytes(props.frame));

const overviewFields = computed(() => {
  if (!props.frame) return [];
  const frame = props.frame;
  const fields: Array<{ label: string; value: string; range?: ParserByteRange }> = [
    { label: t('parser.field.direction'), value: direction.value },
    {
      label: t('parser.field.timestamp'),
      value: frame.timestamp === undefined ? '—' : formatTimestamp(frame.timestamp),
    },
    {
      label: t('parser.field.captureSeq'),
      value: frame.captureSeq === undefined ? '—' : String(frame.captureSeq),
    },
    { label: t('parser.field.offset'), value: String(frame.offset) },
    { label: t('parser.field.length'), value: String(frame.data.length) },
    { label: t('parser.field.status'), value: t(`parser.status.${frame.status ?? 'ok'}`) },
  ];
  if (frame.kind !== 'smp' && frame.parserKind) {
    fields.push({ label: t('parser.config.mode'), value: parserKindLabel(frame.parserKind) });
  }
  if (frame.kind === 'smp') {
    fields.push(
      {
        label: t('parser.smp.transport'),
        value: transportLabel(frame.transport),
      },
      { label: t('parser.field.crc'), value: frame.crcStatus ?? '—' },
      { label: t('parser.field.summary'), value: localizedSummary(frame) },
      { label: t('parser.field.requestId'), value: frame.requestId ?? '—' },
      { label: t('parser.field.responseId'), value: frame.responseId ?? '—' },
      {
        label: t('parser.field.rtt'),
        value: frame.rttMs === undefined ? '—' : `${frame.rttMs.toFixed(1)} ms`,
      },
    );
  }
  return fields;
});

const headerFields = computed(() => {
  const header = props.frame?.header;
  if (!header || !props.frame) return [];
  const values: Array<[string, string, unknown]> = [
    ['version', t('parser.field.version'), header.version],
    [
      'op',
      t('parser.field.op'),
      joinName(header.op, localizedName(header.opName, header.opNameZh)),
    ],
    ['flags', t('parser.field.flags'), formatNumeric(header.flags)],
    ['dataLength', t('parser.field.dataLength'), header.dataLength],
    [
      'group',
      t('parser.filter.group'),
      joinName(header.group, localizedName(header.groupName, header.groupNameZh)),
    ],
    ['sequence', t('parser.filter.sequence'), header.sequence],
    [
      'command',
      t('parser.filter.command'),
      joinName(header.command, localizedName(header.commandName, header.commandNameZh)),
    ],
  ];
  return values
    .filter(([, , value]) => value !== undefined)
    .map(([key, label, value]) => ({
      key,
      label,
      value: String(value),
      range: findRange(props.frame!, key),
    }));
});

const diagnostics = computed(() => {
  if (!props.frame?.diagnostics) return [];
  return props.frame.diagnostics.map((value, index) => normalizeDiagnostic(value, index));
});

watch(
  () => props.frame?.id ?? props.frame?.offset,
  () => {
    activeTab.value = props.frame?.kind === 'smp' ? 'overview' : 'hex';
    selectedRange.value = null;
  },
);

function onTabKeydown(event: KeyboardEvent, current: DetailTab) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = tabs.value.findIndex((tab) => tab.key === current);
  let nextIndex = index;
  if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.value.length) % tabs.value.length;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.value.length;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = tabs.value.length - 1;
  const next = tabs.value[nextIndex];
  activeTab.value = next.key;
  document.getElementById(`${inspectorId}-tab-${next.key}`)?.focus();
}

function selectRange(range: ParserByteRange) {
  selectedRange.value = range;
  activeTab.value = 'hex';
  void nextTick(() => hexDumpRef.value?.scrollToByte(range.start));
}

function copySelectedRange() {
  if (!props.frame || !selectedRange.value) return;
  emit('copy-bytes', props.frame.data.slice(selectedRange.value.start, selectedRange.value.end));
}

function copyRaw() {
  emit('copy-bytes', rawBytes.value);
}

function copyCbor() {
  emit('copy-text', safeJson(props.frame?.cbor));
}

function copyDiagnostics() {
  emit(
    'copy-text',
    diagnostics.value.map((item) => `[${item.severity}] ${item.code}: ${item.message}`).join('\n'),
  );
}

function findRange(frame: ParserInspectorRecord, key: string): ParserByteRange | undefined {
  if (!frame.ranges || typeof frame.ranges !== 'object') return undefined;
  const ranges = frame.ranges as Record<string, unknown>;
  const fixedHeaderRanges: Record<string, ParserByteRange> = {
    version: { start: 0, end: 1 },
    op: { start: 0, end: 1 },
    flags: { start: 1, end: 2 },
    dataLength: { start: 2, end: 4 },
    group: { start: 4, end: 6 },
    sequence: { start: 6, end: 7 },
    command: { start: 7, end: 8 },
  };
  const candidates = [
    ranges[key],
    (ranges.headerFields as Record<string, unknown> | undefined)?.[key],
    (ranges.fields as Record<string, unknown> | undefined)?.[key],
    frame.kind === 'smp' ? fixedHeaderRanges[key] : undefined,
  ];
  for (const candidate of candidates) {
    const range = normalizeRange(candidate);
    if (range) return clampRange(range, frame.data.length);
  }
  return undefined;
}

function normalizeRange(value: unknown): ParserByteRange | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ParserByteRange> & {
    offset?: number;
    length?: number;
  };
  if (
    Number.isInteger(candidate.start) &&
    Number.isInteger(candidate.end) &&
    Number(candidate.start) >= 0 &&
    Number(candidate.end) > Number(candidate.start)
  ) {
    return { start: Number(candidate.start), end: Number(candidate.end) };
  }
  if (
    Number.isInteger(candidate.offset) &&
    Number.isInteger(candidate.length) &&
    Number(candidate.offset) >= 0 &&
    Number(candidate.length) > 0
  ) {
    return {
      start: Number(candidate.offset),
      end: Number(candidate.offset) + Number(candidate.length),
    };
  }
  return undefined;
}

function clampRange(range: ParserByteRange, length: number): ParserByteRange {
  return { start: Math.min(range.start, length), end: Math.min(range.end, length) };
}

function rangesEqual(left: ParserByteRange | null, right?: ParserByteRange): boolean {
  return Boolean(left && right && left.start === right.start && left.end === right.end);
}

function normalizeDiagnostic(value: unknown, index: number) {
  if (typeof value === 'string') {
    return {
      key: `${index}:${value}`,
      code: t('parser.inspector.diagnostic'),
      severity: 'warning',
      message: value,
      range: undefined,
    };
  }
  const diagnostic =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const offset = typeof diagnostic.offset === 'number' ? diagnostic.offset : undefined;
  const length = typeof diagnostic.length === 'number' ? diagnostic.length : 1;
  const code = String(diagnostic.code ?? t('parser.inspector.diagnostic'));
  const message = String(diagnostic.message ?? diagnostic.messageZh ?? value);
  return {
    key: `${index}:${code}`,
    code,
    severity: normalizeSeverity(diagnostic.severity),
    message:
      locale.value === 'zh'
        ? String(diagnostic.messageZh ?? smpDiagnosticMessageZh(code, message))
        : message,
    range:
      offset === undefined || !props.frame
        ? undefined
        : clampRange({ start: offset, end: offset + length }, props.frame.data.length),
  };
}

function localizedName(english: unknown, chinese: unknown): unknown {
  return locale.value === 'zh' ? (chinese ?? english) : english;
}

function localizedSummary(frame: ParserInspectorRecord): string {
  if (locale.value !== 'zh' || !frame.header) return frame.summary ?? '—';
  const header = frame.header;
  const op = localizedName(header.opName, header.opNameZh) ?? header.op ?? 'SMP';
  const group = localizedName(header.groupName, header.groupNameZh) ?? header.group ?? '?';
  const command = localizedName(header.commandName, header.commandNameZh) ?? header.command ?? '?';
  return `${String(op)} · ${String(group)} / ${String(command)} · #${String(header.sequence ?? '—')}`;
}

function normalizeSeverity(value: unknown): 'ok' | 'warning' | 'error' | 'pending' {
  return value === 'error' || value === 'pending' || value === 'ok' ? value : 'warning';
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(
      value,
      (_key, nested) => {
        if (typeof nested === 'bigint') return nested.toString(10);
        if (nested instanceof Uint8Array) {
          return {
            bytes: nested.length,
            hex: Array.from(nested, (byte) => byteHex(byte).toUpperCase()).join(' '),
          };
        }
        if (nested instanceof Map) return Object.fromEntries(nested);
        if (nested && typeof nested === 'object') {
          if (seen.has(nested)) return '[Circular]';
          seen.add(nested);
        }
        return nested;
      },
      2,
    ) ?? ''
  );
}

function joinName(value: unknown, name: unknown): string {
  if (name === undefined || name === '') return String(value ?? '—');
  return `${String(name)} (${String(value)})`;
}

function formatNumeric(value: unknown): string {
  return typeof value === 'number' ? `0x${value.toString(16).toUpperCase()}` : String(value ?? '—');
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString();
}

function transportLabel(value: string | undefined): string {
  if (value === 'serial-console') return t('parser.smp.transport.serialConsole');
  if (value === 'raw-uart') return t('parser.smp.transport.rawUart');
  return value ?? '—';
}

function parserKindLabel(kind: 'delimiter' | 'fixed' | 'length'): string {
  return t(`parser.kind.${kind}`);
}
</script>

<style scoped>
.pp-detail {
  width: min(440px, 42%);
  min-width: 300px;
  max-width: calc(100% - 268px);
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-primary);
  border-left: 0;
}

.pp-detail-empty {
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  text-align: center;
}

.detail-icon {
  width: 32px;
  height: 32px;
}

.detail-head {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.detail-heading {
  min-width: 0;
  flex: 1;
  display: grid;
}

.detail-title {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 700;
}

.detail-meta {
  overflow: hidden;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-action {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}

.detail-action:hover,
.detail-action:focus-visible {
  color: var(--text-primary);
  background: var(--bg-hover);
  outline: none;
}

.detail-tabs {
  display: flex;
  overflow-x: auto;
  padding: 0 6px;
  border-bottom: 1px solid var(--border-subtle);
}

.detail-tab {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 0 8px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.detail-tab:hover,
.detail-tab:focus-visible {
  color: var(--text-primary);
  background: var(--bg-hover);
  outline: none;
}

.detail-tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.tab-count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent-orange-subtle);
  color: var(--accent-orange);
  font-family: var(--font-mono);
  font-size: 10px;
}

.detail-content {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 10px;
  overscroll-behavior: contain;
}

.detail-content[hidden] {
  display: none;
}

.detail-content.is-virtual-dump:not([hidden]) {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.overview-grid {
  display: grid;
  grid-template-columns: minmax(110px, auto) 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: var(--font-size-sm);
}

.overview-grid dt {
  color: var(--text-dim);
}

.overview-grid dd {
  min-width: 0;
  margin: 0;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

.field-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent-blue);
  font: inherit;
  cursor: pointer;
}

.header-fields {
  display: grid;
  gap: 5px;
}

.header-field {
  display: grid;
  grid-template-columns: minmax(90px, auto) 1fr auto;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 5px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-muted);
  text-align: left;
}

.header-field:not(:disabled) {
  cursor: pointer;
}

.header-field:not(:disabled):hover,
.header-field:not(:disabled):focus-visible,
.header-field.selected {
  border-color: var(--color-primary-muted);
  background: var(--bg-active);
  outline: none;
}

.header-field strong {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-weight: 500;
}

.header-field small {
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.cbor-panel {
  min-width: max-content;
}

.panel-actions {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-bottom: 8px;
}

.bytes-panel {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.text-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 2px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.text-action:hover,
.text-action:focus-visible {
  color: var(--text-primary);
  border-color: var(--color-primary-muted);
  outline: none;
}

.diagnostics-panel {
  display: grid;
  gap: 7px;
}

.diagnostic {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 8px;
  padding: 8px;
  border: 1px solid var(--border-subtle);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  text-align: left;
}

.diagnostic:not(:disabled) {
  cursor: pointer;
}

.diagnostic:not(:disabled):hover,
.diagnostic:not(:disabled):focus-visible {
  background: var(--bg-hover);
  outline: none;
}

.diagnostic.severity-warning {
  border-left-color: var(--accent-orange);
}

.diagnostic.severity-error {
  border-left-color: var(--color-error);
}

.diagnostic.severity-ok {
  border-left-color: var(--color-success);
}

.diagnostic-code,
.diagnostic small {
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.diagnostic small {
  grid-column: 2;
}

.detail-empty {
  display: grid;
  min-height: 120px;
  place-items: center;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  text-align: center;
}

.detail-close {
  display: none;
}

@container parser-panel (max-width: 820px) {
  .pp-detail {
    width: 100%;
    min-width: 0;
    max-width: none;
    height: 48%;
    min-height: 0;
    max-height: calc(100% - 8px);
    flex-basis: 48%;
    border-top: 0;
    border-left: 0;
  }

  .detail-close {
    display: grid;
  }
}
</style>
