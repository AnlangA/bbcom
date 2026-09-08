<template>
  <n-config-provider
    :theme="appStore.theme === 'dark' ? darkTheme : null"
    :theme-overrides="activeThemeOverrides"
  >
    <n-message-provider>
      <n-dialog-provider>
        <AppShell />
        <ShutdownDialog />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, watch } from 'vue';
import { darkTheme, NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui';
import AppShell from '@/features/app-shell/ui/AppShell.vue';
import ShutdownDialog from '@/features/app-shell/ui/ShutdownDialog.vue';
import { useAiSessionBridge } from '@/features/ai/application/use-ai-session-bridge';
import { useAppStore } from '@/features/settings/store/app-store';
import { getThemeOverrides } from '@/design-system/naive-theme';

const appStore = useAppStore();
const activeThemeOverrides = computed(() => getThemeOverrides(appStore.theme));

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
