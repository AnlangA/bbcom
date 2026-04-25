<template>
  <div class="ai-assistant">
    <div class="drag-handle" @pointerdown="startDrag">
      <span class="drag-title">AI 终端助手</span>
      <div class="window-actions">
        <n-button size="tiny" quaternary @click.stop="toggleAlwaysOnTop">
          {{ alwaysOnTop ? '取消置顶' : '置顶' }}
        </n-button>
        <span class="drag-dots">⋮⋮</span>
      </div>
    </div>
    <div class="compact-row">
      <button class="ai-pill" type="button" @click="expanded = !expanded">
        <span class="spark">✦</span>
        <span>AI</span>
      </button>
      <n-input
        v-model:value="prompt"
        size="small"
        placeholder="自然语言生成命令，如：查看当前路径"
        :disabled="loading || !hasApiKey"
        @keydown.enter.prevent="generateCommand"
      />
      <n-button
        size="small"
        type="primary"
        :loading="loading"
        :disabled="!canGenerate"
        @click="generateCommand"
      >
        生成
      </n-button>
      <n-button size="small" quaternary @click="expanded = !expanded">
        {{ expanded ? '收起' : '设置' }}
      </n-button>
    </div>

    <div v-if="expanded" class="settings-row">
      <n-select
        size="small"
        :value="appStore.aiModel"
        :options="modelOptions"
        @update:value="appStore.setAiModel"
      />
      <div class="header-actions">
        <n-switch
          size="small"
          :value="appStore.aiEnableCodingPlan"
          @update:value="appStore.setAiEnableCodingPlan"
        />
        <n-tag size="small" round :type="appStore.aiEnableCodingPlan ? 'success' : 'info'">
          Coding Plan
        </n-tag>
      </div>
    </div>

    <div v-if="expanded && !hasApiKey" class="api-key-row">
      <n-input
        v-model:value="apiKeyDraft"
        type="password"
        size="small"
        show-password-on="click"
        placeholder="输入 Z.ai / ZHIPU API Key"
      />
      <n-button size="small" type="primary" @click="saveApiKey" :disabled="!apiKeyDraft.trim()">
        保存
      </n-button>
    </div>

    <div v-if="result" class="result-row" :class="`risk-${result.risk}`">
      <code class="command">{{ result.command || '需要更多信息' }}</code>
      <n-tag size="small" round :type="riskTagType">{{ riskLabel }}</n-tag>
      <span class="explanation">{{ result.explanation }}</span>
      <div class="result-actions">
        <n-button size="tiny" secondary @click="copyCommand" :disabled="!result.command">
          复制
        </n-button>
        <n-button size="tiny" type="primary" @click="applyCommand" :disabled="!result.command">
          填入输入框
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NInput, NSelect, NSwitch, NTag, useMessage } from 'naive-ui';
import { invoke } from '@tauri-apps/api/core';
import { emit as emitEvent } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../../stores/app';

type Risk = 'safe' | 'caution' | 'dangerous';

interface TerminalAiResponse {
  command: string;
  explanation: string;
  risk: Risk;
}

const emitVue = defineEmits<{
  (e: 'applyCommand', command: string): void;
}>();

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const apiKeyDraft = ref(appStore.aiApiKey);
const loading = ref(false);
const expanded = ref(false);
const alwaysOnTop = ref(true);
const result = ref<TerminalAiResponse | null>(null);

const modelOptions = [
  { label: 'GLM-5.1', value: 'glm-5.1' },
  { label: 'GLM-5 Turbo', value: 'glm-5-turbo' },
  { label: 'GLM-5', value: 'glm-5' },
  { label: 'GLM-4.7', value: 'glm-4.7' },
  { label: 'GLM-4.7 Flash', value: 'glm-4.7-flash' },
  { label: 'GLM-4.7 FlashX', value: 'glm-4.7-flashx' },
  { label: 'GLM-4.6', value: 'glm-4.6' },
  { label: 'GLM-4.5', value: 'glm-4.5' },
  { label: 'GLM-4.5 X', value: 'glm-4.5-X' },
  { label: 'GLM-4.5 Flash', value: 'glm-4.5-flash' },
  { label: 'GLM-4.5 Air', value: 'glm-4.5-air' },
  { label: 'GLM-4.5 AirX', value: 'glm-4.5-airx' },
];

