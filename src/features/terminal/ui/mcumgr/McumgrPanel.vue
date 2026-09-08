<!--
  First-class MCUMgr / SMP client. The protocol runs in the Rust command layer
  (mcumgr-toolkit); this panel is the session-owned console for
  OS/Image/Shell/FS/Settings/Stats. Operations yield the serial port to Rust
  and restore the connection afterwards, so they also work while disconnected.
-->
<template>
  <div class="mcumgr-panel" :class="{ 'is-busy': busy }">
    <header class="mc-chrome">
      <div class="mc-brand">
        <span class="mc-brand-icon"><Cpu :size="22" :stroke-width="1.6" /></span>
        <div class="mc-brand-copy">
          <h2>{{ t('mcumgr.title') }}</h2>
          <p>{{ t('mcumgr.subtitle') }}</p>
        </div>
        <span class="mc-status" :class="statusClass" aria-hidden="true">
          <span class="mc-status-dot" aria-hidden="true" />{{
            busy
              ? t('mcumgr.result.running')
              : hasError
                ? t('mcumgr.status.failed')
                : t('mcumgr.status.idle')
          }}
        </span>
      </div>
      <div class="mc-chrome-actions">
        <n-button
          size="small"
          secondary
          :type="settingsOpen ? 'primary' : 'default'"
          :aria-expanded="settingsOpen"
          :aria-controls="uiId + '-settings'"
          @click="settingsOpen = !settingsOpen"
        >
          <template #icon><Settings2 class="icon-sm" /></template>{{ t('mcumgr.settingsToggle') }}
        </n-button>
        <IconActionButton :label="t('common.close')" @click="emit('close')"
          ><X class="icon-sm"
        /></IconActionButton>
      </div>
    </header>

    <Transition name="mc-settings">
      <div v-show="settingsOpen" :id="uiId + '-settings'" class="mc-config-bar">
        <n-checkbox
          :checked="config.autoFrameSize"
          :disabled="busy"
          size="small"
          @update:checked="(v) => patch({ autoFrameSize: v })"
        >
          {{ t('mcumgr.autoFrame') }}
        </n-checkbox>
        <label class="mc-field">
          <span class="mc-field-label">{{ t('mcumgr.frameSize') }}</span>
          <n-input-number
            :value="config.frameSize"
            size="small"
            :min="64"
            :max="65535"
            :show-button="false"
            :disabled="busy || config.autoFrameSize"
            :input-props="{ 'aria-label': t('mcumgr.frameSize') }"
            style="width: var(--control-w-sm)"
            @update:value="(v) => patch({ frameSize: clampInt(v, 64, 65535, config.frameSize) })"
          />
        </label>
        <label class="mc-field">
          <span class="mc-field-label">{{ t('mcumgr.timeout') }}</span>
          <n-input-number
            :value="config.timeoutMs"
            :disabled="busy"
            size="small"
            :min="100"
            :max="120000"
            :step="100"
            :show-button="false"
            :input-props="{ 'aria-label': t('mcumgr.timeout') }"
            style="width: var(--control-w-md)"
            @update:value="(v) => patch({ timeoutMs: clampInt(v, 100, 120000, config.timeoutMs) })"
          >
            <template #suffix>ms</template>
          </n-input-number>
        </label>
        <label class="mc-field">
          <span class="mc-field-label">{{ t('mcumgr.retries') }}</span>
          <n-input-number
            :value="config.retries"
            :disabled="busy"
            size="small"
            :min="0"
            :max="16"
            :show-button="false"
            :input-props="{ 'aria-label': t('mcumgr.retries') }"
            style="width: var(--control-w-xs)"
            @update:value="(v) => patch({ retries: clampInt(v, 0, 16, config.retries) })"
          />
        </label>
      </div>
    </Transition>

    <McumgrActivityStrip
      :busy="busy"
      :has-error="hasError"
      :connected="isConnected"
      :status-text="statusText"
      :percentage="progressPercent"
      @cancel="mcumgr.cancel()"
    />

    <McumgrTabs
      v-model="activeTab"
      :id-prefix="uiId"
      @update:model-value="resultExpanded = false"
    />
    <div class="mc-workspace" :class="{ 'result-expanded': resultExpanded }">
      <div v-show="!resultExpanded" class="mc-main">
        <template v-for="tab in tabDefs" :key="tab.id">
          <div
            v-if="tab.id !== activeTab"
            :id="`${uiId}-panel-${tab.id}`"
            role="tabpanel"
            :aria-labelledby="`${uiId}-tab-${tab.id}`"
            hidden
          ></div>
        </template>
        <div class="mc-page-heading">
          <h3>{{ t(`mcumgr.page.${activeTab}.title`) }}</h3>
          <p>{{ t(`mcumgr.page.${activeTab}.hint`) }}</p>
        </div>
        <div
          :id="`${uiId}-panel-${activeTab}`"
          class="mc-body scrollbar-thin"
          role="tabpanel"
          :aria-labelledby="`${uiId}-tab-${activeTab}`"
          tabindex="0"
        >
          <McumgrSystemTab
            v-if="activeTab === 'os'"
            v-model:echo="osEcho"
            :busy="busy"
            :mcumgr="mcumgr"
          />

          <McumgrImageTab
            v-else-if="activeTab === 'image'"
            v-model:image-hash="imageHash"
            v-model:upgrade-only="upgradeOnly"
            :busy="busy"
            :mcumgr="mcumgr"
          />

          <section v-else-if="activeTab === 'shell'" class="mc-operation-section">
            <McumgrActionCard :title="t('mcumgr.tab.shell')">
              <div class="mc-row">
                <n-input
                  v-model:value="shellLine"
                  size="small"
                  class="mc-grow"
                  :placeholder="t('mcumgr.shell.placeholder')"
                  :input-props="{ 'aria-label': t('mcumgr.shell.placeholder') }"
                  :disabled="busy"
                  @keydown.enter="mcumgr.runShellLine(shellLine)"
                />
                <n-button
                  size="small"
                  type="primary"
                  :disabled="busy || !shellLine.trim()"
                  @click="mcumgr.runShellLine(shellLine)"
                >
                  {{ t('mcumgr.run') }}
                </n-button>
              </div>
              <div v-if="config.shellHistory.length > 0" class="mc-history">
                <button
                  v-for="item in config.shellHistory.slice().reverse()"
                  :key="item"
                  type="button"
                  :disabled="busy"
                  :title="item"
                  @click="shellLine = item"
                >
                  {{ item }}
                </button>
              </div>
            </McumgrActionCard>
          </section>

          <McumgrFileSystemTab
            v-else-if="activeTab === 'fs'"
            v-model:fs-path="fsPath"
            :busy="busy"
            :mcumgr="mcumgr"
          />

          <McumgrConfigTab
            v-else-if="activeTab === 'settings'"
            v-model:setting-name="settingName"
            v-model:setting-value="settingValue"
            :busy="busy"
            :mcumgr="mcumgr"
          />

          <section v-else-if="activeTab === 'stats'" class="mc-operation-section">
            <McumgrActionCard :title="t('mcumgr.tab.stats')">
              <div class="mc-row">
                <n-input
                  v-model:value="statsName"
                  size="small"
                  class="mc-grow"
                  :placeholder="t('mcumgr.stats.name')"
                  :input-props="{ 'aria-label': t('mcumgr.stats.name') }"
                  :disabled="busy"
                />
                <n-button
                  size="small"
                  secondary
                  :disabled="busy"
                  @click="mcumgr.execute('stats-list', { kind: 'stats-list' })"
                >
                  {{ t('mcumgr.stats.list') }}
                </n-button>
                <n-button
                  size="small"
                  type="primary"
                  :disabled="busy || !statsName.trim()"
                  @click="
                    mcumgr.execute('stats-show', { kind: 'stats-show', name: statsName.trim() })
                  "
                >
                  {{ t('mcumgr.stats.show') }}
                </n-button>
              </div>
            </McumgrActionCard>
          </section>

          <section v-else-if="activeTab === 'groups'" class="mc-operation-section">
            <McumgrActionCard :title="t('mcumgr.group.enum')">
              <div class="mc-actions">
                <n-button
                  size="small"
                  secondary
                  :disabled="busy"
                  @click="mcumgr.execute('enum-list', { kind: 'enum-list' })"
                >
                  {{ t('mcumgr.enum.list') }}
                </n-button>
                <n-button
                  size="small"
                  secondary
                  :disabled="busy"
                  @click="mcumgr.execute('enum-count', { kind: 'enum-count' })"
                >
                  {{ t('mcumgr.enum.count') }}
                </n-button>
                <n-button
                  size="small"
                  secondary
                  :disabled="busy"
                  @click="mcumgr.execute('enum-details', { kind: 'enum-details' })"
                >
                  {{ t('mcumgr.enum.details') }}
                </n-button>
              </div>
            </McumgrActionCard>
            <McumgrActionCard :title="t('mcumgr.group.raw')">
              <div class="mc-row">
                <n-input-number
                  v-model:value="rawGroup"
                  size="small"
                  :min="0"
                  :max="65535"
                  :show-button="false"
                  :placeholder="t('mcumgr.raw.group')"
                  :input-props="{ 'aria-label': t('mcumgr.raw.group') }"
                  :disabled="busy"
                  style="width: var(--control-w-sm)"
                />
                <n-input-number
                  v-model:value="rawCommand"
                  size="small"
                  :min="0"
                  :max="255"
                  :show-button="false"
                  :placeholder="t('mcumgr.raw.command')"
                  :input-props="{ 'aria-label': t('mcumgr.raw.command') }"
                  :disabled="busy"
                  style="width: var(--control-w-sm)"
                />
                <AppSelect
                  :value="rawOp"
                  :disabled="busy"
                  :options="rawOpOptions"
                  size="small"
                  :aria-label="t('mcumgr.raw.execute')"
                  style="width: var(--control-w-sm)"
                  @update:value="(v) => (rawOp = v)"
                />
              </div>
              <n-input
                v-model:value="rawPayload"
                type="textarea"
                size="small"
                :rows="4"
                :placeholder="t('mcumgr.raw.payload')"
                :input-props="{ 'aria-label': t('mcumgr.raw.payload') }"
                :disabled="busy"
                class="mc-raw-payload"
              />
              <n-button
                size="small"
                type="primary"
                :disabled="busy"
                @click="mcumgr.runRawOp(rawGroup, rawCommand, rawOp === 'write', rawPayload)"
              >
                {{ t('mcumgr.raw.execute') }}
              </n-button>
            </McumgrActionCard>
          </section>

          <section v-else class="mc-operation-section">
            <McumgrActionCard :title="t('mcumgr.group.danger')" tone="danger">
              <p class="mc-card-copy">{{ t('mcumgr.zephyr.eraseHint') }}</p>
              <div class="mc-actions">
                <n-button
                  size="small"
                  type="error"
                  secondary
                  :disabled="busy"
                  @click="
                    confirmRun('zephyr-erase', t('mcumgr.confirm.zephyr'), {
                      kind: 'zephyr-erase-storage',
                    })
                  "
                >
                  {{ t('mcumgr.zephyr.erase') }}
                </n-button>
              </div>
            </McumgrActionCard>
          </section>
        </div>
      </div>

      <McumgrResultPanel
        v-model:expanded="resultExpanded"
        :result="mcumgr.lastResult.value"
        :busy="busy"
        @clear="mcumgr.setResult('')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { NButton, NCheckbox, NInput, NInputNumber } from 'naive-ui';
