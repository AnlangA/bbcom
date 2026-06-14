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
import { logger } from './lib/logger';

useAiSessionBridge();

onErrorCaptured((err, _instance, info) => {
  logger.error('uncaught component error:', info, err);
  return false;
});
</script>
