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
import { resizeAiWindow } from './features/native';
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
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  await resizeAiWindow(width, height);
  // On macOS the webview lays out to the safe area, leaving the viewport
  // shorter than requested by the titlebar inset (not measurable from Rust).
  // Read the deficit from the live viewport and re-request once so the
  // visible client area truly covers the content box. rAF may stall while
  // the OS window is still hidden, so the wait is bounded.
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    };
    requestAnimationFrame(done);
    setTimeout(done, 120);
  });
  const deficit = height - window.innerHeight;
  if (deficit > 1) {
    await resizeAiWindow(width, height + deficit);
  }
}

// Visibility is OS-window state owned by the Rust side: the show/hide/close
// paths there emit `ai-window-state` after the real transition. This webview
// must NOT broadcast its own visibility — it mounts while the window is still
// hidden, so a mount-time `visible: true` would desync the main-window toggle
// (and an unmount-time `false` would clobber a still-visible window on reload).
onMounted(async () => {
  await nextTick();
  observer = new ResizeObserver(scheduleResize);
  if (contentEl.value) observer.observe(contentEl.value);
  scheduleResize();
});

onUnmounted(() => {
  observer?.disconnect();
  if (resizeTimer) clearTimeout(resizeTimer);
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
  width: var(--ai-panel-width);
}
</style>