import { Cpu, Settings2, X } from '@lucide/vue';
import { computed, ref, useId } from 'vue';
import McumgrActionCard from './McumgrActionCard.vue';
import McumgrResultPanel from './McumgrResultPanel.vue';
import McumgrTabs from './McumgrTabs.vue';
import AppSelect from '@/design-system/AppSelect.vue';
import IconActionButton from '@/design-system/IconActionButton.vue';
import { t } from '@/lib/i18n';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';
import type { McumgrOp } from '@/generated/ipc-contracts';
import type { McumgrClientConfig } from '@/types';
import McumgrConfigTab from './McumgrConfigTab.vue';
import McumgrFileSystemTab from './McumgrFileSystemTab.vue';
import McumgrSystemTab from './McumgrSystemTab.vue';
import McumgrImageTab from './McumgrImageTab.vue';
import McumgrActivityStrip from './McumgrActivityStrip.vue';
import { tabDefs, useMcumgrPanel } from './use-mcumgr-panel';

const props = defineProps<{
  sessionId: string;
  config: McumgrClientConfig;
  isConnected: boolean;
  mcumgr: SessionMcumgrController;
}>();
const emit = defineEmits<{ close: [] }>();

const uiId = useId();
const resultExpanded = ref(false);
const hasError = computed(() => ['error', 'timeout'].includes(props.mcumgr.status.value.kind));

