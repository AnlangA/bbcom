<template>
  <AppModal :show="show" :title="t('settings.title')" width="min(520px, 92vw)" @close="close">
    <div class="settings-body">
      <SettingsSection
        :title="t('settings.appearance')"
        :description="t('settings.appearance.desc')"
      >
        <div class="section-row">
          <n-switch
            :value="appStore.theme === 'light'"
            size="small"
            :aria-label="t('settings.lightMode')"
            @update:value="setTheme"
          />
          <span class="row-label">{{ t('settings.lightMode') }}</span>
        </div>
        <div class="section-row">
          <AppSelect
            :value="appStore.locale"
            :aria-label="t('settings.language')"
            :options="localeOptions"
            size="small"
            style="width: 160px"
            @update:value="setAppLocale"
          />
          <span class="row-label">{{ t('settings.language') }}</span>
        </div>
      </SettingsSection>

      <SettingsSection
        :title="t('settings.captureBuffer')"
        :description="t('settings.captureBuffer.desc')"
      >
        <div class="section-row">
          <n-input-number
            :value="appStore.maxBufferFrames"
            :min="1000"
            :max="100000"
            :step="1000"
            size="small"
            :aria-label="t('settings.captureBuffer')"
            style="width: 160px"
            @update:value="onBufferChange"
          >
            <template #suffix>{{ t('status.frames') }}</template>
          </n-input-number>
          <n-button size="small" quaternary @click="resetBuffer">{{
            t('settings.resetDefault')
          }}</n-button>
        </div>
      </SettingsSection>

      <SettingsSection
        :title="t('settings.connection')"
        :description="t('settings.connection.desc')"
      >
        <div class="section-row">
          <n-switch
            :value="appStore.autoReconnect"
            size="small"
            :aria-label="t('settings.autoReconnect')"
            @update:value="setAutoReconnect"
          />
          <span class="row-label">{{ t('settings.autoReconnect') }}</span>
        </div>
      </SettingsSection>

      <SettingsSection :title="t('settings.about')">
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
      </SettingsSection>
    </div>
    <template #footer>
      <div class="settings-footer">
        <span
          :key="saveAnnouncementRevision"
          class="footer-hint"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          >{{ t('settings.savedHint') }}</span
        >
        <n-button size="small" type="primary" @click="close">{{ t('settings.done') }}</n-button>
      </div>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NInputNumber, NButton, NSwitch } from 'naive-ui';
import AppSelect from '../ui/AppSelect.vue';
import AppModal from '../ui/AppModal.vue';
import SettingsSection from '../ui/SettingsSection.vue';
import { useAppStore } from '../../stores/app';
import { APP_VERSION } from '../../lib/version';
import { supportedLocales, t, type Locale } from '../../lib/i18n';
import { MAX_FRAMES } from '../../types';

defineProps<{ show: boolean }>();

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>();

const appStore = useAppStore();
const localeOptions = computed(() => supportedLocales());
const saveAnnouncementRevision = ref(0);

function announceSaved(): void {
  saveAnnouncementRevision.value += 1;
}

function onBufferChange(value: number | null) {
  appStore.setMaxBufferFrames(typeof value === 'number' ? value : MAX_FRAMES);
  announceSaved();
}

function resetBuffer() {
  appStore.setMaxBufferFrames(MAX_FRAMES);
  announceSaved();
}

function setTheme(light: boolean) {
  appStore.setTheme(light ? 'light' : 'dark');
  announceSaved();
}

function setAppLocale(value: Locale) {
  appStore.setLocale(value);
  announceSaved();
}

function setAutoReconnect(value: boolean): void {
  appStore.autoReconnect = value;
  announceSaved();
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
