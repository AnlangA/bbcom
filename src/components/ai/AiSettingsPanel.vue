<template>
  <div class="ai-settings" :class="{ compact }">
    <button class="settings-toggle" type="button" @click="expanded = !expanded">
      <span>AI 设置</span>
      <span class="settings-state">{{ appStore.aiApiKey ? '已配置' : '未配置' }}</span>
    </button>
    <div v-if="expanded" class="settings-body">
      <n-input
        v-model:value="apiKeyDraft"
        type="password"
        size="small"
        show-password-on="click"
        placeholder="Z.ai / ZHIPU API Key"
      />
      <div class="settings-actions">
        <n-switch
          size="small"
          :value="appStore.aiEnableCodingPlan"
          @update:value="appStore.setAiEnableCodingPlan"
        />
        <span class="coding-plan-label">Coding Plan</span>
        <n-button size="tiny" type="primary" :loading="saving" @click="saveApiKey">
          保存 Key
        </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { NButton, NInput, NSwitch, useMessage } from 'naive-ui';
import { useAppStore } from '../../stores/app';

defineProps<{
  compact?: boolean;
}>();

const appStore = useAppStore();
const message = useMessage();
const expanded = ref(!appStore.aiApiKey);
const apiKeyDraft = ref(appStore.aiApiKey);
const saving = ref(false);

watch(
  () => appStore.aiApiKey,
  (value) => {
    apiKeyDraft.value = value;
  },
);

async function saveApiKey() {
  saving.value = true;
  try {
    const ok = await appStore.setAiApiKey(apiKeyDraft.value.trim());
    if (ok) {
      message.success(apiKeyDraft.value.trim() ? 'AI Key 已保存到本地设置' : 'AI Key 已清除');
    } else {
      message.error('AI Key 保存失败');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.ai-settings {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.02);
}

.ai-settings.compact {
  margin: 8px 0 2px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.035);
}

.settings-toggle,
.settings-actions {
  display: flex;
  align-items: center;
}

.settings-toggle {
  width: 100%;
  justify-content: space-between;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.settings-state {
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 500;
}

.settings-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.settings-actions {
  gap: 8px;
}

.coding-plan-label {
  flex: 1;
  color: var(--text-muted);
  font-size: 11px;
}
</style>
