<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <main class="plugin-window">
      <p v-if="loading" class="plugin-window__state" role="status" aria-live="polite">
        {{ t('plugins.detached.loading') }}
      </p>
      <section v-else-if="error" class="plugin-window__state" role="alert">
        <h1>{{ t('plugins.detached.unavailable_title') }}</h1>
        <p>{{ t('plugins.detached.unavailable') }}</p>
      </section>
      <template v-else-if="view">
        <PluginSurfaceRenderer
          :surface="view.surface"
          :busy="busy"
          view="detached-window"
          :announcement="announcement"
          @event="emitSurfaceEvent"
        />
        <PluginTaskCenter :tasks="view.tasks" :busy="busy" @cancel="cancelTask" />
      </template>
    </main>
  </n-config-provider>
</template>

<script setup lang="ts">
import { NConfigProvider } from 'naive-ui';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import PluginSurfaceRenderer from './components/plugins/PluginSurfaceRenderer.vue';
import PluginTaskCenter from './components/plugins/PluginTaskCenter.vue';
import type {
  PluginDetachedSurfaceViewV2,
  PluginSurfaceEventV2,
  PluginTaskViewV2,
} from './generated/ipc-contracts';
import { TauriPluginDetachedWindowPort } from './features/plugins';
import { t } from './lib/i18n';
import { useAppStore } from './stores/app';
import { themeOverrides } from './styles/naive-theme';

const token = new URLSearchParams(window.location.search).get('token') ?? '';
const port = new TauriPluginDetachedWindowPort();
const view = ref<PluginDetachedSurfaceViewV2 | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref(false);
const announcement = ref('');
let unlisten: (() => void) | null = null;

const appStore = useAppStore();
watch(
  () => appStore.theme,
  (theme) => document.documentElement.setAttribute('data-theme', theme),
  { immediate: true },
);

onMounted(async () => {
  try {
    unlisten = await port.subscribe((payload) => {
      const current = view.value;
      if (
        !current ||
        (sameSurface(current, payload) &&
          payload.centerRevision >= current.centerRevision &&
          payload.surface.revision >= current.surface.revision)
      ) {
        view.value = payload;
        document.title = payload.surface.title;
        announcement.value = payload.surface.title;
      }
    });
    view.value = await port.snapshot(token);
    document.title = view.value.surface.title;
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  unlisten?.();
  unlisten = null;
});

async function emitSurfaceEvent(event: PluginSurfaceEventV2): Promise<void> {
  if (busy.value || !view.value) return;
  busy.value = true;
  try {
    await port.emitSurfaceEvent(token, event);
  } catch {
    announcement.value = t('plugins.detached.action_failed');
  } finally {
    busy.value = false;
  }
}

async function cancelTask(task: PluginTaskViewV2): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await port.cancelTask(token, task.taskId);
  } catch {
    announcement.value = t('plugins.detached.action_failed');
  } finally {
    busy.value = false;
  }
}

function sameSurface(
  current: PluginDetachedSurfaceViewV2,
  next: PluginDetachedSurfaceViewV2,
): boolean {
  const left = current.surface.runtime;
  const right = next.surface.runtime;
  return (
    current.surface.surfaceId === next.surface.surfaceId &&
    left.workspaceId === right.workspaceId &&
    left.pluginId === right.pluginId &&
    left.instanceId === right.instanceId &&
    left.generation === right.generation
  );
}
</script>

<style scoped>
.plugin-window {
  display: grid;
  gap: 1rem;
  height: 100vh;
  overflow: auto;
  padding: 1rem;
  color: var(--text-primary);
  background: var(--bg-app);
}

.plugin-window__state {
  place-self: center;
  max-width: 34rem;
  text-align: center;
}
</style>
