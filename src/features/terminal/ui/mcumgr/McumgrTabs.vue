<template>
  <div class="mc-tabs" role="tablist" :aria-label="t('mcumgr.navigation')">
    <button
      v-for="tab in tabDefs"
      :id="`${idPrefix}-tab-${tab.id}`"
      :key="tab.id"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.id"
      :aria-controls="`${idPrefix}-panel-${tab.id}`"
      :tabindex="modelValue === tab.id ? 0 : -1"
      :class="{ active: modelValue === tab.id }"
      @click="emit('update:modelValue', tab.id)"
      @keydown="onKeydown($event, tab.id)"
    >
      <component :is="tab.icon" :size="15" aria-hidden="true" />
      <span>{{ t(`mcumgr.tab.${tab.id}`) }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { nextTick } from 'vue';
import { t } from '@/lib/i18n';
import { tabDefs, type McumgrTab } from './use-mcumgr-panel';

defineProps<{ modelValue: McumgrTab; idPrefix: string }>();
const emit = defineEmits<{ 'update:modelValue': [tab: McumgrTab] }>();

async function onKeydown(event: KeyboardEvent, current: McumgrTab) {
  const index = tabDefs.findIndex((tab) => tab.id === current);
  let target: number;
  if (event.key === 'ArrowRight') target = (index + 1) % tabDefs.length;
  else if (event.key === 'ArrowLeft') target = (index - 1 + tabDefs.length) % tabDefs.length;
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = tabDefs.length - 1;
  else return;
  event.preventDefault();
  const tablist = (event.currentTarget as HTMLElement).parentElement;
  emit('update:modelValue', tabDefs[target].id);
  await nextTick();
  const button = tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target];
  button?.focus();
  button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}
</script>

<style scoped>
.mc-tabs {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  min-width: 0;
  gap: var(--space-xs);
  padding: 0 var(--space-lg) var(--space-md);
  overflow-x: auto;
  scrollbar-width: thin;
}
button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  padding: 0 13px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-muted);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-data);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  cursor: pointer;
}
button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
button.active {
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-muted);
  color: var(--color-primary);
}
button:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}
</style>
