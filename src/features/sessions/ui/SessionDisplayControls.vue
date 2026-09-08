<template>
  <div class="display-controls" role="group" :aria-label="t('toolbar.functionSettings')">
    <button
      v-for="control in controls"
      :key="control.action"
      type="button"
      class="display-toggle"
      :class="{ active: control.active }"
      :title="control.title"
      :aria-label="control.label"
      :aria-pressed="control.active"
      @click="$emit('toggle', control.action)"
    >
      <component :is="control.icon" class="icon-sm" aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { AlignJustify, ArrowDownUp, Clock, FileText, Palette, WrapText } from '@lucide/vue';
import { t } from '@/lib/i18n';

export type DisplayControlAction =
  'auto-scroll' | 'ansi-color' | 'line-breaks' | 'soft-wrap' | 'timestamp' | 'auto-log';

const props = defineProps<{
  autoScroll: boolean;
  ansiColor: boolean;
  lineBreaks: boolean;
  softWrap: boolean;
  timestamp: boolean;
  autoLog: boolean;
  logPath?: string | null;
}>();

defineEmits<{ toggle: [action: DisplayControlAction] }>();

const controls = computed(() => [
  {
    action: 'auto-scroll' as const,
    icon: ArrowDownUp,
    active: props.autoScroll,
    label: t('toolbar.autoScroll'),
    title: t('toolbar.autoScroll'),
  },
  {
    action: 'ansi-color' as const,
    icon: Palette,
    active: props.ansiColor,
    label: t('toolbar.ansiColor'),
    title: t('toolbar.ansiColor.render'),
  },
  {
    action: 'line-breaks' as const,
    icon: WrapText,
    active: props.lineBreaks,
    label: t('toolbar.logLineBreaks'),
    title: t('toolbar.logLineBreaks.title'),
  },
  {
    action: 'soft-wrap' as const,
    icon: AlignJustify,
    active: props.softWrap,
    label: t('toolbar.softWrap'),
    title: t('toolbar.softWrap.title'),
  },
  {
    action: 'timestamp' as const,
    icon: Clock,
    active: props.timestamp,
    label: t('toolbar.timestamp'),
    title: t('toolbar.timestamp'),
  },
  {
    action: 'auto-log' as const,
    icon: FileText,
    active: props.autoLog,
    label: t('toolbar.autoLog'),
    title:
      props.autoLog && props.logPath
        ? t('toolbar.autoLog.on', { path: props.logPath })
        : t('toolbar.autoLog.off'),
  },
]);
</script>

<style scoped>
.display-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2xs);
  flex-shrink: 0;
  padding: var(--space-2xs);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.display-toggle {
  display: grid;
  place-items: center;
  width: var(--control-h-md);
  height: var(--control-h-md);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.display-toggle:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.display-toggle.active {
  color: var(--color-primary);
  background: var(--accent-green-subtle);
}

.display-toggle:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
</style>
