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

    <div v-if="hasSession" class="settings-panel">
      <span class="field-label">命令模型</span>
      <n-select
        size="small"
        :value="terminalAiModel"
        :options="aiModelOptions"
        :menu-props="aiModelMenuProps"
        @update:value="(v: AiModel) => bridge.setTerminalAiModel(v)"
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

  <n-modal
    :show="showCautionConfirm"
    preset="dialog"
    title="确认执行 (谨慎操作)"
    positive-text="执行"
    negative-text="取消"
    @positive-click="confirmCautionCommand"
    @negative-click="showCautionConfirm = false"
  >
    <p>该命令风险等级为"谨慎"，请确认执行：</p>
    <code>{{ cautionPendingCommand }}</code>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NInput, NSelect, NTag, NModal, useMessage } from 'naive-ui';
import { useAppStore } from '../../stores/app';
import { invokeWithTimeout } from '../../lib/tauri';
import { getAiErrorMessage } from '../../lib/ai-error';
import type { AiModel } from '../../types';
import type { useAiWindowSession } from '../../composables/useAiWindowSession';
import { aiModelMenuProps, aiModelOptions } from '../ai/ai-options';

type Risk = 'safe' | 'caution' | 'dangerous';

interface TerminalAiResponse {
  command: string;
  explanation: string;
  risk: Risk;
}

const AI_INVOKE_TIMEOUT_MS = 30_000;

const props = defineProps<{
  bridge: ReturnType<typeof useAiWindowSession>;
}>();

const bridge = props.bridge;
const hasSession = computed(() => !!bridge.sessionId.value);
const terminalAiModel = computed(() => bridge.terminalAiModel.value);

const emit = defineEmits<{
  (e: 'applyCommand', command: string): void;
}>();

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const loading = ref(false);
const result = ref<TerminalAiResponse | null>(null);
const showCautionConfirm = ref(false);
const cautionPendingCommand = ref('');

const hasApiKey = computed(() => Boolean(appStore.aiApiKey.trim()));
const canGenerate = computed(() => prompt.value.trim().length > 0 && !loading.value && hasSession.value);
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
  if (!hasSession.value) {
    message.warning('请先创建串口会话');
    return;
  }
  loading.value = true;
  result.value = null;
  try {
    const response = await invokeWithTimeout<TerminalAiResponse>('terminal_ai_assist', {
      request: {
        prompt: prompt.value.trim(),
        apiKey: appStore.aiApiKey,
        model: props.bridge.terminalAiModel.value,
        enableCodingPlan: appStore.aiEnableCodingPlan,
        shell: 'linux/busybox',
      },
    }, AI_INVOKE_TIMEOUT_MS);
    result.value = response;
    if (response.command) {
      if (response.risk === 'caution') {
        cautionPendingCommand.value = response.command;
        showCautionConfirm.value = true;
      } else if (response.risk === 'safe') {
        applyCommandToApp(response.command);
      }
    }
  } catch (e: unknown) {
    message.error(getAiErrorMessage(e, 'AI 命令生成失败'));
  } finally {
    loading.value = false;
  }
}

function confirmCautionCommand() {
  showCautionConfirm.value = false;
  applyCommandToApp(cautionPendingCommand.value);
}

async function copyCommand() {
  if (!result.value?.command) return;
  try {
    await navigator.clipboard.writeText(result.value.command);
    message.success('命令已复制');
  } catch (err) {
    console.debug('clipboard copy failed:', err);
    message.error('复制失败');
  }
}

function applyCommand() {
  if (!result.value?.command) return;
  if (result.value.risk === 'caution') {
    cautionPendingCommand.value = result.value.command;
    showCautionConfirm.value = true;
    return;
  }
  applyCommandToApp(result.value.command);
}

function applyCommandToApp(command: string) {
  void props.bridge.applyCommand(command);
  emit('applyCommand', command);
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
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: var(--radius-lg);
  background: rgba(255, 255, 255, 0.025);
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
  padding: 10px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.022);
  animation: slide-in var(--transition-normal);
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
  padding: 6px 8px;
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.28);
  word-break: break-all;
  white-space: pre-wrap;
  max-height: 120px;
  overflow-y: auto;
  border: 1px solid rgba(76, 175, 80, 0.1);
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
  border-color: rgba(255, 95, 95, 0.4);
  background: rgba(244, 67, 54, 0.04);
}

.risk-caution {
  border-color: rgba(255, 194, 87, 0.4);
  background: rgba(255, 152, 0, 0.03);
}

:deep(.ai-model-menu) {
  max-height: 72px;
  overflow-y: auto;
}
</style>
