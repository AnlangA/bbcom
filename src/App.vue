<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <n-message-provider>
      <n-dialog-provider>
        <AppShell />
        <ShutdownDialog />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { onErrorCaptured, watch } from 'vue';
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui';
import AppShell from './components/app-shell/AppShell.vue';
import ShutdownDialog from './components/app-shell/ShutdownDialog.vue';
import { useAiSessionBridge } from './composables/useAiSessionBridge';
import { useAppStore } from './stores/app';
import { themeOverrides } from './styles/naive-theme';

const appStore = useAppStore();

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
