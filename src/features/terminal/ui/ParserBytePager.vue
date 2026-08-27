<template>
  <div class="byte-pager" :aria-label="t('parser.inspector.bytePager')">
    <button
      type="button"
      :aria-label="t('parser.inspector.previousPage')"
      :disabled="page <= 0"
      @click="$emit('update:page', page - 1)"
    >
      <ChevronLeft class="icon-sm" />
    </button>
    <span>
      {{ t('parser.inspector.bytePage', { start, end: displayEnd, total }) }}
    </span>
    <button
      type="button"
      :aria-label="t('parser.inspector.nextPage')"
      :disabled="page >= pageCount - 1"
      @click="$emit('update:page', page + 1)"
    >
      <ChevronRight class="icon-sm" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { t } from '@/lib/i18n';

const props = defineProps<{
  page: number;
  pageCount: number;
  start: number;
  end: number;
  total: number;
}>();

defineEmits<{
  'update:page': [number];
}>();

const displayEnd = computed(() => (props.total === 0 ? 0 : Math.max(props.start, props.end - 1)));
</script>

<style scoped>
.byte-pager {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-right: auto;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.byte-pager button {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-muted);
  cursor: pointer;
}

.byte-pager button:hover:not(:disabled),
.byte-pager button:focus-visible {
  color: var(--text-primary);
  border-color: var(--color-primary-muted);
  outline: none;
}

.byte-pager button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
