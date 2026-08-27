<template>
  <section class="pp-tools" :aria-label="t('parser.filters')">
    <div class="pp-stats" aria-live="polite">
      <span class="stat">
        <span class="stat-label">{{ t('session.stats.frames') }}</span>
        <span class="stat-val">{{ visibleCount }} / {{ frameCount }}</span>
      </span>
      <span class="stat">
        <span class="stat-label">{{ t('common.bytes') }}</span>
        <span class="stat-val">{{
          t('parser.totalBytes', { bytes: formatBytes(totalBytes) })
        }}</span>
      </span>
      <span v-if="droppedFrames > 0 || droppedBytes > 0" class="stat parser-dropped-stat">
        <span class="stat-label">{{ t('parser.retentionEvicted') }}</span>
        <span class="stat-val">{{
          t('parser.dropped', { frames: droppedFrames, bytes: formatBytes(droppedBytes) })
        }}</span>
      </span>
      <span v-if="throughputBps > 0" class="stat optional-stat">
        <span class="stat-label">{{ t('status.rate') }}</span>
        <span class="stat-val">{{
          t('parser.throughput', { rate: formatBytes(throughputBps) })
        }}</span>
      </span>
      <span v-if="largestFrame > 0" class="stat optional-stat">
        <span class="stat-label">{{ t('parser.largestFrame') }}</span>
        <span class="stat-val">{{ t('parser.largest', { bytes: largestFrame }) }}</span>
      </span>
      <n-checkbox
        class="follow-toggle"
        size="small"
        :checked="autoFollow"
        @update:checked="(value) => $emit('update:autoFollow', value)"
      >
        {{ t('parser.autoFollow') }}
      </n-checkbox>
    </div>

    <div class="pp-filters">
      <n-button-group size="tiny" :aria-label="t('parser.filter.direction')">
        <n-button
          v-for="option in directionOptions"
          :key="option.value"
          :type="directionFilter === option.value ? 'primary' : 'default'"
          :aria-pressed="directionFilter === option.value"
          @click="$emit('update:directionFilter', option.value)"
        >
          {{ option.label }}
        </n-button>
      </n-button-group>

      <AppSelect
        class="filter-select"
        :value="statusFilter"
        :options="statusOptions"
        :aria-label="t('parser.filter.status')"
        size="tiny"
        @update:value="(value) => $emit('update:statusFilter', value)"
      />
      <AppSelect
        v-if="smpMode"
        class="filter-select transaction-filter"
        :value="transactionFilter"
        :options="transactionOptions"
        :aria-label="t('parser.filter.transaction')"
        size="tiny"
        @update:value="(value) => $emit('update:transactionFilter', value)"
      />

      <n-input
        v-if="smpMode"
        class="field-filter"
        :value="groupFilter"
        size="tiny"
        :placeholder="t('parser.filter.group')"
        :aria-label="t('parser.filter.group')"
        clearable
        @update:value="(value) => $emit('update:groupFilter', value ?? '')"
      />
      <n-input
        v-if="smpMode"
        class="field-filter"
        :value="commandFilter"
        size="tiny"
        :placeholder="t('parser.filter.command')"
        :aria-label="t('parser.filter.command')"
        clearable
        @update:value="(value) => $emit('update:commandFilter', value ?? '')"
      />
      <n-input
        v-if="smpMode"
        class="sequence-filter"
        :value="sequenceFilter"
        size="tiny"
        :placeholder="t('parser.filter.sequence')"
        :aria-label="t('parser.filter.sequence')"
        clearable
        @update:value="(value) => $emit('update:sequenceFilter', value ?? '')"
      />

      <n-input
        class="pp-search"
        :value="searchTerm"
        :maxlength="512"
        size="tiny"
        :placeholder="t('parser.search')"
        :aria-label="t('parser.search')"
        clearable
        @update:value="(value) => $emit('update:searchTerm', value ?? '')"
      >
        <template #prefix>
          <Search class="icon-sm search-icon" />
        </template>
      </n-input>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NButtonGroup, NCheckbox, NInput } from 'naive-ui';
import { Search } from '@lucide/vue';
import AppSelect from '@/design-system/AppSelect.vue';
import { formatBytes } from '@/lib/format';
import { t } from '@/lib/i18n';

defineProps<{
  smpMode: boolean;
  frameCount: number;
  visibleCount: number;
  totalBytes: number;
  droppedFrames: number;
  droppedBytes: number;
  throughputBps: number;
  largestFrame: number;
  searchTerm: string;
  directionFilter: string;
  statusFilter: string;
  transactionFilter: string;
  groupFilter: string;
  commandFilter: string;
  sequenceFilter: string;
  autoFollow: boolean;
}>();

defineEmits<{
  'update:searchTerm': [string];
  'update:directionFilter': [string];
  'update:statusFilter': [string];
  'update:transactionFilter': [string];
  'update:groupFilter': [string];
  'update:commandFilter': [string];
  'update:sequenceFilter': [string];
  'update:autoFollow': [boolean];
}>();

const directionOptions = computed(() => [
  { label: t('parser.filter.all'), value: 'all' },
  { label: 'TX', value: 'TX' },
  { label: 'RX', value: 'RX' },
]);

const statusOptions = computed(() => [
  { label: t('parser.filter.statusAll'), value: 'all' },
  { label: t('parser.status.ok'), value: 'ok' },
  { label: t('parser.status.warning'), value: 'warning' },
  { label: t('parser.status.error'), value: 'error' },
  { label: t('parser.status.pending'), value: 'pending' },
]);

const transactionOptions = computed(() => [
  { label: t('parser.filter.transactionAll'), value: 'all' },
  { label: t('parser.transaction.request'), value: 'request' },
  { label: t('parser.transaction.response'), value: 'response' },
  { label: t('parser.transaction.unmatched'), value: 'unmatched' },
]);
</script>

<style scoped>
.pp-tools {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
}

.pp-stats,
.pp-filters {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 4px 10px;
}

.pp-stats {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.pp-filters {
  border-top: 1px solid var(--border-subtle);
  flex-wrap: wrap;
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.stat-label {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  text-transform: uppercase;
}

.stat-val {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.follow-toggle {
  margin-left: auto;
  font-family: var(--font-sans);
}

.filter-select {
  width: 112px;
}

.transaction-filter {
  width: 128px;
}

.field-filter {
  width: 116px;
}

.sequence-filter {
  width: 84px;
}

.pp-search {
  width: min(220px, 100%);
  margin-left: auto;
}

.search-icon {
  color: var(--text-dim);
}

@container parser-panel (max-width: 720px) {
  .optional-stat {
    display: none;
  }

  .pp-filters {
    gap: 6px;
  }

  .pp-search {
    order: -1;
    width: 100%;
    margin-left: 0;
  }
}
</style>
