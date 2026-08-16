<template>
  <div
    class="packet-row packet-item"
    :class="[directionClass, highlightClass, { selected, striped }]"
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
    <span
      v-if="useHtml"
      class="col-data data ansi-data"
      :class="{ 'preserve-line-breaks': preserveLineBreaks }"
      :title="dataTitle"
    >
      <span v-if="omittedLabel" class="data-omitted">{{ omittedLabel }}</span>
      <span v-html="formattedHtml"></span>
    </span>
    <span
      v-else
      class="col-data data"
      :class="{ 'preserve-line-breaks': preserveLineBreaks }"
      :title="dataTitle"
    >
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
import type { DataFrame } from '../../types';
import { formatBytes } from '../../lib/format';
import { splitLogDisplayLines } from '../../lib/log-line-breaks';

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
    /** Split on raw '\n' only, skipping the log-record prefix heuristic.
     * HEXASCII dumps need this: their ASCII gutter can contain text like
     * "I: " that the heuristic would otherwise re-flow onto new lines. */
    plainLineBreaks?: boolean;
    highlightClass?: string | null;
    highlightLabel?: string | null;
    selected?: boolean;
    striped?: boolean;
  }>(),
  { preserveLineBreaks: false, plainLineBreaks: false, selected: false, striped: false },
);

const emit = defineEmits<{
  (e: 'contextmenu', ev: MouseEvent, frame: DataFrame): void;
}>();

const directionClass = computed(() => props.frame.direction.toLowerCase());
// TX leaves the host (up), RX arrives at the host (down). A glyph (not an SVG
// icon) keeps the packet list inside the bundle-size gate.
const directionArrow = computed(() => (props.frame.direction === 'TX' ? '↑' : '↓'));
const omittedLabel = computed(() =>
  props.frame.omittedBytes ? `… ${formatBytes(props.frame.omittedBytes)} omitted · ` : '',
);
const dataTitle = computed(() => {
  const preview = props.formatted.length > 240 ? props.formatted.slice(0, 240) + '…' : undefined;
  if (!props.frame.omittedBytes) return preview;
  const omitted = `${props.frame.omittedBytes.toLocaleString()} bytes omitted; `;
  return omitted + (preview ?? props.formatted);
});
const formattedLines = computed(() => splitLogDisplayLines(props.formatted));
const formattedHtml = computed(() =>
  props.preserveLineBreaks ? formattedLines.value.join('<br>') : props.formatted,
);

function onContextMenu(ev: MouseEvent) {
  emit('contextmenu', ev, props.frame);
}
</script>

<style scoped>
/*
 * Instrument-grade packet row. Pure presentational + v-memo-friendly: the
 * parent pre-formats `formatted`/`timestamp` (shared LRU cache) and passes
 * stable string props, so unchanged rows skip the v-html diff entirely.
 * The .packet-row grid and .col-* column rules live in
 * styles/packet-columns.css, shared with DataPacketList.vue's header.
 */
.packet-item {
  border-bottom: 1px solid var(--border-subtle);
  transition:
    background-color var(--transition-fast),
    border-left-color var(--transition-fast);
  cursor: context-menu;
  overflow: hidden;
}

/* Zebra tint must sit below hover/selection so those states always win. */
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

/* Keyboard/context-menu selection. An inset outline (not box-shadow) keeps the
   highlight rules' inset shadows intact when both states apply. */
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

/* Badge text stays dark in both themes: the TX/RX accent hues are
   theme-invariant saturated colors, so a fixed dark ink keeps contrast. */
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
  white-space: nowrap;
  word-break: normal;
  font-variant-numeric: normal;
}

.col-data.preserve-line-breaks {
  white-space: pre;
  text-overflow: clip;
}

.data-omitted {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  letter-spacing: 0;
}
</style>
