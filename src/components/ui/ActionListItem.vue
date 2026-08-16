<template>
  <div class="action-list-item" :class="{ 'action-list-item--danger': danger }">
    <div class="action-list-item__main">
      <p class="action-list-item__title">{{ title }}</p>
      <p v-if="description" class="action-list-item__description">{{ description }}</p>
      <p v-if="meta" class="action-list-item__meta">{{ meta }}</p>
    </div>
    <div class="action-list-item__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * One row shape for macro/trigger/highlight/source lists: title, optional
 * description and metadata, and a right-aligned action cluster. Business
 * validation and stores stay with each feature.
 */
defineProps<{
  title: string;
  description?: string;
  meta?: string;
  danger?: boolean;
}>();
</script>

<style scoped>
.action-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
}

.action-list-item--danger .action-list-item__title {
  color: var(--color-error);
}

.action-list-item__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.action-list-item__title {
  margin: 0;
  font-size: var(--font-size-base);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-list-item__description {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.action-list-item__meta {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-dim);
}

.action-list-item__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
</style>
