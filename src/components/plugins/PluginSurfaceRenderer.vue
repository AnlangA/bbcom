<template>
  <section v-if="validation.ok" class="plugin-surface" :aria-labelledby="titleId">
    <header class="plugin-surface__header">
      <h3 :id="titleId">{{ surface.title }}</h3>
      <button
        v-if="view === 'workspace' && surface.detachedAllowed"
        type="button"
        :disabled="busy"
        @click="togglePlacement"
      >
        {{
          t(surface.placement === 'workspace' ? 'plugins.surface.detach' : 'plugins.surface.attach')
        }}
      </button>
    </header>

    <div
      v-if="view === 'workspace' && surface.placement === 'detached-window'"
      class="plugin-surface__placeholder"
      role="status"
    >
      {{ t('plugins.surface.detached_placeholder') }}
    </div>
    <PluginUiNodeRenderer
      v-else
      :node="surface.root"
      :editable="canEdit"
      :busy="busy"
      :confirm-dangerous="confirmDangerous"
      @interaction="onInteraction"
    />
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </section>

  <section v-else class="plugin-surface plugin-surface--invalid" role="alert">
    {{ t('plugins.surface.rejected', { code: validation.failure.code }) }}
  </section>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue';
import { t } from '../../lib/i18n';
import type {
  PluginSurfaceEventKind,
  PluginSurfaceEventV2,
  PluginSurfaceSnapshot,
} from '../../generated/ipc-contracts';
import { createPluginSurfaceEvent, validatePluginSurface } from '../../features/plugins';
import PluginUiNodeRenderer from './PluginUiNodeRenderer.vue';

const props = withDefaults(
  defineProps<{
    surface: PluginSurfaceSnapshot;
    busy?: boolean;
    view?: 'workspace' | 'detached-window';
    announcement?: string;
    confirmDangerous?: (message: string) => boolean | Promise<boolean>;
  }>(),
  { busy: false, view: 'workspace', announcement: '' },
);

const emit = defineEmits<{
  event: [event: PluginSurfaceEventV2];
  detach: [];
  attach: [];
}>();

const titleId = `plugin-surface-${useId()}`;
const validation = computed(() => validatePluginSurface(props.surface));
const canEdit = computed(
  () =>
    props.surface.editable &&
    ((props.view === 'workspace' && props.surface.placement === 'workspace') ||
      (props.view === 'detached-window' && props.surface.placement === 'detached-window')),
);

function onInteraction(nodeId: string, eventKind: PluginSurfaceEventKind, value?: string): void {
  const event = createPluginSurfaceEvent(props.surface, nodeId, eventKind, value);
  if (event && canEdit.value) emit('event', event);
}

function togglePlacement(): void {
  if (props.surface.placement === 'workspace') emit('detach');
  else emit('attach');
}
</script>

<style scoped>
.plugin-surface {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  padding: 0.85rem;
}

.plugin-surface__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.plugin-surface__header h3 {
  margin: 0;
  font-size: 1rem;
}

.plugin-surface__placeholder {
  border: 1px dashed var(--border-color);
  border-radius: 0.4rem;
  padding: 1rem;
  color: var(--text-muted);
}

.plugin-surface--invalid {
  border-color: var(--color-error);
  color: var(--color-error);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
