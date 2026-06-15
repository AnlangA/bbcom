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
          style="width: 130px"
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
      <span class="pp-count">{{ t('parser.frameCount', { count: parsedFrames.length }) }}</span>
      <button class="pp-close" type="button" :title="t('parser.close')" @click="emit('close')">
        <X class="icon-sm" />
      </button>
    </div>
    <div class="parser-body scrollbar-thin">
      <div v-if="parsedFrames.length === 0" class="pp-empty">
        {{ t('parser.empty') }}
      </div>
      <div
        v-for="(f, i) in renderedParsedFrames"
        :key="`${renderedStartIndex + i}:${f.offset}:${f.data.length}`"
        class="pp-frame"
        :title="t('parser.offsetTitle', { offset: f.offset })"
        @click="copyFrame(f)"
      >
        <span class="pp-idx">#{{ renderedStartIndex + i + 1 }}</span>
        <span class="pp-hex">{{ truncateHex(formatHex(f.data), 48) }}</span>
        <span class="pp-len">{{ f.data.length }}B</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NCheckbox, NInput, NInputNumber, NSelect, useMessage } from 'naive-ui';
import { Binary, X } from 'lucide-vue-next';
import { ProtocolParser, parseDelimiterHex, type ParserConfig } from '../../lib/protocol-parser';
import { PARSER_PRESETS } from '../../lib/parser-presets';
import { formatHex } from '../../lib/format';
import { t } from '../../lib/i18n';
import type { DataFrame } from '../../types';
import { useSessionStore } from '../../stores/sessions';

const props = defineProps<{
  sessionId: string;
  frames: DataFrame[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const sessionStore = useSessionStore();
const message = useMessage();
const MAX_RENDERED_PARSED_FRAMES = 500;

interface DisplayParsedFrame {
  data: Uint8Array;
  offset: number;
}

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
let parser = new ProtocolParser(currentConfig.value);
let consumedFrameCount = 0;
let runningOffset = 0;
let lastConfigKey = '';

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
  consumedFrameCount = 0;
  runningOffset = 0;
}

function ingestFrames(startIndex: number) {
  const next = parsedFrames.value;
  const frames = props.frames;
  for (let i = startIndex; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame.direction !== 'RX') {
      // Non-RX frames don't advance the parsed byte stream offset.
      continue;
    }
    const parsed = parser.feed(frame.data);
    for (const p of parsed) {
      next.push({ data: p.data, offset: runningOffset + p.offset });
    }
    runningOffset += frame.data.length;
  }
  consumedFrameCount = frames.length;
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

const renderedStartIndex = computed(() =>
  Math.max(0, parsedFrames.value.length - MAX_RENDERED_PARSED_FRAMES),
);
const renderedParsedFrames = computed(() =>
  parsedFrames.value.length <= MAX_RENDERED_PARSED_FRAMES
    ? parsedFrames.value
    : parsedFrames.value.slice(renderedStartIndex.value),
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
</script>

<style scoped>
.parser-panel {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  height: 200px;
  flex-shrink: 0;
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

.pp-count {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
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

.parser-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
}

.pp-empty {
  color: var(--text-dim);
  font-size: 11px;
  padding: 12px;
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
  cursor: pointer;
  transition: background var(--transition-fast);
}

.pp-frame:hover {
  background: var(--bg-hover);
}

.pp-idx {
  color: var(--text-dim);
  font-size: 10px;
  min-width: 32px;
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
</style>
