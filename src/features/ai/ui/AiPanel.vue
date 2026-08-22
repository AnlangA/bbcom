<template>
  <div class="ai-panel">
    <div class="ai-header">
      <div class="drag-handle" @pointerdown="startDrag">
        <div class="title-group">
          <div class="ai-mark">
            <Bot class="icon-lg" />
          </div>
          <div>
            <div class="drag-title">{{ t('ai.title') }}</div>
            <div class="drag-subtitle">
              {{ session ? t('ai.sessionContext', { port: session.portName }) : t('ai.noSession') }}
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
          {{ alwaysOnTop ? t('ai.unpin') : t('ai.pin') }}
        </n-button>
      </div>
    </div>

    <n-tabs v-if="session" v-model:value="activeTab" size="small" animated>
      <n-tab-pane name="terminal" :tab="t('ai.terminalTab')" display-directive="show">
        <AiTerminalAssistant :session="session" :bridge="bridge" />
      </n-tab-pane>
      <n-tab-pane name="log" :tab="t('ai.logTab')" display-directive="show">
        <AiLogAssistant :session="session" :bridge="bridge" />
      </n-tab-pane>
    </n-tabs>
    <div v-else class="empty-state" role="status" aria-live="polite">
      {{ t('ai.needSession') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NTabPane, NTabs, useMessage } from 'naive-ui';
import { Bot, Pin, PinOff } from '@lucide/vue';
import { useAiWindowSession } from '@/features/ai/application/use-ai-window-session';
import {
  getCurrentWindowAlwaysOnTop,
  setCurrentWindowAlwaysOnTop,
  startAiWindowDrag,
} from '@/features/platform/native';
import AiTerminalAssistant from '@/features/send-panel/ui/AiTerminalAssistant.vue';
import AiLogAssistant from './AiLogAssistant.vue';
import { logger } from '@/lib/logger';
import { t } from '@/lib/i18n';

const bridge = useAiWindowSession();
const message = useMessage();
const session = computed(() => bridge.session.value);
const activeTab = ref<'terminal' | 'log'>('terminal');
const alwaysOnTop = ref(true);

onMounted(async () => {
  try {
    alwaysOnTop.value = await getCurrentWindowAlwaysOnTop();
  } catch (e) {
    logger.debug('always-on-top query failed during early lifecycle:', e);
  }
});

async function startDrag() {
  try {
    await startAiWindowDrag();
  } catch (e) {
    logger.debug('AI window drag failed:', e);
  }
}

async function toggleAlwaysOnTop() {
  try {
    const next = !alwaysOnTop.value;
    await setCurrentWindowAlwaysOnTop(next);
    alwaysOnTop.value = next;
  } catch {
    message.error(t('ai.pinFailed'));
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
  background: linear-gradient(180deg, var(--edge-highlight), transparent 90px), var(--bg-secondary);
  box-shadow: var(--shadow-lg), var(--shadow-inset);
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
  font-size: var(--font-size-sm);
  font-weight: 700;
  cursor: grab;
  user-select: none;
  touch-action: none;
  border-radius: var(--radius-lg);
}

.drag-handle:hover {
  background: var(--surface-lift);
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
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.empty-state {
  padding: 24px 8px 18px;
  text-align: center;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-inset);
}

@media (max-width: 720px) {
  .ai-header {
    grid-template-columns: 1fr auto;
  }
}
</style>
