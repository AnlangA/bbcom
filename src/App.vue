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
  // Component error captured
  void err;
  void info;
  return false;
});
</script>
