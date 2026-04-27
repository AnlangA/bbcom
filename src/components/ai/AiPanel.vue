<template>
  <div class="ai-panel">
    <div class="drag-handle" @pointerdown="startDrag">
      <div class="title-group">
        <div class="ai-orb">AI</div>
        <div>
          <div class="drag-title">AI 助手</div>
          <div class="drag-subtitle">{{ session ? `${session.portName} 独立上下文` : '请先创建串口会话' }}</div>
        </div>
      </div>
      <div class="window-actions">
        <n-button size="tiny" quaternary @click.stop="toggleAlwaysOnTop">
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
  padding: 10px;
  border: 1px solid rgba(99, 255, 177, 0.18);
  background:
    radial-gradient(circle at 0 0, rgba(99, 255, 177, 0.12), transparent 32%),
    linear-gradient(135deg, rgba(18, 26, 32, 0.94), rgba(12, 16, 21, 0.86));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
  backdrop-filter: blur(16px);
}

.drag-handle,
.title-group,
.window-actions {
  display: flex;
  align-items: center;
}

.drag-handle {
  min-height: 36px;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.title-group {
  gap: 10px;
  min-width: 0;
}

.ai-orb {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(99, 255, 177, 0.45);
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(99, 255, 177, 0.24), rgba(99, 255, 177, 0.08));
  color: #9fffc7;
  font-size: 12px;
  font-weight: 800;
  flex-shrink: 0;
}

.drag-title {
  color: var(--text-primary);
  font-size: 13px;
  letter-spacing: 0.3px;
}

.drag-subtitle,
.empty-state {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 500;
}

.empty-state {
  padding: 18px 8px;
  text-align: center;
}

:global(.ai-model-menu) {
  max-height: 72px !important;
  overflow-y: auto !important;
}
</style>
