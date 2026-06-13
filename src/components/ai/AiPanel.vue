<template>
  <div class="ai-panel">
    <div class="ai-header">
      <div class="drag-handle" @pointerdown="startDrag">
        <div class="title-group">
          <div class="ai-mark">
            <Bot class="icon-lg" />
          </div>
          <div>
            <div class="drag-title">AI 助手</div>
            <div class="drag-subtitle">
              {{ session ? `${session.portName} 独立上下文` : '请先创建串口会话' }}
            </div>
          </div>
        </div>
      </div>

      <div class="window-actions">
        <n-button size="tiny" quaternary @click.stop="toggleAlwaysOnTop">
          <template #icon>
            <PinOff v-if="alwaysOnTop" class="icon-sm" />
            <Pin v-else class="icon-sm" />
          </template>
          {{ alwaysOnTop ? '取消置顶' : '置顶' }}
        </n-button>
      </div>
    </div>

    <n-tabs v-if="session" v-model:value="activeTab" size="small" animated>
      <n-tab-pane name="terminal" tab="命令助手" display-directive="show">
        <AiTerminalAssistant :session="session" :bridge="bridge" />
      </n-tab-pane>
      <n-tab-pane name="log" tab="日志助手" display-directive="show">
        <AiLogAssistant :session="session" :bridge="bridge" />
      </n-tab-pane>
    </n-tabs>
    <div v-else class="empty-state">请先在主窗口创建串口会话。</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NTabPane, NTabs, useMessage } from 'naive-ui';
import { Bot, Pin, PinOff } from 'lucide-vue-next';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAiWindowSession } from '../../composables/useAiWindowSession';
import AiTerminalAssistant from '../send-panel/AiTerminalAssistant.vue';
import AiLogAssistant from './AiLogAssistant.vue';

const bridge = useAiWindowSession();
const message = useMessage();
const session = computed(() => bridge.session.value);
const activeTab = ref<'terminal' | 'log'>('terminal');
const alwaysOnTop = ref(true);

onMounted(async () => {
  try {
    alwaysOnTop.value = await getCurrentWindow().isAlwaysOnTop();
  } catch {
    // ignore — window state query can fail during early lifecycle
  }
});

async function startDrag() {
  try {
    await invoke('start_ai_window_drag');
  } catch {
    // ignore — drag may fail if window is being resized
  }
}

async function toggleAlwaysOnTop() {
  try {
    const next = !alwaysOnTop.value;
    await getCurrentWindow().setAlwaysOnTop(next);
    alwaysOnTop.value = next;
  } catch {
    message.error('置顶切换失败');
  }
}
</script>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.045), transparent 90px), var(--bg-secondary);
  box-shadow: var(--shadow-lg), var(--shadow-inset);
  backdrop-filter: blur(16px);
}

.ai-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
}

.drag-handle,
.title-group,
.window-actions {
  display: flex;
  align-items: center;
}

.drag-handle {
  min-height: 42px;
  justify-content: flex-start;
  padding: 2px 4px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  cursor: grab;
  user-select: none;
  touch-action: none;
  border-radius: var(--radius-lg);
}

.drag-handle:hover {
  background: rgba(255, 255, 255, 0.025);
}

.title-group {
  gap: 10px;
  min-width: 0;
}

.ai-mark {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid var(--color-primary-muted);
  border-radius: var(--radius-lg);
  background: var(--color-primary-subtle);
  color: var(--color-primary);
  flex-shrink: 0;
}

.window-actions {
  min-height: 42px;
  justify-content: flex-end;
  justify-self: end;
}

.drag-title {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
}

.drag-subtitle,
.empty-state {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 500;
}

.empty-state {
  padding: 24px 8px 18px;
  text-align: center;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-inset);
}

:global(.ai-model-menu) {
  max-height: 200px !important;
  overflow-y: auto !important;
}

@media (max-width: 720px) {
  .ai-header {
    grid-template-columns: 1fr auto;
  }
}
</style>
