<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('settings.title')"
    :bordered="false"
    :style="{ width: '520px', maxWidth: '92vw' }"
    :mask-closable="true"
    @update:show="onUpdateShow"
  >
    <div class="settings-body">
      <section class="settings-section">
        <div class="section-head">
          <span class="section-title">{{ t('settings.appearance') }}</span>
          <span class="section-desc">{{ t('settings.appearance.desc') }}</span>
        </div>
        <div class="section-row">
          <n-switch :value="appStore.theme === 'light'" size="small" @update:value="setTheme" />
          <span class="row-label">{{ t('settings.lightMode') }}</span>
        </div>
        <div class="section-row">
          <AppSelect
            :value="appStore.locale"
            :options="localeOptions"
            size="small"
            style="width: 160px"
            @update:value="setAppLocale"
          />
          <span class="row-label">{{ t('settings.language') }}</span>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <span class="section-title">{{ t('settings.captureBuffer') }}</span>
          <span class="section-desc">{{ t('settings.captureBuffer.desc') }}</span>
        </div>
        <div class="section-row">
          <n-input-number
            :value="appStore.maxBufferFrames"
            :min="1000"
            :max="100000"
            :step="1000"
            size="small"
            style="width: 160px"
            @update:value="onBufferChange"
          >
            <template #suffix>{{ t('status.frames') }}</template>
          </n-input-number>
          <n-button size="small" quaternary @click="resetBuffer">{{
            t('settings.resetDefault')
          }}</n-button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <span class="section-title">{{ t('settings.connection') }}</span>
          <span class="section-desc">{{ t('settings.connection.desc') }}</span>
        </div>
        <div class="section-row">
          <n-switch v-model:checked="appStore.autoReconnect" size="small" />
          <span class="row-label">{{ t('settings.autoReconnect') }}</span>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-head">
          <span class="section-title">{{ t('settings.about') }}</span>
        </div>
        <dl class="about-grid">
          <div class="about-row">
            <dt>{{ t('settings.app') }}</dt>
            <dd>{{ t('settings.appDescription') }}</dd>
          </div>
          <div class="about-row">
            <dt>{{ t('settings.version') }}</dt>
            <dd class="mono">{{ APP_VERSION }}</dd>
          </div>
          <div class="about-row">
            <dt>{{ t('settings.stack') }}</dt>
            <dd>Tauri · Rust · Vue 3</dd>
          </div>
          <div class="about-row">
            <dt>{{ t('settings.homepage') }}</dt>
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
        <span class="footer-hint">{{ t('settings.savedHint') }}</span>
        <n-button size="small" type="primary" @click="close">{{ t('settings.done') }}</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NModal, NInputNumber, NButton, NSwitch } from 'naive-ui';
import AppSelect from '../ui/AppSelect.vue';
import { useAppStore } from '../../stores/app';
import { APP_VERSION } from '../../lib/version';
import { supportedLocales, t, type Locale } from '../../lib/i18n';
import { MAX_FRAMES } from '../../types';

defineProps<{ show: boolean }>();

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>();

const appStore = useAppStore();
const localeOptions = computed(() => supportedLocales());

function onUpdateShow(value: boolean) {
  emit('update:show', value);
}

function onBufferChange(value: number | null) {
  appStore.setMaxBufferFrames(typeof value === 'number' ? value : MAX_FRAMES);
}

function resetBuffer() {
  appStore.setMaxBufferFrames(MAX_FRAMES);
}

function setTheme(light: boolean) {
  appStore.setTheme(light ? 'light' : 'dark');
}

function setAppLocale(value: Locale) {
  appStore.setLocale(value);
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
  gap: var(--space-2xs);
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

.row-label {
  font-size: var(--font-size-base);
  color: var(--text-secondary);
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
