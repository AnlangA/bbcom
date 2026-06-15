<template>
  <div
    class="packet-row packet-item"
    :class="[directionClass, highlightClass]"
    :style="{ gridTemplateColumns: columns }"
    :title="highlightLabel ? `${highlightLabel}: ${formatted}` : undefined"
    @contextmenu.prevent="onContextMenu"
  >
    <span class="col-dir">
      <span class="direction-badge" :class="directionClass">{{ frame.direction }}</span>
    </span>
    <span v-if="showTimestamp" class="col-time">{{ timestamp }}</span>
    <span
      v-if="useHtml"
      class="col-data data ansi-data"
      v-html="formatted"
      :title="formatted.length > 240 ? formatted.slice(0, 240) + '…' : undefined"
    ></span>
    <span
      v-else
      class="col-data data"
      :title="formatted.length > 240 ? formatted.slice(0, 240) + '…' : undefined"
      >{{ formatted }}</span
    >
    <span class="col-mode">{{ displayLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DataFrame } from '../../types';

const props = defineProps<{
  frame: DataFrame;
  formatted: string;
  timestamp: string;
  showTimestamp: boolean;
  columns: string;
  displayLabel: string;
  useHtml: boolean;
  highlightClass?: string | null;
  highlightLabel?: string | null;
}>();

const emit = defineEmits<{
  (e: 'contextmenu', ev: MouseEvent, frame: DataFrame): void;
}>();

const directionClass = computed(() => props.frame.direction.toLowerCase());

function onContextMenu(ev: MouseEvent) {
  emit('contextmenu', ev, props.frame);
}
</script>

<style scoped>
/*
 * Instrument-grade packet row. Pure presentational + v-memo-friendly: the
 * parent pre-formats `formatted`/`timestamp` (shared LRU cache) and passes
 * stable string props, so unchanged rows skip the v-html diff entirely.
 */
.packet-row {
  display: grid;
  gap: 8px;
  padding: 3px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 22px;
  align-items: center;
}

.packet-item {
  border-bottom: 1px solid var(--border-subtle);
  transition:
    background-color var(--transition-fast),
    border-left-color var(--transition-fast);
  cursor: context-menu;
  overflow: hidden;
}

.packet-item:hover {
  background-color: var(--bg-hover);
}

.packet-item.tx {
  border-left: 2px solid var(--accent-green);
  padding-left: 8px;
  background-image: linear-gradient(90deg, var(--accent-green-subtle), transparent 220px);
}

.packet-item.tx:hover {
  border-left-color: var(--accent-green-hover);
}

.packet-item.rx {
  border-left: 2px solid var(--accent-blue);
  padding-left: 8px;
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

.col-dir {
  text-align: center;
}

.direction-badge {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 18px;
  border-radius: var(--radius-full);
  font-weight: var(--font-weight-bold);
  font-size: 10px;
  letter-spacing: 0.5px;
  line-height: 18px;
}

.packet-item.tx .direction-badge {
  color: #07120e;
  background: var(--accent-green);
  box-shadow: 0 0 7px -2px var(--accent-green);
}

.packet-item.rx .direction-badge {
  color: #06111f;
  background: var(--accent-blue);
  box-shadow: 0 0 7px -2px var(--accent-blue);
}

.col-time {
  color: var(--text-muted);
  white-space: nowrap;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.col-data {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.3px;
  font-variant-numeric: tabular-nums;
}

.ansi-data {
  white-space: nowrap;
  word-break: normal;
  font-variant-numeric: normal;
}

.col-mode {
  text-align: center;
  color: var(--text-dim);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0;
}
</style>