const {
  activeTab,
  settingsOpen,
  osEcho,
  imageHash,
  upgradeOnly,
  shellLine,
  fsPath,
  settingName,
  settingValue,
  statsName,
  rawGroup,
  rawCommand,
  rawOp,
  rawPayload,
  rawOpOptions,
  busy,
  statusText,
  statusClass,
  progressPercent,
} = useMcumgrPanel({
  config: props.config,
  isConnected: props.isConnected,
  mcumgr: props.mcumgr,
});

function patch(next: Partial<McumgrClientConfig>): void {
  props.mcumgr.patchConfig(next);
}

function clampInt(value: number | null, min: number, max: number, fallback: number): number {
  if (value === null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function confirmRun(action: string, confirmMessage: string, op: McumgrOp): Promise<void> {
  if (!window.confirm(confirmMessage)) return;
  await props.mcumgr.execute(action, op);
}
</script>

<style scoped>
.mcumgr-panel {
  container: mcumgr / inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  background: var(--bg-secondary);
}
.mc-chrome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: var(--space-md);
  padding: 18px var(--space-lg) 14px;
}
.mc-brand {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-md);
  min-width: 0;
}
.mc-brand-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 42px;
  height: 42px;
  border: 1px solid var(--color-primary-muted);
  border-radius: var(--radius-lg);
  color: var(--color-primary);
  background: var(--color-primary-subtle);
}
.mc-brand-copy h2 {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.02em;
  color: var(--text-primary);
}
.mc-brand-copy p {
  color: var(--text-muted);
  font-size: var(--font-size-data);
  margin-top: 2px;
}
.mc-status {
  width: 108px;
  flex: 0 0 108px;
  justify-content: center;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
.mc-status-dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: currentColor;
}
.mc-status.is-busy,
.mc-status.is-progress {
  color: var(--color-primary);
  background: var(--color-primary-subtle);
  border-color: var(--color-primary-muted);
}
.mc-status.is-error,
.mc-status.is-timeout {
  color: var(--color-error);
  background: var(--accent-red-subtle);
  border-color: var(--accent-red-border);
}
.mc-chrome-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--space-sm);
}
.mc-config-bar {
  display: flex;
  align-items: center;
  gap: var(--space-lg);
  flex-wrap: wrap;
  flex-shrink: 0;
  padding: var(--space-md) var(--space-lg);
  margin: 0 var(--space-lg) var(--space-md);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-primary);
}
.mc-field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
}
.mc-field-label {
  font-size: var(--font-size-data);
  color: var(--text-secondary);
  white-space: nowrap;
}
.mc-workspace {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.85fr);
  grid-template-rows: minmax(0, 1fr);
  gap: var(--space-lg);
  padding: var(--space-lg);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-app);
}
.mc-workspace.result-expanded {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.mc-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.mc-page-heading {
  display: grid;
  gap: var(--space-xs);
  padding: 2px 2px var(--space-md);
}
.mc-page-heading h3 {
  color: var(--text-primary);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
}
.mc-page-heading p {
  color: var(--text-muted);
  font-size: var(--font-size-data);
  line-height: var(--line-height-normal);
}
.mc-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-right: 3px;
  padding-bottom: 2px;
}
.mc-body:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}
.mc-operation-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}
.mc-card-copy {
  margin: 0;
  font-size: var(--font-size-data);
  color: var(--text-muted);
  line-height: var(--line-height-relaxed);
}
.mc-row,
.mc-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.mc-grow {
  flex: 1;
  min-width: 140px;
}
.mc-raw-payload {
  width: 100%;
  font-family: var(--font-mono);
}
.mc-history {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mc-history button {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-data);
  font-family: var(--font-mono);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 5px 9px;
  cursor: pointer;
}
.mc-history button:hover:not(:disabled) {
  color: var(--color-primary);
  border-color: var(--color-primary-muted);
}
.mc-history button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mc-settings-enter-active,
.mc-settings-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}
.mc-settings-enter-from,
.mc-settings-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@container mcumgr (max-width: 760px) {
  .mc-workspace:not(.result-expanded) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1.2fr) minmax(140px, 0.8fr);
    gap: var(--space-md);
    padding: var(--space-md);
  }
  .mc-brand-icon {
    width: 36px;
    height: 36px;
  }
  .mc-chrome {
    flex-wrap: wrap;
    padding: var(--space-md);
  }
  .mc-config-bar {
    margin-inline: var(--space-md);
  }
}
</style>