const hasApiKey = computed(() => Boolean(appStore.aiApiKey.trim()));
const canGenerate = computed(() => hasApiKey.value && prompt.value.trim().length > 0 && !loading.value);
const riskLabel = computed(() => {
  if (!result.value) return '';
  return { safe: '安全', caution: '谨慎', dangerous: '危险' }[result.value.risk];
});
const riskTagType = computed(() => {
  if (!result.value) return 'default';
  return result.value.risk === 'safe' ? 'success' : result.value.risk === 'caution' ? 'warning' : 'error';
});

onMounted(async () => {
  try {
    alwaysOnTop.value = await getCurrentWindow().isAlwaysOnTop();
  } catch {
    // ignore
  }
});

function saveApiKey() {
  appStore.setAiApiKey(apiKeyDraft.value.trim());
  message.success('AI Key 已保存到本地设置');
}

async function generateCommand() {
  if (!canGenerate.value) return;
  loading.value = true;
  result.value = null;
  try {
    const response = await invoke<TerminalAiResponse>('terminal_ai_assist', {
      request: {
        prompt: prompt.value.trim(),
        apiKey: appStore.aiApiKey,
        model: appStore.aiModel,
        enableCodingPlan: appStore.aiEnableCodingPlan,
        shell: 'linux/busybox',
      },
    });
    result.value = response;
    if (response.command && response.risk !== 'dangerous') {
      applyCommandToApp(response.command);
    }
  } catch (e) {
    message.error(typeof e === 'string' ? e : 'AI 命令生成失败');
  } finally {
    loading.value = false;
  }
}

async function copyCommand() {
  if (!result.value?.command) return;
  await navigator.clipboard.writeText(result.value.command);
  message.success('命令已复制');
}

function applyCommand() {
  if (!result.value?.command) return;
  applyCommandToApp(result.value.command);
}

function applyCommandToApp(command: string) {
  appStore.applyAiCommand(command);
  emitEvent('ai-command-generated', command);
  emitVue('applyCommand', command);
}

async function startDrag() {
  try {
    await invoke('start_ai_window_drag');
  } catch {
    // ignore
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
.ai-assistant {
  padding: 6px 8px;
  border: 1px solid rgba(99, 255, 177, 0.16);
  border-radius: 0;
  background:
    radial-gradient(circle at 0 0, rgba(99, 255, 177, 0.1), transparent 28%),
    linear-gradient(135deg, rgba(18, 26, 32, 0.82), rgba(12, 16, 21, 0.72));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
  display: flex;
  flex-direction: column;
  gap: 6px;
  backdrop-filter: blur(16px);
}

.drag-handle {
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.window-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.drag-handle:active {
  cursor: grabbing;
}

.drag-title {
  letter-spacing: 0.3px;
}

.drag-dots {
  color: var(--text-dim);
  letter-spacing: -2px;
}

.compact-row,
.settings-row,
.header-actions,
.api-key-row,
.result-row,
.result-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.compact-row .n-input,
.api-key-row .n-input,
.settings-row .n-select {
  flex: 1;
  min-width: 0;
}

.ai-pill {
  height: 28px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(99, 255, 177, 0.36);
  border-radius: 999px;
  background: rgba(99, 255, 177, 0.1);
  color: var(--accent-green);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
}

.spark {
  font-size: 11px;
}

.settings-row {
  padding-left: 44px;
}

.header-actions {
  flex-shrink: 0;
}

.result-row {
  min-height: 30px;
  padding: 4px 6px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.028);
}

.command {
  color: var(--accent-green);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.26);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
  flex-shrink: 0;
}

.explanation {
  color: var(--text-secondary);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.result-actions {
  flex-shrink: 0;
}

.risk-dangerous {
  border-color: rgba(255, 95, 95, 0.45);
}

.risk-caution {
  border-color: rgba(255, 194, 87, 0.45);
}
</style>
