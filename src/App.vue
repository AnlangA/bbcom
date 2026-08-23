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
import AppShell from '@/features/app-shell/ui/AppShell.vue';
import ShutdownDialog from '@/features/app-shell/ui/ShutdownDialog.vue';
import { useAiSessionBridge } from '@/features/ai/application/use-ai-session-bridge';
import { useAppStore } from '@/features/settings/store/app-store';
import { themeOverrides } from '@/design-system/naive-theme';

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
