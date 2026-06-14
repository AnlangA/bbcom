<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides">
    <n-message-provider>
      <AppShell />
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { onErrorCaptured } from 'vue';
import { darkTheme, NConfigProvider, NMessageProvider } from 'naive-ui';
import AppShell from './components/app-shell/AppShell.vue';
import { useAiSessionBridge } from './composables/useAiSessionBridge';
import { themeOverrides } from './styles/naive-theme';

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
