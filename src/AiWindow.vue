<template>
  <n-config-provider :theme="darkTheme">
    <n-message-provider>
      <div ref="contentEl" class="ai-window-content">
        <AiTerminalAssistant />
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import { darkTheme, NConfigProvider, NMessageProvider } from 'naive-ui';
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import AiTerminalAssistant from './components/send-panel/AiTerminalAssistant.vue';

const contentEl = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeToContent, 60);
}

async function resizeToContent() {
  if (!contentEl.value) return;
  const rect = contentEl.value.getBoundingClientRect();
  await invoke('resize_ai_window', {
    request: {
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height) + 28,
    },
  });
}

onMounted(async () => {
  await emit('ai-window-state', { visible: true });
  await nextTick();
  observer = new ResizeObserver(scheduleResize);
  if (contentEl.value) observer.observe(contentEl.value);
  scheduleResize();
});

onUnmounted(() => {
  observer?.disconnect();
  if (resizeTimer) clearTimeout(resizeTimer);
  emit('ai-window-state', { visible: false });
});
</script>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 100vw;
  min-height: 100vh;
  background: transparent;
}

.ai-window-content {
  width: 760px;
}
</style>
