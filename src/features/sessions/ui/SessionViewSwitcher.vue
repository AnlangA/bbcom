<template>
  <div class="view-switcher" role="group" :aria-label="t('toolbar.viewSwitch')">
    <button
      v-for="view in views"
      :key="view.mode"
      type="button"
      class="view-button"
      :class="{ active: modelValue === view.mode }"
      :title="view.title"
      :aria-label="view.label"
      :aria-pressed="modelValue === view.mode"
      @click="$emit('update:modelValue', view.mode)"
    >
      <component :is="view.icon" class="icon-sm" aria-hidden="true" />
      <span>{{ view.shortLabel }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Binary, Cpu, Keyboard, LineChart, MemoryStick, TerminalSquare } from '@lucide/vue';
import { t } from '@/lib/i18n';
import type { SessionViewMode } from './session-view-mode';

defineProps<{ modelValue: SessionViewMode }>();
defineEmits<{ 'update:modelValue': [value: SessionViewMode] }>();

const views = computed(() => [
  {
    mode: 'terminal' as const,
    icon: TerminalSquare,
    label: t('toolbar.terminal'),
    shortLabel: t('toolbar.terminal.short'),
    title: t('toolbar.terminal'),
  },
  {
    mode: 'waveform' as const,
    icon: LineChart,
    label: t('toolbar.waveform'),
    shortLabel: t('toolbar.waveform.short'),
    title: t('toolbar.waveform.title'),
  },
  {
    mode: 'parser' as const,
    icon: Binary,
    label: t('toolbar.parser'),
    shortLabel: t('toolbar.parser.short'),
    title: t('toolbar.parser.title'),
  },
  {
    mode: 'modbus' as const,
    icon: Cpu,
    label: t('modbus.title'),
    shortLabel: 'Modbus',
    title: t('modbus.title'),
  },
  {
    mode: 'shell' as const,
    icon: Keyboard,
    label: t('toolbar.shell'),
    shortLabel: t('toolbar.shell.short'),
    title: t('toolbar.shell.title'),
  },
  {
    mode: 'mcumgr' as const,
    icon: MemoryStick,
    label: t('toolbar.mcumgr'),
    shortLabel: t('toolbar.mcumgr'),
    title: t('toolbar.mcumgr.title'),
  },
]);
</script>

<style scoped>
.view-switcher {
  display: flex;
  align-items: center;
  gap: var(--space-2xs);
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  padding: var(--space-2xs);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  scrollbar-width: thin;
}

.view-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  flex: 1 0 auto;
  min-height: var(--control-h-md);
  padding: 0 var(--space-sm);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  font-family: inherit;
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.view-button:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.view-button.active {
  color: var(--color-primary);
  border-color: var(--border-subtle);
  background: var(--bg-secondary);
  box-shadow: var(--shadow-sm);
}

.view-button:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}
</style>
