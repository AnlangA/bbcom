<template>
  <section class="settings-section" :aria-labelledby="headingId">
    <h3 :id="headingId" class="settings-section__title">{{ title }}</h3>
    <p v-if="description" class="settings-section__description">{{ description }}</p>
    <div class="settings-section__body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import { useId } from 'vue';

/** Settings page building block: titled, described, labelled section. */
defineProps<{
  title: string;
  description?: string;
}>();

const headingId = `settings-section-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
</script>

<style scoped>
.settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.settings-section__title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--text-primary);
}

.settings-section__description {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.settings-section__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
