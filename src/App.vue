<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="darkThemeOverrides">
    <n-message-provider>
      <AppShell />
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { darkTheme, NConfigProvider, NMessageProvider } from 'naive-ui';
import AppShell from './components/app-shell/AppShell.vue';
import { useAiSessionBridge } from './composables/useAiSessionBridge';
import { darkThemeOverrides } from './styles/naive-theme';

useAiSessionBridge();
</script>
