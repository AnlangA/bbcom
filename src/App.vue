<template>
  <n-config-provider :theme-overrides="activeOverrides">
    <n-message-provider>
      <n-dialog-provider>
        <LegacyResetGate>
          <AppShell />
        </LegacyResetGate>
        <ShutdownDialog />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, watch } from 'vue';
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui';
import AppShell from './components/app-shell/AppShell.vue';
import LegacyResetGate from './components/migration/LegacyResetGate.vue';
import ShutdownDialog from './components/app-shell/ShutdownDialog.vue';
import { useAiSessionBridge } from './composables/useAiSessionBridge';
import { useAppStore } from './stores/app';
import { lightThemeOverrides, themeOverrides } from './styles/naive-theme';

const appStore = useAppStore();
// The explicit theme overrides already define both palettes. Avoid importing
// naive-ui's aggregate dark theme, which includes styles for every component
// (including controls bbcom does not ship) in the renderer output.
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
