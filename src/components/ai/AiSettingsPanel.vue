<template>
  <div class="ai-settings">
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
        <n-button size="tiny" type="primary" :disabled="!apiKeyDraft.trim()" @click="saveApiKey">
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

const appStore = useAppStore();
const message = useMessage();
const expanded = ref(false);
const apiKeyDraft = ref(appStore.aiApiKey);

watch(() => appStore.aiApiKey, (value) => {
  apiKeyDraft.value = value;
});

function saveApiKey() {
  appStore.setAiApiKey(apiKeyDraft.value.trim());
  message.success('AI Key 已保存到本地设置');
}
</script>

<style scoped>
.ai-settings {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.02);
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
