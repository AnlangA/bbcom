<template>
  <div class="ai-assistant">
    <div class="prompt-row">
      <n-input
        v-model:value="prompt"
        size="small"
        :placeholder="hasApiKey ? '自然语言生成命令，如：查看当前路径' : '请先在主页面保存 API Key'"
        :disabled="loading"
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
    </div>

    <div v-if="activeSession" class="settings-panel">
      <span class="field-label">命令模型</span>
      <n-select
        size="small"
        :value="activeSession.terminalAiModel"
        :options="aiModelOptions"
        :menu-props="aiModelMenuProps"
        @update:value="setTerminalModel"
      />
    </div>

    <div v-if="result" class="result-row" :class="`risk-${result.risk}`">
      <div class="result-main">
        <div class="result-meta">
          <n-tag size="small" round :type="riskTagType">{{ riskLabel }}</n-tag>
          <span class="explanation">{{ result.explanation }}</span>
        </div>
        <code class="command">{{ result.command || '需要更多信息' }}</code>
      </div>
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
import { computed, ref } from 'vue';
import { NButton, NInput, NSelect, NTag, useMessage } from 'naive-ui';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/app';
import { getAiErrorMessage } from '../../lib/ai-error';
import type { AiModel, SerialSession } from '../../types';
import type { useAiWindowSession } from '../../composables/useAiWindowSession';
import { aiModelMenuProps, aiModelOptions } from '../ai/ai-options';

type Risk = 'safe' | 'caution' | 'dangerous';

interface TerminalAiResponse {
  command: string;
  explanation: string;
  risk: Risk;
}

const props = defineProps<{
  session: SerialSession;
  bridge: ReturnType<typeof useAiWindowSession>;
}>();

const emitVue = defineEmits<{
  (e: 'applyCommand', command: string): void;
}>();

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const loading = ref(false);
const result = ref<TerminalAiResponse | null>(null);

const activeSession = computed(() => props.session);
const hasApiKey = computed(() => Boolean(appStore.aiApiKey.trim()));
const canGenerate = computed(() => prompt.value.trim().length > 0 && !loading.value);
const riskLabel = computed(() => {
  if (!result.value) return '';
  return { safe: '安全', caution: '谨慎', dangerous: '危险' }[result.value.risk];
});
const riskTagType = computed(() => {
  if (!result.value) return 'default';
  return result.value.risk === 'safe' ? 'success' : result.value.risk === 'caution' ? 'warning' : 'error';
});

async function generateCommand() {
  if (!canGenerate.value) return;
  if (!hasApiKey.value) {
    message.warning('请先保存 API Key');
    return;
  }
  if (!activeSession.value) {
    message.warning('请先创建串口会话');
    return;
  }
  loading.value = true;
  result.value = null;
  try {
    const response = await invoke<TerminalAiResponse>('terminal_ai_assist', {
      request: {
        prompt: prompt.value.trim(),
        apiKey: appStore.aiApiKey,
        model: activeSession.value.terminalAiModel,
        enableCodingPlan: appStore.aiEnableCodingPlan,
        shell: 'linux/busybox',
      },
    });
    result.value = response;
    if (response.command && response.risk !== 'dangerous') {
      applyCommandToApp(response.command);
    }
  } catch (e: unknown) {
    message.error(getAiErrorMessage(e, 'AI 命令生成失败'));
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
  void props.bridge.applyCommand(command);
  emitVue('applyCommand', command);
}

function setTerminalModel(model: AiModel) {
  void props.bridge.setTerminalAiModel(model);
}

</script>

<style scoped>
.ai-assistant {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.prompt-row,
.settings-panel,
.result-row,
.result-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prompt-row .n-input,
.settings-panel .n-select {
  flex: 1;
  min-width: 0;
}

.settings-panel {
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.035);
}

.field-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.result-row {
  align-items: stretch;
  min-height: 48px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.028);
}

.result-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.result-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.command {
  color: var(--accent-green);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 5px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.26);
  word-break: break-all;
  white-space: pre-wrap;
  max-height: 120px;
  overflow-y: auto;
}

.explanation {
  color: var(--text-secondary);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 80px;
  overflow-y: auto;
  min-width: 0;
  flex: 1;
}

.result-actions {
  align-self: flex-end;
  flex-shrink: 0;
}

.risk-dangerous {
  border-color: rgba(255, 95, 95, 0.45);
}

.risk-caution {
  border-color: rgba(255, 194, 87, 0.45);
}

:global(.ai-model-menu) {
  max-height: 72px !important;
  overflow-y: auto !important;
}
</style>
