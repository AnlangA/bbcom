<template>
  <div class="parser-panel">
    <ParserConfigBar
      :preset-id="presetId"
      :preset-options="presetOptions"
      :kind-options="kindOptions"
      :len-size-options="lenSizeOptions"
      v-model:kind="configKind"
      v-model:delimiter-hex="delimiterHex"
      v-model:include-delimiter="includeDelimiter"
      v-model:fixed-size="fixedSize"
      v-model:len-offset="lenOffset"
      v-model:len-size="lenSize"
      v-model:len-big-endian="lenBigEndian"
      v-model:len-adjust="lenAdjust"
      @close="emit('close')"
      @apply-preset="applyPreset"
    />

    <ParserStatsBar
      :frame-count="parsedFrames.length"
      :total-bytes="totalBytes"
      :throughput-bps="throughputBps"
      :largest-frame="largestFrame"
      v-model:search-term="searchTerm"
    />

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
      <ParserFrameDetail
        :frame="selectedFrame"
        :dump="detailDump"
        @copy="copyFrame(selectedFrame!)"
        @copy-ascii="copyAscii(selectedFrame!)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { hexDump, type ParserConfig, type ParserKind } from '../../lib/protocol-parser';
import {
  ParserFrameCollector,
  parserConfigKey,
  type DisplayParsedFrame,
} from '../../lib/parser-frame-collector';
import { PARSER_PRESETS } from '../../lib/parser-presets';
import {
  configForKind,
  DEFAULT_DELIMITER_CONFIG,
  delimiterConfig,
  delimiterConfigFromHex,
  filterParsedFrames,
  fixedConfig,
  formatDelimiterHex,
  frameAsciiText,
  lengthConfig,
  MAX_RENDERED_PARSED_FRAMES,
  nonNegativeInteger,
  parsedFrameStats,
  positiveInteger,
  renderedParsedFrameWindow,
  truncateHexPreview,
} from '../../lib/parser-panel';
import { formatHex } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { DataFrame } from '../../types';
import { useSessionStore } from '../../stores/sessions';
import ParserConfigBar from './ParserConfigBar.vue';
import ParserStatsBar from './ParserStatsBar.vue';
import ParserFrameDetail from './ParserFrameDetail.vue';
import { Copy } from '@lucide/vue';

const props = defineProps<{
  sessionId: string;
  frames: DataFrame[];
  framesVersion: number;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const sessionStore = useSessionStore();
const message = useMessage();

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

const configKind = computed<ParserKind>({
  get: () => currentConfig.value.kind,
  set: (kind) => {
    if (kind === currentConfig.value.kind) return;
    setConfig(configForKind(currentConfig.value, kind), null);
  },
});

function applyPreset(id: string | null) {
  if (!id) return;
  const preset = PARSER_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  setConfig(preset.config, id);
}

const delimiterHex = computed({
  get: () => formatDelimiterHex(delimiterConfig(currentConfig.value).delimiter),
  set: (value: string) => {
    setConfig(delimiterConfigFromHex(currentConfig.value, value), null);
  },
});
const includeDelimiter = computed({
  get: () => delimiterConfig(currentConfig.value).includeDelimiter,
  set: (value: boolean) => {
    setConfig({ ...delimiterConfig(currentConfig.value), includeDelimiter: value }, null);
  },
});
const fixedSize = computed({
  get: () => fixedConfig(currentConfig.value).frameSize,
  set: (value: number | null) => {
    setConfig({ kind: 'fixed', frameSize: positiveInteger(value) }, null);
  },
});
const lenOffset = computed({
  get: () => lengthConfig(currentConfig.value).lengthOffset,
  set: (value: number | null) => {
    setConfig(
      { ...lengthConfig(currentConfig.value), lengthOffset: nonNegativeInteger(value) },
      null,
    );
  },
});
const lenSize = computed({
  get: () => lengthConfig(currentConfig.value).lengthSize,
  set: (value: 1 | 2 | 4) => {
    setConfig({ ...lengthConfig(currentConfig.value), lengthSize: value }, null);
  },
});
const lenBigEndian = computed({
  get: () => lengthConfig(currentConfig.value).bigEndian,
  set: (value: boolean) => {
    setConfig({ ...lengthConfig(currentConfig.value), bigEndian: value }, null);
  },
});
const lenAdjust = computed({
  get: () => lengthConfig(currentConfig.value).lengthAdjust,
  set: (value: number | null) => {
    setConfig(
      { ...lengthConfig(currentConfig.value), lengthAdjust: nonNegativeInteger(value) },
      null,
    );
  },
});

function setConfig(config: ParserConfig, selectedPresetId: string | null) {
  sessionStore.setParserState(props.sessionId, config, selectedPresetId);
}

const parsedFrames = ref<DisplayParsedFrame[]>([]);
const selectedFrame = ref<DisplayParsedFrame | null>(null);
const searchTerm = ref('');
const parserCollector = new ParserFrameCollector(currentConfig.value);
// Throughput tracking: bytes parsed and the timestamp window they arrived in.
const throughputBps = ref(0);

function syncParsedFrames() {
  const result = parserCollector.sync(props.frames, currentConfig.value);
  parsedFrames.value = result.frames;
  throughputBps.value = result.throughputBps;
  if (result.reset) selectedFrame.value = null;
}

watch(
  () => [props.framesVersion, props.frames.length, parserConfigKey(currentConfig.value)] as const,
  syncParsedFrames,
  {
    immediate: true,
  },
);

// Search filter: case-insensitive substring against decoded frame text.
const filteredFrames = computed(() => filterParsedFrames(parsedFrames.value, searchTerm.value));

const renderedFrameWindow = computed(() =>
  renderedParsedFrameWindow(filteredFrames.value, MAX_RENDERED_PARSED_FRAMES),
);
const renderedStartIndex = computed(() => renderedFrameWindow.value.startIndex);
const renderedFilteredFrames = computed(() => renderedFrameWindow.value.frames);

// Aggregate stats over the full parsed set (not the filtered view).
const stats = computed(() => parsedFrameStats(parsedFrames.value));
const totalBytes = computed(() => stats.value.totalBytes);
const largestFrame = computed(() => stats.value.largestFrame);

const detailDump = computed(() =>
  selectedFrame.value ? hexDump(selectedFrame.value.data, 16) : [],
);

function truncateHex(s: string, max: number): string {
  return truncateHexPreview(s, max);
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
    await navigator.clipboard.writeText(frameAsciiText(f));
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
</style>
