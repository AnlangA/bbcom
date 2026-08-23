<template>
  <div
    class="packet-row packet-item"
    :class="[
      directionClass,
      highlightClass,
      { selected, striped, 'wrap-enabled': softWrap || preserveLineBreaks },
    ]"
    :style="{ gridTemplateColumns: columns }"
    :title="highlightLabel ? `${highlightLabel}: ${formatted}` : undefined"
    @contextmenu.prevent="onContextMenu"
  >
    <span class="col-dir">
      <span class="direction-badge" :class="directionClass">
        <span class="dir-arrow" aria-hidden="true">{{ directionArrow }}</span>
        {{ frame.direction }}
      </span>
    </span>
    <span v-if="showTimestamp" class="col-time">{{ timestamp }}</span>
    <span v-if="useHtml" class="col-data data ansi-data" :class="dataClasses" :title="dataTitle">
      <span v-if="omittedLabel" class="data-omitted">{{ omittedLabel }}</span>
      <span v-if="preserveLineBreaks && !plainLineBreaks" v-html="formattedHtml"></span>
      <span v-else v-html="formatted"></span>
    </span>
    <span v-else class="col-data data" :class="dataClasses" :title="dataTitle">
      <span v-if="omittedLabel" class="data-omitted">{{ omittedLabel }}</span>
      <template v-if="preserveLineBreaks">
        <template v-if="plainLineBreaks">{{ formatted }}</template>
        <template v-else v-for="(line, index) in formattedLines" :key="index">
          <br v-if="index > 0" />{{ line }}
        </template>
      </template>
      <template v-else>{{ formatted }}</template>
    </span>
    <span class="col-mode">{{ displayLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DataFrame } from '@/types';
import { CAPTURE_ORIGIN_I18N, captureFrameIdentity } from '@/lib/capture-stream';
import { formatBytes } from '@/lib/format';
import { t } from '@/lib/i18n';
import { splitLogDisplayLines } from '@/lib/log-line-breaks';

const props = withDefaults(
  defineProps<{
    frame: DataFrame;
    formatted: string;
    timestamp: string;
    showTimestamp: boolean;
    columns: string;
    displayLabel: string;
    useHtml: boolean;
    preserveLineBreaks?: boolean;
    plainLineBreaks?: boolean;
    softWrap?: boolean;
    hexMode?: boolean;
    highlightClass?: string | null;
    highlightLabel?: string | null;
    selected?: boolean;
    striped?: boolean;
  }>(),
  {
    preserveLineBreaks: false,
    plainLineBreaks: false,
    softWrap: false,
    hexMode: false,
    selected: false,
    striped: false,
  },
);

const emit = defineEmits<{
  (e: 'contextmenu', ev: MouseEvent, frame: DataFrame): void;
}>();

const directionClass = computed(() => props.frame.direction.toLowerCase());
const directionArrow = computed(() => (props.frame.direction === 'TX' ? '↑' : '↓'));
const omittedLabel = computed(() =>
  props.frame.omittedBytes ? `… ${formatBytes(props.frame.omittedBytes)} omitted · ` : '',
);
const captureMeta = computed(() => {
  const identity = captureFrameIdentity(props.frame);
  if (!identity) return undefined;
  return `#${identity.captureSeq} · ${t(CAPTURE_ORIGIN_I18N[identity.origin])}`;
});
const dataTitle = computed(() => {
  const preview = props.formatted.length > 240 ? props.formatted.slice(0, 240) + '…' : undefined;
  const body = !props.frame.omittedBytes
    ? preview
    : `${props.frame.omittedBytes.toLocaleString()} bytes omitted; ` + (preview ?? props.formatted);
  const meta = captureMeta.value;
  return meta ? `${meta}\n${body}` : body;
});
const formattedLines = computed(() => splitLogDisplayLines(props.formatted));
const formattedHtml = computed(() =>
  props.preserveLineBreaks && !props.plainLineBreaks
    ? formattedLines.value.join('<br>')
    : props.formatted,
);
const dataClasses = computed(() => ({
  'preserve-line-breaks': props.preserveLineBreaks,
  'soft-wrap': props.softWrap,
  'hex-wrap': props.hexMode,
}));

function onContextMenu(ev: MouseEvent) {
  emit('contextmenu', ev, props.frame);
}
</script>

<style scoped>
.packet-item {
  border-bottom: 1px solid var(--border-subtle);
  transition:
    background-color var(--transition-fast),
    border-left-color var(--transition-fast);
  cursor: context-menu;
  overflow: hidden;
}

.packet-item.wrap-enabled {
  align-items: start;
}

.packet-item.striped {
  background-color: var(--surface-lift);
}

.packet-item:hover {
  background-color: var(--bg-hover);
}

.packet-item.tx {
  border-left: 2px solid var(--accent-green);
  padding-left: var(--space-sm);
  background-image: linear-gradient(90deg, var(--accent-green-subtle), transparent 220px);
}

.packet-item.tx:hover {
  border-left-color: var(--accent-green-hover);
}

.packet-item.rx {
  border-left: 2px solid var(--accent-blue);
  padding-left: var(--space-sm);
  background-image: linear-gradient(90deg, var(--accent-blue-subtle), transparent 220px);
}

.packet-item.rx:hover {
  border-left-color: var(--accent-blue-hover);
}

.packet-item.highlight-amber {
  border-color: var(--accent-amber-border);
  box-shadow: inset 0 0 0 1px var(--accent-amber-border);
  background-image: linear-gradient(90deg, var(--accent-amber-subtle), transparent 260px);
}

.packet-item.highlight-red {
  border-color: var(--accent-red-border);
  box-shadow: inset 0 0 0 1px var(--accent-red-border);
  background-image: linear-gradient(90deg, var(--accent-red-subtle), transparent 260px);
}

.packet-item.highlight-blue {
  border-color: var(--accent-blue);
  box-shadow: inset 0 0 0 1px var(--accent-blue-subtle);
  background-image: linear-gradient(90deg, var(--accent-blue-subtle), transparent 260px);
}

.packet-item.highlight-green {
  border-color: var(--accent-green);
  box-shadow: inset 0 0 0 1px var(--accent-green-subtle);
  background-image: linear-gradient(90deg, var(--accent-green-subtle), transparent 260px);
}

.packet-item.highlight-violet {
  border-color: var(--accent-violet);
  box-shadow: inset 0 0 0 1px var(--accent-violet-subtle);
  background-image: linear-gradient(90deg, var(--accent-violet-subtle), transparent 260px);
}

.packet-item.selected {
  background-color: var(--bg-selected);
  outline: 1px solid var(--border-color);
  outline-offset: -1px;
}

.direction-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2xs);
  min-width: 28px;
  height: 18px;
  padding: 0 var(--space-xs);
  border-radius: var(--radius-full);
  font-weight: var(--font-weight-bold);
  font-size: var(--font-size-xs);
  letter-spacing: 0.5px;
  line-height: 18px;
}

.dir-arrow {
  font-size: var(--font-size-2xs);
  line-height: 1;
}

.packet-item.tx .direction-badge {
  color: var(--text-on-bright-accent);
  background: var(--accent-green);
  box-shadow: 0 0 7px -2px var(--accent-green);
}

.packet-item.rx .direction-badge {
  color: var(--text-on-bright-accent);
  background: var(--accent-blue);
  box-shadow: 0 0 7px -2px var(--accent-blue);
}

.ansi-data {
  font-variant-numeric: normal;
}

.data-omitted {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  letter-spacing: 0;
}
</style>
