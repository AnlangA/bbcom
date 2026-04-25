<template>
  <div class="ai-assistant">
    <div class="ai-header">
      <div>
        <div class="ai-title">AI 终端助手</div>
        <div class="ai-subtitle">把自然语言转换为 Linux 串口控制台命令</div>
      </div>
      <n-tag size="small" round type="info">GLM</n-tag>
    </div>

    <div v-if="!hasApiKey" class="api-key-row">
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

    <div class="prompt-row">
      <n-input
        v-model:value="prompt"
        size="small"
        placeholder="例如：查看当前路径、列出文件、查看 IP"
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
        生成命令
      </n-button>
    </div>

    <div v-if="result" class="result-card" :class="`risk-${result.risk}`">
      <div class="result-top">
        <code class="command">{{ result.command || '需要更多信息' }}</code>
        <n-tag size="small" round :type="riskTagType">{{ riskLabel }}</n-tag>
      </div>
      <div class="explanation">{{ result.explanation }}</div>
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
import { NButton, NInput, NTag, useMessage } from 'naive-ui';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/app';

type Risk = 'safe' | 'caution' | 'dangerous';

interface TerminalAiResponse {
  command: string;
  explanation: string;
  risk: Risk;
}

const emit = defineEmits<{
  (e: 'applyCommand', command: string): void;
}>();

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const apiKeyDraft = ref(appStore.aiApiKey);
const loading = ref(false);
const result = ref<TerminalAiResponse | null>(null);

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
        shell: 'linux/busybox',
      },
    });
    result.value = response;
    if (response.command && response.risk !== 'dangerous') {
      emit('applyCommand', response.command);
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
  emit('applyCommand', result.value.command);
}
</script>

<style scoped>
.ai-assistant {
  padding: 12px;
  border: 1px solid rgba(99, 255, 177, 0.22);
  border-radius: 14px;
  background:
    radial-gradient(circle at 0 0, rgba(99, 255, 177, 0.14), transparent 32%),
    linear-gradient(135deg, rgba(18, 26, 32, 0.94), rgba(12, 16, 21, 0.92));
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ai-header,
.prompt-row,
.api-key-row,
.result-top,
.result-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-header,
.result-top {
  justify-content: space-between;
}

.ai-title {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.2px;
}

.ai-subtitle {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11px;
}

.prompt-row .n-input,
.api-key-row .n-input {
  flex: 1;
}

.result-card {
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.035);
}

.command {
  color: var(--accent-green);
  font-family: var(--font-mono);
  font-size: 13px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.26);
  overflow: hidden;
  text-overflow: ellipsis;
}

.explanation {
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.result-actions {
  justify-content: flex-end;
  margin-top: 10px;
}

.risk-dangerous {
  border-color: rgba(255, 95, 95, 0.45);
}

.risk-caution {
  border-color: rgba(255, 194, 87, 0.45);
}
</style>
