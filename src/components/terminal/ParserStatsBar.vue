<!--
  Parser stats + search bar: live frame count, total bytes, throughput, largest
  frame, and the filter search box. Extracted from ParserPanel.
  Presentational; search is two-way bound via v-model:search-term.
-->
<template>
  <div class="pp-stats">
    <span class="stat">
      <span class="stat-label">{{ t('session.stats.frames') }}</span>
      <span class="stat-val">{{ frameCount }}</span>
    </span>
    <span class="stat">
      <span class="stat-label">{{ t('common.bytes') }}</span>
      <span class="stat-val">{{ t('parser.totalBytes', { bytes: formatBytes(totalBytes) }) }}</span>
    </span>
    <span v-if="droppedFrames > 0 || droppedBytes > 0" class="stat parser-dropped-stat">
      <span class="stat-label">{{ t('status.dropped') }}</span>
      <span class="stat-val">{{
        t('parser.dropped', { frames: droppedFrames, bytes: formatBytes(droppedBytes) })
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
        :value="searchTerm"
        size="tiny"
        :placeholder="t('parser.search')"
        :aria-label="t('parser.search')"
        clearable
        style="width: 180px"
        @update:value="(v) => $emit('update:searchTerm', v ?? '')"
      >
        <template #prefix>
          <Search class="icon-sm search-icon" />
        </template>
      </n-input>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NInput } from 'naive-ui';
import { Search } from '@lucide/vue';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';

defineProps<{
  frameCount: number;
  totalBytes: number;
  droppedFrames: number;
  droppedBytes: number;
  throughputBps: number;
  largestFrame: number;
  searchTerm: string;
}>();

defineEmits<{
  'update:searchTerm': [string];
}>();
</script>

<style scoped>
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
</style>
