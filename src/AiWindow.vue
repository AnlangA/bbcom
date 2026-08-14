<template>
  <n-config-provider :theme-overrides="activeOverrides">
    <n-message-provider>
      <div ref="contentEl" class="ai-window-content">
        <AiPanel />
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, onErrorCaptured, ref, watch } from 'vue';
import { NConfigProvider, NMessageProvider } from 'naive-ui';
import { emit } from '@tauri-apps/api/event';
import { resizeAiWindow } from './lib/ipc';
import AiPanel from './components/ai/AiPanel.vue';
import { useAiWindowAuthority } from './features/ai-activity';
import { useAppStore } from './stores/app';
import { lightThemeOverrides, themeOverrides } from './styles/naive-theme';

const appStore = useAppStore();
useAiWindowAuthority({
  setTheme: appStore.setTheme,
  setLocale: appStore.setLocale,
  get aiKeyStatus() {
    return appStore.aiKeyStatus;
  },
  set aiKeyStatus(value) {
    appStore.aiKeyStatus = value;
  },
});
// Both palettes are fully expressed as local overrides; loading naive-ui's
// aggregate dark theme would otherwise emit unused component themes.
const activeOverrides = computed(() =>
  appStore.theme === 'light' ? lightThemeOverrides : themeOverrides,
);
watch(
  () => appStore.theme,
  (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
  },
  { immediate: true },
);

onErrorCaptured((err, _instance, info) => {
  // Surface AI-window render errors to the console instead of failing silently
  // with a blank floating window.
  // eslint-disable-next-line no-console
  console.error('[bbcom] AI window component error:', err, '\ninfo:', info);
  return false;
});

const contentEl = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeToContent, 60);
}

async function resizeToContent() {
  if (!contentEl.value) return;
  const rect = contentEl.value.getBoundingClientRect();
  await resizeAiWindow(Math.ceil(rect.width), Math.ceil(rect.height) + 28);
}

onMounted(async () => {
  await emit('ai-window-state', { visible: true });
  await nextTick();
  observer = new ResizeObserver(scheduleResize);
  if (contentEl.value) observer.observe(contentEl.value);
  scheduleResize();
});

onUnmounted(() => {
  observer?.disconnect();
  if (resizeTimer) clearTimeout(resizeTimer);
  emit('ai-window-state', { visible: false });
});
</script>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 100vw;
  min-height: 100vh;
  background: transparent;
}

.ai-window-content {
  width: 820px;
}
</style>
