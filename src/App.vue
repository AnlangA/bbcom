<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides">
    <n-message-provider>
      <AppShell />
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { darkTheme, NConfigProvider, NMessageProvider } from 'naive-ui';
import AppShell from './components/app-shell/AppShell.vue';
import { useAiSessionBridge } from './composables/useAiSessionBridge';

useAiSessionBridge();

const themeOverrides = {
  common: {
    primaryColor: '#4caf50',
    primaryColorHover: '#66bb6a',
    primaryColorPressed: '#388e3c',
    primaryColorSuppl: '#4caf50',
    borderRadius: '4px',
    borderRadiusSmall: '3px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontFamilyMono: '"Menlo", "Consolas", "Courier New", monospace',
    fontSize: '13px',
    fontSizeMini: '11px',
    fontSizeTiny: '11px',
    fontSizeSmall: '12px',
    fontSizeMedium: '13px',
    heightSmall: '28px',
    heightMedium: '32px',
    dividerColor: '#2e2e2e',
    borderColor: '#3c3c3c',
    inputColor: '#1a1a1a',
    inputColorDisabled: '#252526',
    actionColor: '#252526',
    modalColor: '#2a2a2a',
    cardColor: '#252526',
    tableColor: '#1e1e1e',
    popoverColor: '#2a2a2a',
  },
  Button: {
    textColorPrimary: '#fff',
    textColorHoverPrimary: '#fff',
    textColorPressedPrimary: '#fff',
  },
  Input: {
    color: '#1a1a1a',
    colorFocus: '#1a1a1a',
    border: '1px solid #3c3c3c',
    borderHover: '#505050',
    borderFocus: '#4caf50',
    boxShadowFocus: '0 0 0 2px rgba(76, 175, 80, 0.15)',
  },
  Select: {
    peers: {
      InternalSelection: {
        color: '#1a1a1a',
        border: '1px solid #3c3c3c',
        borderHover: '#505050',
        borderFocus: '#4caf50',
        boxShadowFocus: '0 0 0 2px rgba(76, 175, 80, 0.15)',
      },
    },
  },
  Tag: {
    border: '1px solid #3c3c3c',
    borderRadiusSmall: '3px',
  },
  Modal: {
    color: '#2a2a2a',
    borderColor: '#3c3c3c',
  },
};
</script>
