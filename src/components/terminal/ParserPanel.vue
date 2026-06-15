<template>
  <div class="parser-panel">
    <div class="parser-header">
      <span class="pp-title">
        <Binary class="icon-sm" />
        {{ t('parser.title') }}
      </span>
      <div class="pp-config">
        <n-select
          :value="presetId"
          :options="presetOptions"
          :placeholder="t('parser.presetPlaceholder')"
          size="tiny"
          style="width: 150px"
          @update:value="applyPreset"
        />
        <n-select
          v-model:value="configKind"
          :options="kindOptions"
          size="tiny"
          style="width: 96px"
        />
        <n-input
          v-if="configKind === 'delimiter'"
          v-model:value="delimiterHex"
          size="tiny"
          :placeholder="t('parser.delimiterPlaceholder')"
          style="width: 130px"
        />
        <n-checkbox
          v-if="configKind === 'delimiter'"
          v-model:checked="includeDelimiter"
          size="small"
        >
          {{ t('parser.includeDelimiter') }}
        </n-checkbox>
        <n-input-number
          v-if="configKind === 'fixed'"
          v-model:value="fixedSize"
          size="tiny"
          :min="1"
          :max="65535"
          style="width: 110px"
        >
          <template #suffix>B</template>
        </n-input-number>
        <template v-if="configKind === 'length'">
          <n-input-number
            v-model:value="lenOffset"
            size="tiny"
            :min="0"
            :max="255"
            style="width: 90px"
          >
            <template #suffix>off</template>
          </n-input-number>
          <n-select
            v-model:value="lenSize"
            :options="lenSizeOptions"
            size="tiny"
            style="width: 70px"
          />
          <n-checkbox v-model:checked="lenBigEndian" size="small">BE</n-checkbox>
          <n-input-number
            v-model:value="lenAdjust"
            size="tiny"
            :min="0"
            :max="65535"
            style="width: 90px"
          >
            <template #suffix>adj</template>
          </n-input-number>
        </template>
      </div>
      <button class="pp-close" type="button" :title="t('parser.close')" @click="emit('close')">
        <X class="icon-sm" />
      </button>
    </div>

    <!-- Live stats row: frame count, total bytes, throughput, largest frame. -->
    <div class="pp-stats">
      <span class="stat">
        <span class="stat-label">{{ t('session.stats.frames') }}</span>
        <span class="stat-val">{{ parsedFrames.length }}</span>
      </span>
      <span class="stat">
        <span class="stat-label">{{ t('common.bytes') }}</span>
        <span class="stat-val">{{
          t('parser.totalBytes', { bytes: formatBytes(totalBytes) })
        }}</span>
      </span>
      <span v-if="throughputBps > 0" class="stat">
        <span class="stat-label">{{ t('status.rate') }}</span>
        <span class="stat-val">{{
          t('parser.throughput', { rate: formatBytes(throughputBps) })
        }}</span>
      </span>
      <span v-if="largestFrame > 0" class="stat">
        <span class="stat-label">{{ t('parser.largestFrame') }}</span>
        <span class="stat-val">{{ t('parser.largest', { bytes: largestFrame }) }}</span>
      </span>
      <div class="pp-search">
        <n-input
          v-model:value="searchTerm"
          size="tiny"
          :placeholder="t('parser.search')"
          clearable
          style="width: 180px"
        >
          <template #prefix>
            <Search class="icon-sm search-icon" />
          </template>
        </n-input>
      </div>
    </div>

    <!-- Split body: frame list (left) + hex/ascii detail of the selected frame (right). -->
    <div class="parser-body">
      <div class="pp-list scrollbar-thin">
        <div v-if="filteredFrames.length === 0" class="pp-empty">
          {{ parsedFrames.length === 0 ? t('parser.empty') : t('packet.noMatch') }}
        </div>
        <div
          v-for="(f, i) in renderedFilteredFrames"
          :key="`${renderedStartIndex + i}:${f.offset}:${f.data.length}`"
          class="pp-frame"
          :class="{ selected: selectedFrame === f }"
          :title="t('parser.offsetTitle', { offset: f.offset })"
          @click="selectedFrame = f"
        >
          <span class="pp-idx">#{{ renderedStartIndex + i + 1 }}</span>
          <span class="pp-hex">{{ truncateHex(formatHex(f.data), 48) }}</span>
          <span class="pp-len">{{ f.data.length }}B</span>
          <button
            class="pp-copy"
            type="button"
            :title="t('parser.copy')"
            @click.stop="copyFrame(f)"
          >
            <Copy class="icon-sm" />
          </button>
        </div>
      </div>
      <div v-if="selectedFrame" class="pp-detail scrollbar-thin">
        <div class="detail-head">
          <span class="detail-title">{{ t('parser.detail') }}</span>
          <span class="detail-meta">
            {{ t('parser.detail.offset') }} {{ selectedFrame.offset }} ·
            {{ t('parser.detail.bytes', { count: selectedFrame.data.length }) }}
          </span>
          <button
            class="detail-copy"
            type="button"
            :title="t('parser.copy')"
            @click="copyFrame(selectedFrame)"
          >
            <Copy class="icon-sm" />
          </button>
          <button
            class="detail-copy"
            type="button"
            :title="t('parser.detail.copyAscii')"
            @click="copyAscii(selectedFrame)"
          >
            <FileText class="icon-sm" />
          </button>
        </div>
        <div v-for="row in detailDump" :key="row.offset" class="detail-row">
          <span class="dump-offset">{{ row.offset.toString(16).padStart(4, '0') }}</span>
          <span class="dump-hex">{{ row.hex }}</span>
          <span class="dump-ascii">{{ row.ascii }}</span>
        </div>
      </div>
      <div v-else class="pp-detail pp-detail-empty">
        <Binary class="icon-lg detail-icon" />
        <span>{{ t('parser.detail') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NCheckbox, NInput, NInputNumber, NSelect, useMessage } from 'naive-ui';
import { Binary, Copy, FileText, Search, X } from 'lucide-vue-next';
import {
  ProtocolParser,
  byteAscii,
  frameMatchesText,
  hexDump,
  parseDelimiterHex,
  type ParserConfig,
} from '../../lib/protocol-parser';
import { PARSER_PRESETS } from '../../lib/parser-presets';
import { formatBytes, formatHex } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { DataFrame } from '../../types';
import { useSessionStore } from '../../stores/sessions';

interface DisplayParsedFrame {
  data: Uint8Array;
  offset: number;
}

const props = defineProps<{
  sessionId: string;
  frames: DataFrame[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const sessionStore = useSessionStore();
const message = useMessage();
const MAX_RENDERED_PARSED_FRAMES = 500;

type Kind = 'delimiter' | 'length' | 'fixed';
type DelimiterParserConfig = Extract<ParserConfig, { kind: 'delimiter' }>;
type FixedParserConfig = Extract<ParserConfig, { kind: 'fixed' }>;
type LengthParserConfig = Extract<ParserConfig, { kind: 'length' }>;

const DEFAULT_DELIMITER_CONFIG: DelimiterParserConfig = {
  kind: 'delimiter',
  delimiter: [0x0d, 0x0a],
  includeDelimiter: false,
};
const DEFAULT_FIXED_CONFIG: FixedParserConfig = { kind: 'fixed', frameSize: 8 };
const DEFAULT_LENGTH_CONFIG: LengthParserConfig = {
  kind: 'length',
  lengthOffset: 0,
  lengthSize: 1,
  bigEndian: true,
  lengthAdjust: 1,
};

const kindOptions = computed(() => [
  { label: t('parser.kind.delimiter'), value: 'delimiter' },
  { label: t('parser.kind.fixed'), value: 'fixed' },
  { label: t('parser.kind.length'), value: 'length' },
]);
const lenSizeOptions = [
  { label: '1B', value: 1 },
  { label: '2B', value: 2 },
  { label: '4B', value: 4 },
];

const presetOptions = PARSER_PRESETS.map((p) => ({ label: p.name, value: p.id }));

const session = computed(() => sessionStore.sessions.find((s) => s.id === props.sessionId));
const parserState = computed(
  () =>
    session.value?.parserState ?? {
      config: DEFAULT_DELIMITER_CONFIG,
      presetId: 'at-crlf',
    },
);
const presetId = computed(() => parserState.value.presetId);
const currentConfig = computed<ParserConfig>(() => parserState.value.config);

const configKind = computed<Kind>({
  get: () => currentConfig.value.kind,
  set: (kind) => {
    if (kind === currentConfig.value.kind) return;
    if (kind === 'fixed') {
      setConfig(DEFAULT_FIXED_CONFIG, null);
    } else if (kind === 'length') {
      setConfig(DEFAULT_LENGTH_CONFIG, null);
    } else {
      setConfig(DEFAULT_DELIMITER_CONFIG, null);
    }
  },
});

function applyPreset(id: string | null) {
  if (!id) return;
  const preset = PARSER_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  setConfig(preset.config, id);
}

const delimiterHex = computed({
  get: () => {
    const cfg = delimiterConfig();
    return cfg.delimiter.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  },
  set: (value: string) => {
    setConfig(
      {
        ...delimiterConfig(),
        delimiter: parseDelimiterHex(value),
      },
      null,
    );
  },
});
const includeDelimiter = computed({
  get: () => delimiterConfig().includeDelimiter,
  set: (value: boolean) => {
    setConfig({ ...delimiterConfig(), includeDelimiter: value }, null);
  },
});
const fixedSize = computed({
  get: () => fixedConfig().frameSize,
  set: (value: number | null) => {
    setConfig({ kind: 'fixed', frameSize: Math.max(1, Math.floor(value || 1)) }, null);
  },
});
const lenOffset = computed({
  get: () => lengthConfig().lengthOffset,
  set: (value: number | null) => {
    setConfig({ ...lengthConfig(), lengthOffset: Math.max(0, Math.floor(value || 0)) }, null);
  },
});
const lenSize = computed({
  get: () => lengthConfig().lengthSize,
  set: (value: 1 | 2 | 4) => {
    setConfig({ ...lengthConfig(), lengthSize: value }, null);
  },
});
const lenBigEndian = computed({
  get: () => lengthConfig().bigEndian,
  set: (value: boolean) => {
    setConfig({ ...lengthConfig(), bigEndian: value }, null);
  },
});
const lenAdjust = computed({
  get: () => lengthConfig().lengthAdjust,
  set: (value: number | null) => {
    setConfig({ ...lengthConfig(), lengthAdjust: Math.max(0, Math.floor(value || 0)) }, null);
  },
});

function setConfig(config: ParserConfig, selectedPresetId: string | null) {
  sessionStore.setParserState(props.sessionId, config, selectedPresetId);
}

function delimiterConfig(): DelimiterParserConfig {
  return currentConfig.value.kind === 'delimiter' ? currentConfig.value : DEFAULT_DELIMITER_CONFIG;
}
function fixedConfig(): FixedParserConfig {
  return currentConfig.value.kind === 'fixed' ? currentConfig.value : DEFAULT_FIXED_CONFIG;
}
function lengthConfig(): LengthParserConfig {
  return currentConfig.value.kind === 'length' ? currentConfig.value : DEFAULT_LENGTH_CONFIG;
}

const parsedFrames = ref<DisplayParsedFrame[]>([]);
const selectedFrame = ref<DisplayParsedFrame | null>(null);
const searchTerm = ref('');
let parser = new ProtocolParser(currentConfig.value);
let consumedFrameCount = 0;
let runningOffset = 0;
let lastConfigKey = '';
// Throughput tracking: bytes parsed and the timestamp window they arrived in.
let windowStart = 0;
let windowBytes = 0;
const throughputBps = ref(0);

function configKey(cfg: ParserConfig): string {
  if (cfg.kind === 'fixed') return `fixed:${cfg.frameSize}`;
  if (cfg.kind === 'length') {
    return `length:${cfg.lengthOffset}:${cfg.lengthSize}:${cfg.bigEndian ? 1 : 0}:${cfg.lengthAdjust}`;
  }
  return `delimiter:${cfg.includeDelimiter ? 1 : 0}:${cfg.delimiter.join(',')}`;
}

function resetParser(cfg: ParserConfig) {
  parser = new ProtocolParser(cfg);
  parsedFrames.value = [];
  selectedFrame.value = null;
  consumedFrameCount = 0;
  runningOffset = 0;
  windowStart = 0;
  windowBytes = 0;
  throughputBps.value = 0;
}

function ingestFrames(startIndex: number) {
  const next = parsedFrames.value;
  const frames = props.frames;
  const now = Date.now();
  for (let i = startIndex; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame.direction !== 'RX') {
      // Non-RX frames don't advance the parsed byte stream offset.
      continue;
    }
    const parsed = parser.feed(frame.data);
    for (const p of parsed) {
      next.push({ data: p.data, offset: runningOffset + p.offset });
      windowBytes += p.data.length;
    }
    runningOffset += frame.data.length;
  }
  consumedFrameCount = frames.length;
  // Recompute throughput over a rolling ~1s window since the first new frame.
  if (windowBytes > 0) {
    if (windowStart === 0) windowStart = now;
    const elapsed = (now - windowStart) / 1000;
    if (elapsed >= 0.5) {
      throughputBps.value = Math.round(windowBytes / elapsed);
      // Slide the window forward so the rate reflects recent activity.
      windowStart = now;
      windowBytes = 0;
    }
  } else {
    throughputBps.value = 0;
    windowStart = 0;
  }
}

function syncParsedFrames() {
  const cfg = currentConfig.value;
  const key = configKey(cfg);
  const configChanged = key !== lastConfigKey;
  const framesWereReset = props.frames.length < consumedFrameCount;
  lastConfigKey = key;

  if (cfg.kind === 'delimiter' && cfg.delimiter.length === 0) {
    resetParser(cfg);
    return;
  }

  if (configChanged || framesWereReset) {
    resetParser(cfg);
    ingestFrames(0);
    return;
  }

  if (props.frames.length > consumedFrameCount) {
    ingestFrames(consumedFrameCount);
  }
}

watch(() => [props.frames.length, configKey(currentConfig.value)] as const, syncParsedFrames, {
  immediate: true,
});

// Search filter: case-insensitive substring against decoded frame text.
const filteredFrames = computed(() => {
  const term = searchTerm.value.trim();
  if (term.length === 0) return parsedFrames.value;
  return parsedFrames.value.filter((f) => frameMatchesText(f.data, term));
});

const renderedStartIndex = computed(() =>
  Math.max(0, filteredFrames.value.length - MAX_RENDERED_PARSED_FRAMES),
);
const renderedFilteredFrames = computed(() =>
  filteredFrames.value.length <= MAX_RENDERED_PARSED_FRAMES
    ? filteredFrames.value
    : filteredFrames.value.slice(renderedStartIndex.value),
);

// Aggregate stats over the full parsed set (not the filtered view).
const totalBytes = computed(() => parsedFrames.value.reduce((sum, f) => sum + f.data.length, 0));
const largestFrame = computed(() =>
  parsedFrames.value.reduce((max, f) => Math.max(max, f.data.length), 0),
);

const detailDump = computed(() =>
  selectedFrame.value ? hexDump(selectedFrame.value.data, 16) : [],
);

function truncateHex(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

async function copyFrame(f: { data: Uint8Array }) {
  try {
    await navigator.clipboard.writeText(formatHex(f.data));
    message.success(t('parser.copiedHex'));
  } catch {
    message.error(t('packet.copyFailed'));
  }
}

async function copyAscii(f: { data: Uint8Array }) {
  try {
    const text = Array.from(f.data, byteAscii).join('');
    await navigator.clipboard.writeText(text);
    message.success(t('parser.copiedHex'));
  } catch {
    message.error(t('packet.copyFailed'));
  }
}
</script>

<style scoped>
.parser-panel {
  display: flex;
  flex-direction: column;
  background: var(--bg-inset);
  flex: 1;
  min-height: 0;
}

.parser-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  font-size: 10px;
  color: var(--text-muted);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.pp-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.pp-config {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
}

.pp-close {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
}

.pp-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.pp-stats {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.stat-label {
  color: var(--text-dim);
  font-size: 10px;
  text-transform: uppercase;
}

.stat-val {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.pp-search {
  margin-left: auto;
}

.search-icon {
  color: var(--text-dim);
}

.parser-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.pp-list {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 4px 8px;
  border-right: 1px solid var(--border-subtle);
}

.pp-empty {
  color: var(--text-dim);
  font-size: 11px;
  padding: 24px 12px;
  text-align: center;
}

.pp-frame {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
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

.pp-idx {
  color: var(--text-dim);
  font-size: 10px;
  min-width: 36px;
}

.pp-hex {
  flex: 1;
  color: var(--accent-blue);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.3px;
}

.pp-len {
  color: var(--text-dim);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.pp-copy {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  opacity: 0;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    opacity var(--transition-fast);
}

.pp-frame:hover .pp-copy,
.pp-frame.selected .pp-copy {
  opacity: 1;
}

.pp-copy:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.pp-detail {
  width: 340px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 6px 8px;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pp-detail-empty {
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-dim);
  font-size: 11px;
  text-align: center;
}

.detail-icon {
  width: 32px;
  height: 32px;
  color: var(--text-dim);
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.detail-title {
  font-weight: 700;
  color: var(--text-secondary);
}

.detail-meta {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  text-transform: none;
  letter-spacing: 0;
}

.detail-copy {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
}

.detail-copy:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.detail-row {
  display: grid;
  grid-template-columns: 52px 1fr auto;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 18px;
  align-items: baseline;
}

.dump-offset {
  color: var(--text-dim);
}

.dump-hex {
  color: var(--accent-blue);
  letter-spacing: 0.5px;
  white-space: pre;
  overflow-x: auto;
}

.dump-ascii {
  color: var(--text-secondary);
  white-space: pre;
}

@media (max-width: 720px) {
  .pp-detail {
    display: none;
  }
}
</style>
