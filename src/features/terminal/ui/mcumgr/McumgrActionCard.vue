<template>
  <article class="mc-card" :class="`mc-card--${tone}`">
    <header class="mc-card-heading">
      <h3>{{ title }}</h3>
      <p v-if="description">{{ description }}</p>
    </header>
    <div class="mc-card-content"><slot /></div>
    <footer v-if="$slots.actions" class="mc-card-actions"><slot name="actions" /></footer>
  </article>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    description?: string;
    tone?: 'default' | 'accent' | 'danger';
  }>(),
  { tone: 'default' },
);
</script>

<style scoped>
.mc-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-lg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background: var(--bg-primary);
}
.mc-card--accent {
  border-color: var(--color-primary-muted);
  background:
    linear-gradient(120deg, var(--color-primary-subtle), transparent 80%), var(--bg-primary);
}
.mc-card--danger {
  border-color: var(--accent-red-border);
}
.mc-card-heading {
  display: grid;
  gap: var(--space-xs);
}
h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
}
.mc-card--danger h3 {
  color: var(--color-error);
}
p {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-data);
  line-height: var(--line-height-relaxed);
}
.mc-card-content {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}
.mc-card-content:empty {
  display: none;
}
.mc-card-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-sm);
  margin-top: auto;
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-subtle);
}
</style>
