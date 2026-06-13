<template>
  <div class="log-assistant">
    <div class="settings-row">
      <div class="field-group">
        <span class="field-label">日志模型</span>
        <n-select
          size="small"
          :value="logAiModel"
          :options="aiModelOptions"
          :menu-props="aiModelMenuProps"
          @update:value="(v: AiModel) => bridge.setLogAiModel(v)"
        />
      </div>
      <div class="field-group">
        <span class="field-label">上下文</span>
        <n-select
          size="small"
          :value="logAiContextMode"
          :options="logContextModeOptions"
          @update:value="(v: LogAiContextMode) => bridge.setLogAiContextMode(v)"
        />
      </div>
      <n-input-number
        v-if="logAiContextMode === 'latest-n-frames'"
        size="small"
        :value="logAiFrameLimit"
        :min="20"
        :max="2000"
        :step="20"
        style="width: 112px"
        @update:value="(v: number | null) => bridge.setLogAiFrameLimit(v ?? 200)"
      />
    </div>

    <div class="message-list">
      <div v-if="logAiMessages.length === 0" class="empty-hint">
        可询问“最近有哪些错误？”、“设备为什么重启？”等问题。
      </div>
      <div
        v-for="item in logAiMessages"
        :key="item.id"
        class="message-item"
        :class="item.role"
      >
        <span class="role">{{ item.role === 'user' ? '我' : 'AI' }}</span>
        <span class="content">{{ item.content }}</span>
      </div>
    </div>

    <div v-if="result" class="result-card">
      <div class="answer">{{ result.answer }}</div>
      <div v-if="result.evidence.length > 0" class="result-section">
        <span class="section-title">依据</span>
        <ul>
          <li v-for="item in result.evidence" :key="item">{{ item }}</li>
        </ul>
      </div>
      <div v-if="result.suggestions.length > 0" class="result-section">
        <span class="section-title">建议</span>
        <ul>
          <li v-for="item in result.suggestions" :key="item">{{ item }}</li>
        </ul>
      </div>
      <n-tag v-if="result.truncated" size="small" type="warning">上下文已截断</n-tag>
    </div>

    <div class="prompt-row">
      <n-input
        v-model:value="prompt"
        size="small"
        :placeholder="hasApiKey ? '输入日志分析问题' : '请先在主页面保存 API Key'"
        :disabled="loading"
        @keydown.enter.prevent="ask"
      />
      <n-button size="small" :disabled="logAiMessages.length === 0" @click="clearMessages">
        清空
      </n-button>
      <n-button size="small" type="primary" :loading="loading" :disabled="!canAsk" @click="ask">
        分析
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NButton, NInput, NInputNumber, NSelect, NTag, useMessage } from 'naive-ui';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/app';
import type { AiModel, LogAiContextMode } from '../../types';
import type { useAiWindowSession } from '../../composables/useAiWindowSession';
import { getAiErrorMessage } from '../../lib/ai-error';
import { aiModelMenuProps, aiModelOptions, logContextModeOptions } from './ai-options';

interface LogAiResponse {
  answer: string;
  evidence: string[];
  suggestions: string[];
  truncated: boolean;
}

const props = defineProps<{
  bridge: ReturnType<typeof useAiWindowSession>;
}>();

const bridge = props.bridge;

const logAiModel = computed(() => bridge.logAiModel.value);
const logAiContextMode = computed(() => bridge.logAiContextMode.value);
const logAiFrameLimit = computed(() => bridge.logAiFrameLimit.value);
const logAiMessages = computed(() => bridge.logAiMessages.value);
const frameCount = computed(() => bridge.frameCount.value);
const portName = computed(() => bridge.portName.value);
const baudRate = computed(() => bridge.baudRate.value);

const appStore = useAppStore();
const message = useMessage();
const prompt = ref('');
const loading = ref(false);
const result = ref<LogAiResponse | null>(null);

const hasApiKey = computed(() => Boolean(appStore.aiApiKey.trim()));
const canAsk = computed(() => prompt.value.trim().length > 0 && !loading.value);

async function ask() {
  if (!canAsk.value) return;
  if (!hasApiKey.value) {
    message.warning('请先保存 API Key');
    return;
  }
  if (frameCount.value === 0) {
    message.warning('当前会话没有串口数据，请先连接串口并接收数据');
    return;
  }
  const question = prompt.value.trim();
  loading.value = true;
  try {
    await bridge.addLogAiMessage({ role: 'user', content: question });
    const response = await invoke<LogAiResponse>('log_ai_assist', {
      request: {
        prompt: question,
        apiKey: appStore.aiApiKey,
        model: bridge.logAiModel.value,
        enableCodingPlan: appStore.aiEnableCodingPlan,
        context: '',
        contextMode: bridge.logAiContextMode.value,
        contextTruncated: false,
        sessionMeta: `${portName.value}, ${baudRate.value} bps, ${frameCount.value} frames`,
      },
    });
    result.value = response;
    await bridge.addLogAiMessage({ role: 'assistant', content: response.answer });
    prompt.value = '';
  } catch (e: unknown) {
    message.error(getAiErrorMessage(e, 'AI 日志分析失败'));
  } finally {
    loading.value = false;
  }
}

function clearMessages() {
  void bridge.clearLogAiMessages();
  result.value = null;
}
</script>

<style scoped>
.log-assistant {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings-row,
.field-group,
.prompt-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-group {
  flex: 1;
  min-width: 0;
}

.field-group .n-select,
.prompt-row .n-input {
  flex: 1;
  min-width: 0;
}

.field-label,
.section-title,
.role {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.role {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  font-size: 10px;
}

.message-list {
  max-height: 128px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.empty-hint {
  color: var(--text-dim);
  font-size: 12px;
}

.message-item {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-lg);
  background: rgba(255, 255, 255, 0.035);
  animation: slide-in var(--transition-normal);
}

.message-item .content {
  min-width: 0;
  word-break: break-word;
  white-space: pre-wrap;
  line-height: 1.5;
}

.message-item.user {
  background: rgba(99, 255, 177, 0.07);
}

.message-item.user .role {
  background: rgba(99, 255, 177, 0.15);
  color: #9fffc7;
}

.message-item.assistant .role {
  background: rgba(79, 195, 255, 0.15);
  color: #74c0fc;
}

.message-item .content,
.answer,
.result-section li {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.result-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: rgba(255, 255, 255, 0.025);
  max-height: 220px;
  overflow-y: auto;
  box-shadow: var(--shadow-sm);
}

.skeleton-row {
  padding: 4px 0;
}

.result-section ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
</style>
