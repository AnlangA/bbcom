<template>
  <n-modal
    :show="show"
    preset="card"
    title="设置"
    :bordered="false"
    :style="{ width: '520px', maxWidth: '92vw' }"
    :mask-closable="true"
    @update:show="onUpdateShow"
  >
    <div class="settings-body">
      <section class="settings-section">
        <div class="section-head">
          <span class="section-title">捕获缓冲</span>
          <span class="section-desc">每个会话保留的最大帧数，超出后自动丢弃最旧的数据。</span>
        </div>
        <div class="section-row">
          <n-input-number
            :value="appStore.maxBufferFrames"
            :min="1000"
            :max="100000"
            :step="1000"
            size="small"
            style="width: 168px"
            @update:value="onBufferChange"
          >
            <template #suffix>帧</template>
          </n-input-number>
          <n-button size="small" quaternary @click="resetBuffer">恢复默认</n-button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <span class="section-title">关于</span>
        </div>
        <dl class="about-grid">
          <div class="about-row">
            <dt>应用</dt>
            <dd>bbcom · 串口调试助手</dd>
          </div>
          <div class="about-row">
            <dt>版本</dt>
            <dd class="mono">{{ APP_VERSION }}</dd>
          </div>
          <div class="about-row">
            <dt>技术栈</dt>
            <dd>Tauri · Rust · Vue 3</dd>
          </div>
          <div class="about-row">
            <dt>主页</dt>
            <dd>
              <a
                class="about-link"
                href="https://github.com/AnlangA/bbcom"
                target="_blank"
                rel="noreferrer"
                >github.com/AnlangA/bbcom</a
              >
            </dd>
          </div>
        </dl>
      </section>
    </div>
    <template #footer>
      <div class="settings-footer">
        <span class="footer-hint">更改会自动保存</span>
        <n-button size="small" type="primary" @click="close">完成</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { NModal, NInputNumber, NButton } from 'naive-ui';
import { useAppStore } from '../../stores/app';
import { APP_VERSION } from '../../lib/version';
import { MAX_FRAMES } from '../../types';

defineProps<{ show: boolean }>();

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>();

const appStore = useAppStore();

function onUpdateShow(value: boolean) {
  emit('update:show', value);
}

function onBufferChange(value: number | null) {
  appStore.setMaxBufferFrames(typeof value === 'number' ? value : MAX_FRAMES);
}

function resetBuffer() {
  appStore.setMaxBufferFrames(MAX_FRAMES);
}

function close() {
  emit('update:show', false);
}
</script>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  padding: var(--space-sm) var(--space-xs);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.section-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.section-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.section-desc {
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  line-height: var(--line-height-normal);
}

.section-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.about-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  margin: 0;
}

.about-row {
  display: grid;
  grid-template-columns: 64px 1fr;
  align-items: baseline;
  gap: var(--space-sm);
  font-size: var(--font-size-base);
}

.about-row dt {
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.about-row dd {
  margin: 0;
  color: var(--text-secondary);
}

.about-row .mono {
  font-family: var(--font-mono);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.about-link {
  color: var(--color-primary);
  text-decoration: none;
  border-bottom: 1px dashed transparent;
  transition: border-color var(--transition-fast);
}

.about-link:hover {
  border-bottom-color: var(--color-primary);
}

.settings-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.footer-hint {
  font-size: var(--font-size-sm);
  color: var(--text-dim);
}
</style>
