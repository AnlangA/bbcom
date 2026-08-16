<template>
  <div class="empty-state">
    <div v-if="$slots.icon" class="empty-state__icon" aria-hidden="true">
      <slot name="icon" />
    </div>
    <p class="empty-state__title">{{ title }}</p>
    <p v-if="description" class="empty-state__description">{{ description }}</p>
    <div v-if="$slots.action" class="empty-state__action">
      <slot name="action" />
    </div>
  </div>
</template>

<script setup lang="ts">
/** One shared empty/zero-data presentation for every list and panel. */
defineProps<{
  title: string;
  description?: string;
}>();
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 32px 16px;
  text-align: center;
}

.empty-state__icon {
  color: var(--text-dim);
  margin-bottom: 4px;
}

.empty-state__title {
  margin: 0;
  font-size: var(--font-size-base);
  color: var(--text-secondary);
}

.empty-state__description {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  max-width: 360px;
}

.empty-state__action {
  margin-top: 10px;
}
</style>
