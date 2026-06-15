<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="activeOverrides">
    <n-message-provider>
      <AppShell />
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, watch } from 'vue';
import { darkTheme, NConfigProvider, NMessageProvider } from 'naive-ui';
import AppShell from './components/app-shell/AppShell.vue';
import { useAiSessionBridge } from './composables/useAiSessionBridge';
import { useAppStore } from './stores/app';
import { lightThemeOverrides, themeOverrides } from './styles/naive-theme';

const appStore = useAppStore();
const naiveTheme = computed(() => (appStore.theme === 'light' ? null : darkTheme));
const activeOverrides = computed(() =>
  appStore.theme === 'light' ? lightThemeOverrides : themeOverrides,
);

// Reflect the theme onto <html data-theme> so the CSS variable palettes swap.
watch(
  () => appStore.theme,
  (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
  },
  { immediate: true },
);

useAiSessionBridge();

onErrorCaptured((err, _instance, info) => {
  // Last-resort boundary: surface render errors instead of silently blanking
  // the window. App.vue sits above NMessageProvider so it can't toast; child
  // errors are toasted by AppShell's handler, and this catches anything that
  // escapes it (e.g. AppShell's own render).
  // eslint-disable-next-line no-console
  console.error('[bbcom] uncaught component error:', err, '\ninfo:', info);
  return false;
});
</script>
