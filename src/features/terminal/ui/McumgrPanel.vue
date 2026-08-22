<!--
  First-class MCUMgr / SMP client. The protocol runs in the Rust command layer
  (mcumgr-toolkit); this panel is the session-owned console for
  OS/Image/Shell/FS/Settings/Stats. Operations yield the serial port to Rust
  and restore the connection afterwards, so they also work while disconnected.
-->
<template>
  <div class="mcumgr-panel" :class="{ 'is-busy': busy }">
    <div class="mc-chrome">
      <div class="mc-brand">
        <Cpu class="icon-sm" />
        <span class="mc-title">{{ t('mcumgr.title') }}</span>
        <span
          class="mc-status"
          :class="statusClass"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span class="mc-status-dot" aria-hidden="true" />
          <span class="mc-status-text">{{ statusText }}</span>
        </span>
      </div>
      <div class="mc-chrome-actions">
        <IconActionButton
          :label="t('mcumgr.settingsToggle')"
          toggleable
          :active="settingsOpen"
          @click="settingsOpen = !settingsOpen"
        >
          <Settings2 class="icon-sm" />
        </IconActionButton>
        <n-button v-if="busy" size="tiny" type="warning" secondary @click="mcumgr.cancel()">
          {{ t('common.cancel') }}
        </n-button>
        <IconActionButton :label="t('common.close')" @click="emit('close')">
          <X class="icon-sm" />
        </IconActionButton>
      </div>
    </div>

    <Transition name="mc-settings">
      <div v-if="settingsOpen" class="mc-config-bar">
        <n-checkbox
          :checked="config.autoFrameSize"
          size="small"
          @update:checked="(v) => patch({ autoFrameSize: v })"
        >
          {{ t('mcumgr.autoFrame') }}
        </n-checkbox>
        <label class="mc-field">
          <span class="mc-field-label">{{ t('mcumgr.frameSize') }}</span>
          <n-input-number
            :value="config.frameSize"
            size="tiny"
            :min="64"
            :max="65535"
            :show-button="false"
            :disabled="config.autoFrameSize"
            :aria-label="t('mcumgr.frameSize')"
            style="width: var(--control-w-sm)"
            @update:value="(v) => patch({ frameSize: clampInt(v, 64, 65535, config.frameSize) })"
          />
        </label>
        <label class="mc-field">
          <span class="mc-field-label">{{ t('mcumgr.timeout') }}</span>
          <n-input-number
            :value="config.timeoutMs"
            size="tiny"
            :min="100"
            :max="120000"
            :step="100"
            :show-button="false"
            :aria-label="t('mcumgr.timeout')"
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
            size="tiny"
            :min="0"
            :max="16"
            :show-button="false"
            :aria-label="t('mcumgr.retries')"
            style="width: var(--control-w-xs)"
            @update:value="(v) => patch({ retries: clampInt(v, 0, 16, config.retries) })"
          />
        </label>
      </div>
    </Transition>

    <div v-if="progressPercent !== null" class="mc-progress-bar">
      <n-progress
        type="line"
        :percentage="progressPercent"
        :show-indicator="true"
        :height="5"
        :border-radius="3"
        processing
      />
    </div>

    <div v-if="busy" class="mc-banner is-yield" role="status">
      {{ yieldBannerText }}
    </div>
    <div v-else-if="!isConnected" class="mc-banner is-offline" role="status">
      {{ t('mcumgr.offlineOk') }}
    </div>

    <div class="mc-workspace">
      <div class="mc-main">
        <div class="mc-tabs" role="tablist">
          <button
            v-for="tab in tabDefs"
            :key="tab.id"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >
            <component :is="tab.icon" class="icon-sm" aria-hidden="true" />
            <span>{{ t(`mcumgr.tab.${tab.id}`) }}</span>
          </button>
        </div>

        <div class="mc-body scrollbar-thin">
          <section v-if="activeTab === 'os'" class="mc-section">
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.os.echo') }}</header>
              <div class="mc-row">
                <n-input
                  v-model:value="osEcho"
                  size="tiny"
                  :disabled="busy"
                  class="mc-grow"
                  @keydown.enter="runOsEcho"
                />
                <n-button size="tiny" type="primary" :disabled="busy" @click="runOsEcho">
                  {{ t('mcumgr.run') }}
                </n-button>
              </div>
            </article>
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.group.query') }}</header>
              <div class="mc-actions">
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('tasks', { kind: 'os-tasks' })"
                >
                  {{ t('mcumgr.os.tasks') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('mpstat', { kind: 'os-memory-pools' })"
                >
                  {{ t('mcumgr.os.mpstat') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('datetime', { kind: 'os-datetime' })"
                >
                  {{ t('mcumgr.os.datetime') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('params', { kind: 'os-params' })"
                >
                  {{ t('mcumgr.os.params') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('info', { kind: 'os-info', format: null })"
                >
                  {{ t('mcumgr.os.info') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('bootloader', { kind: 'os-bootloader-info' })"
                >
                  {{ t('mcumgr.os.bootloader') }}
                </n-button>
              </div>
            </article>
            <article class="mc-card is-danger">
              <header class="mc-card-head">{{ t('mcumgr.group.danger') }}</header>
              <div class="mc-actions">
                <n-button
                  size="tiny"
                  type="error"
                  secondary
                  :disabled="busy"
                  @click="
                    confirmRun('reset', t('mcumgr.confirm.reset'), {
                      kind: 'os-reset',
                      force: false,
                    })
                  "
                >
                  {{ t('mcumgr.os.reset') }}
                </n-button>
              </div>
            </article>
          </section>

          <section v-else-if="activeTab === 'image'" class="mc-section">
            <article class="mc-card is-primary">
              <header class="mc-card-head">{{ t('mcumgr.group.update') }}</header>
              <p class="mc-card-copy">{{ t('mcumgr.image.updateHint') }}</p>
              <div class="mc-row">
                <n-button size="small" type="primary" :disabled="busy" @click="runFirmwareUpdate">
                  <template #icon><Upload class="icon-sm" /></template>
                  {{ t('mcumgr.image.update') }}
                </n-button>
                <n-button size="tiny" secondary :disabled="busy" @click="runImageUpload">
                  {{ t('mcumgr.image.upload') }}
                </n-button>
                <n-checkbox v-model:checked="upgradeOnly" size="small" :disabled="busy">
                  {{ t('mcumgr.image.upgradeOnly') }}
                </n-checkbox>
              </div>
            </article>
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.group.inspect') }}</header>
              <div class="mc-actions">
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('image-state', { kind: 'image-state' })"
                >
                  {{ t('mcumgr.image.state') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('slot-info', { kind: 'image-slot-info' })"
                >
                  {{ t('mcumgr.image.slotInfo') }}
                </n-button>
                <n-button
                  size="tiny"
                  type="error"
                  secondary
                  :disabled="busy"
                  @click="
                    confirmRun('image-erase', t('mcumgr.confirm.erase'), {
                      kind: 'image-erase',
                      slot: null,
                    })
                  "
                >
                  {{ t('mcumgr.image.erase') }}
                </n-button>
              </div>
            </article>
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.group.boot') }}</header>
              <div class="mc-row">
                <n-input
                  v-model:value="imageHash"
                  size="tiny"
                  :placeholder="t('mcumgr.image.hash')"
                  :disabled="busy"
                  class="mc-grow"
                />
                <n-button size="tiny" secondary :disabled="busy" @click="runImageTest">
                  {{ t('mcumgr.image.test') }}
                </n-button>
                <n-button size="tiny" secondary :disabled="busy" @click="runImageConfirm">
                  {{ t('mcumgr.image.confirm') }}
                </n-button>
              </div>
            </article>
          </section>

          <section v-else-if="activeTab === 'shell'" class="mc-section">
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.tab.shell') }}</header>
              <div class="mc-row">
                <n-input
                  v-model:value="shellLine"
                  size="tiny"
                  class="mc-grow"
                  :placeholder="t('mcumgr.shell.placeholder')"
                  :disabled="busy"
                  @keydown.enter="runShell"
                />
                <n-button
                  size="tiny"
                  type="primary"
                  :disabled="busy || !shellLine.trim()"
                  @click="runShell"
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
            </article>
          </section>

          <section v-else-if="activeTab === 'fs'" class="mc-section">
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.fs.path') }}</header>
              <div class="mc-row">
                <n-input
                  v-model:value="fsPath"
                  size="tiny"
                  class="mc-grow"
                  :placeholder="t('mcumgr.fs.path')"
                  :disabled="busy"
                />
              </div>
              <div class="mc-actions">
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy || !fsPath.trim()"
                  @click="run('fs-status', { kind: 'fs-status', path: fsPath.trim() })"
                >
                  {{ t('mcumgr.fs.status') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy || !fsPath.trim()"
                  @click="run('fs-hash', { kind: 'fs-hash', path: fsPath.trim() })"
                >
                  {{ t('mcumgr.fs.hash') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy || !fsPath.trim()"
                  @click="runFsDownload"
                >
                  <template #icon><Download class="icon-sm" /></template>
                  {{ t('mcumgr.fs.download') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy || !fsPath.trim()"
                  @click="runFsUpload"
                >
                  <template #icon><Upload class="icon-sm" /></template>
                  {{ t('mcumgr.fs.upload') }}
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="busy"
                  @click="run('fs-close', { kind: 'fs-close' })"
                >
                  {{ t('mcumgr.fs.close') }}
                </n-button>
              </div>
            </article>
          </section>

          <section v-else-if="activeTab === 'settings'" class="mc-section">
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.group.key') }}</header>
              <div class="mc-row">
                <n-input
                  v-model:value="settingName"
                  size="tiny"
                  class="mc-grow"
                  :placeholder="t('mcumgr.settings.name')"
                  :disabled="busy"
                />
                <n-input
                  v-model:value="settingValue"
                  size="tiny"
                  class="mc-grow"
                  :placeholder="t('mcumgr.settings.value')"
                  :disabled="busy"
                />
              </div>
              <div class="mc-actions">
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy || !settingName.trim()"
                  @click="run('settings-read', { kind: 'settings-read', name: settingName.trim() })"
                >
                  {{ t('mcumgr.settings.read') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy || !settingName.trim()"
                  @click="runSettingsWrite"
                >
                  {{ t('mcumgr.settings.write') }}
                </n-button>
                <n-button
                  size="tiny"
                  type="error"
                  secondary
                  :disabled="busy || !settingName.trim()"
                  @click="
                    confirmRun('settings-delete', t('mcumgr.confirm.delete'), {
                      kind: 'settings-delete',
                      name: settingName.trim(),
                    })
                  "
                >
                  {{ t('mcumgr.settings.delete') }}
                </n-button>
              </div>
            </article>
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.group.persist') }}</header>
              <div class="mc-actions">
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('settings-commit', { kind: 'settings-commit' })"
                >
                  {{ t('mcumgr.settings.commit') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('settings-load', { kind: 'settings-load' })"
                >
                  {{ t('mcumgr.settings.load') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('settings-save', { kind: 'settings-save' })"
                >
                  {{ t('mcumgr.settings.save') }}
                </n-button>
              </div>
            </article>
          </section>

          <section v-else-if="activeTab === 'stats'" class="mc-section">
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.tab.stats') }}</header>
              <div class="mc-row">
                <n-input
                  v-model:value="statsName"
                  size="tiny"
                  class="mc-grow"
                  :placeholder="t('mcumgr.stats.name')"
                  :disabled="busy"
                />
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('stats-list', { kind: 'stats-list' })"
                >
                  {{ t('mcumgr.stats.list') }}
                </n-button>
                <n-button
                  size="tiny"
                  type="primary"
                  :disabled="busy || !statsName.trim()"
                  @click="run('stats-show', { kind: 'stats-show', name: statsName.trim() })"
                >
                  {{ t('mcumgr.stats.show') }}
                </n-button>
              </div>
            </article>
          </section>

          <section v-else-if="activeTab === 'groups'" class="mc-section">
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.group.enum') }}</header>
              <div class="mc-actions">
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('enum-list', { kind: 'enum-list' })"
                >
                  {{ t('mcumgr.enum.list') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('enum-count', { kind: 'enum-count' })"
                >
                  {{ t('mcumgr.enum.count') }}
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  :disabled="busy"
                  @click="run('enum-details', { kind: 'enum-details' })"
                >
                  {{ t('mcumgr.enum.details') }}
                </n-button>
              </div>
            </article>
            <article class="mc-card">
              <header class="mc-card-head">{{ t('mcumgr.group.raw') }}</header>
              <div class="mc-row">
                <n-input-number
                  v-model:value="rawGroup"
                  size="tiny"
                  :min="0"
                  :max="65535"
                  :show-button="false"
                  :placeholder="t('mcumgr.raw.group')"
                  :aria-label="t('mcumgr.raw.group')"
                  :disabled="busy"
                  style="width: var(--control-w-sm)"
                />
                <n-input-number
                  v-model:value="rawCommand"
                  size="tiny"
                  :min="0"
                  :max="255"
                  :show-button="false"
                  :placeholder="t('mcumgr.raw.command')"
                  :aria-label="t('mcumgr.raw.command')"
                  :disabled="busy"
                  style="width: var(--control-w-sm)"
                />
                <AppSelect
                  :value="rawOp"
                  :options="rawOpOptions"
                  size="tiny"
                  :aria-label="t('mcumgr.raw.execute')"
                  style="width: var(--control-w-sm)"
                  @update:value="(v) => (rawOp = v)"
                />
              </div>
              <n-input
                v-model:value="rawPayload"
                type="textarea"
                size="tiny"
                :rows="4"
                :placeholder="t('mcumgr.raw.payload')"
                :disabled="busy"
                class="mc-raw-payload"
              />
              <n-button size="tiny" type="primary" :disabled="busy" @click="runRaw">
                {{ t('mcumgr.raw.execute') }}
              </n-button>
            </article>
          </section>

          <section v-else class="mc-section">
            <article class="mc-card is-danger">
              <header class="mc-card-head">{{ t('mcumgr.group.danger') }}</header>
              <p class="mc-card-copy">{{ t('mcumgr.zephyr.eraseHint') }}</p>
              <div class="mc-actions">
                <n-button
                  size="tiny"
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
            </article>
          </section>
        </div>
      </div>

      <aside class="mc-result-panel">
        <div class="mc-result-header">
          <span class="mc-result-title">{{ t('mcumgr.result.title') }}</span>
          <IconActionButton
            :label="t('mcumgr.result.copy')"
            :disabled="!hasResult"
            @click="copyResult"
          >
            <Copy class="icon-sm" />
          </IconActionButton>
          <IconActionButton
            :label="t('common.clear')"
            :disabled="!hasResult"
            @click="mcumgr.setResult('')"
          >
            <Eraser class="icon-sm" />
          </IconActionButton>
        </div>
        <div v-if="!hasResult" class="mc-result-empty">
          <span class="mc-result-empty-mark" aria-hidden="true">{ }</span>
          <p>{{ t('mcumgr.result.empty') }}</p>
        </div>
        <pre v-else class="mc-result scrollbar-thin">{{ mcumgr.lastResult.value }}</pre>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMessage, NButton, NCheckbox, NInput, NInputNumber, NProgress } from 'naive-ui';
import {
  Activity,
  BarChart3,
  Copy,
  Cpu,
  Download,
  Eraser,
  FolderTree,
  Layers,
  Package,
  Settings2,
  SlidersHorizontal,
  TerminalSquare,
  Upload,
  X,
  Zap,
} from '@lucide/vue';
import AppSelect from '@/design-system/AppSelect.vue';
import IconActionButton from '@/design-system/IconActionButton.vue';
import { t } from '@/lib/i18n';
import { getMcumgrActionLabel } from '@/lib/mcumgr-error';
import { bytesToBase64 } from '@/lib/base64';
import { formatBytes } from '@/lib/format';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';
import type { McumgrOp } from '@/generated/ipc-contracts';
import type { McumgrClientConfig } from '@/types';

const props = defineProps<{
  sessionId: string;
  config: McumgrClientConfig;
  isConnected: boolean;
  mcumgr: SessionMcumgrController;
}>();
const emit = defineEmits<{ close: [] }>();

const message = useMessage();

const tabDefs = [
  { id: 'os', icon: Activity },
  { id: 'image', icon: Package },
  { id: 'shell', icon: TerminalSquare },
  { id: 'fs', icon: FolderTree },
  { id: 'settings', icon: SlidersHorizontal },
  { id: 'stats', icon: BarChart3 },
  { id: 'groups', icon: Layers },
  { id: 'zephyr', icon: Zap },
] as const;
type Tab = (typeof tabDefs)[number]['id'];

const activeTab = ref<Tab>('os');
const settingsOpen = ref(false);
const osEcho = ref('hi');
const imageHash = ref('');
const upgradeOnly = ref(false);
const shellLine = ref('');
const fsPath = ref('/');
const settingName = ref('');
const settingValue = ref('');
const statsName = ref('');
const rawGroup = ref(0);
const rawCommand = ref(0);
const rawOp = ref<'read' | 'write'>('read');
const rawPayload = ref('{}');

const rawOpOptions = computed(() => [
  { label: t('mcumgr.raw.read'), value: 'read' as const },
  { label: t('mcumgr.raw.write'), value: 'write' as const },
]);

const busy = computed(() => props.mcumgr.busy.value);
const yieldBannerText = computed(() => {
  const status = props.mcumgr.status.value;
  if (status.kind === 'progress' || status.kind === 'busy') {
    return t('mcumgr.portYield');
  }
  return t('mcumgr.portResume');
});
const hasResult = computed(() => props.mcumgr.lastResult.value.length > 0);
const statusText = computed(() => {
  const status = props.mcumgr.status.value;
  if (status.kind === 'progress') {
    let text = t('mcumgr.status.busy', { action: getMcumgrActionLabel(status.action) });
    text += ` — ${t(`mcumgr.phase.${status.phase}`)}`;
    if (status.detail) text += ` ${status.detail}`;
    if (status.offset !== undefined && status.total !== undefined && status.total > 0) {
      const percent = Math.floor((status.offset / status.total) * 100);
      text += ` ${formatBytes(status.offset)}/${formatBytes(status.total)} (${percent}%)`;
    }
    return text;
  }
  if (status.kind === 'busy') {
    return t('mcumgr.status.busy', { action: getMcumgrActionLabel(status.action) });
  }
  if (status.kind === 'timeout') return t('mcumgr.status.timeout');
  if (status.kind === 'error') return status.message;
  return t('mcumgr.status.idle');
});
const statusClass = computed(() => `is-${props.mcumgr.status.value.kind}`);
const progressPercent = computed(() => {
  const status = props.mcumgr.status.value;
  if (status.kind !== 'progress') return null;
  if (status.offset === undefined || status.total === undefined || status.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((status.offset / status.total) * 100)));
});

function patch(next: Partial<McumgrClientConfig>): void {
  props.mcumgr.patchConfig(next);
}

function clampInt(value: number | null, min: number, max: number, fallback: number): number {
  if (value === null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function run(action: string, op: McumgrOp): Promise<void> {
  await props.mcumgr.execute(action, op);
}

async function confirmRun(action: string, confirmMessage: string, op: McumgrOp): Promise<void> {
  if (!window.confirm(confirmMessage)) return;
  await run(action, op);
}

async function runOsEcho(): Promise<void> {
  await run('echo', { kind: 'os-echo', message: osEcho.value });
}

async function runImageTest(): Promise<void> {
  const hash = imageHash.value.trim();
  if (!hash) return;
  if (!window.confirm(t('mcumgr.confirm.test'))) return;
  await run('image-test', { kind: 'image-test', hashHex: hash });
}

async function runImageConfirm(): Promise<void> {
  if (!window.confirm(t('mcumgr.confirm.confirm'))) return;
  const hash = imageHash.value.trim();
  await run('image-confirm', { kind: 'image-confirm', hashHex: hash ? hash : null });
}

async function runFirmwareUpdate(): Promise<void> {
  const pick = await props.mcumgr.pickFile('firmware');
  if (!pick) return;
  const confirmMessage = t('mcumgr.confirm.update', {
    name: pick.displayName,
    size: formatBytes(pick.sizeBytes),
  });
  if (!window.confirm(confirmMessage)) return;
  await props.mcumgr.firmwareUpdate(pick.token, { upgradeOnly: upgradeOnly.value });
}

async function runImageUpload(): Promise<void> {
  const pick = await props.mcumgr.pickFile('firmware');
  if (!pick) return;
  const confirmMessage = t('mcumgr.confirm.upload', {
    name: pick.displayName,
    size: formatBytes(pick.sizeBytes),
  });
  if (!window.confirm(confirmMessage)) return;
  await props.mcumgr.imageUpload(pick.token, upgradeOnly.value);
}

async function runShell(): Promise<void> {
  const line = shellLine.value.trim();
  if (!line) return;
  const result = await props.mcumgr.execute('shell', { kind: 'shell', line });
  if (result !== null) props.mcumgr.rememberShell(line);
}

async function runFsUpload(): Promise<void> {
  const remotePath = fsPath.value.trim();
  if (!remotePath) return;
  const pick = await props.mcumgr.pickFile('fs-upload');
  if (!pick) return;
  await props.mcumgr.fsUpload(pick.token, remotePath);
}

async function runFsDownload(): Promise<void> {
  const remotePath = fsPath.value.trim();
  if (!remotePath) return;
  const suggested = remotePath.split('/').filter(Boolean).pop() ?? 'download.bin';
  const pick = await props.mcumgr.pickSaveTarget(suggested);
  if (!pick) return;
  await props.mcumgr.fsDownload(remotePath, pick.token);
}

async function runSettingsWrite(): Promise<void> {
  const name = settingName.value.trim();
  if (!name) return;
  await run('settings-write', {
    kind: 'settings-write',
    name,
    valueB64: bytesToBase64(textOrHex(settingValue.value)),
  });
}

async function runRaw(): Promise<void> {
  const payload = rawPayload.value.trim();
  const op: McumgrOp = payload.startsWith('{')
    ? {
        kind: 'raw',
        group: rawGroup.value ?? 0,
        command: rawCommand.value ?? 0,
        write: rawOp.value === 'write',
        payloadJson: payload,
        payloadB64: null,
      }
    : {
        kind: 'raw',
        group: rawGroup.value ?? 0,
        command: rawCommand.value ?? 0,
        write: rawOp.value === 'write',
        payloadJson: null,
        payloadB64: payload ? bytesToBase64(parseHexBytes(payload)) : null,
      };
  await run('raw', op);
}

async function copyResult(): Promise<void> {
  const text = props.mcumgr.lastResult.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    message.success(t('mcumgr.result.copied'));
  } catch {
    message.error(t('mcumgr.result.copyFailed'));
  }
}

function parseHexBytes(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 2 !== 0) throw new RangeError('hash must be hex');
  const bytes = new Uint8Array(compact.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function textOrHex(value: string): Uint8Array {
  try {
    return parseHexBytes(value);
  } catch {
    return new TextEncoder().encode(value);
  }
}
</script>

<style scoped>
.mcumgr-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-inset);
}

.mc-chrome {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: linear-gradient(180deg, var(--surface-lift), transparent), var(--bg-secondary);
  box-shadow: var(--shadow-inset);
  flex-shrink: 0;
}

.mc-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  color: var(--text-muted);
}

.mc-title {
  text-transform: uppercase;
  letter-spacing: 0.55px;
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.mc-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: min(560px, 58vw);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-subtle);
  background: var(--bg-inset);
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs);
  color: var(--text-dim);
}

.mc-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.mc-status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mc-status.is-busy,
.mc-status.is-progress {
  color: var(--accent-blue);
  border-color: color-mix(in srgb, var(--accent-blue) 35%, transparent);
  background: var(--accent-blue-subtle);
}

.mc-status.is-busy .mc-status-dot,
.mc-status.is-progress .mc-status-dot {
  animation: mc-pulse 1.4s ease-out infinite;
}

.mc-status.is-error,
.mc-status.is-timeout {
  color: var(--accent-red);
  border-color: var(--accent-red-border);
  background: var(--accent-red-subtle);
}

.mc-chrome-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.mc-config-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.mc-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mc-field-label,
.mc-card-head,
.mc-result-title {
  font-size: var(--font-size-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
  white-space: nowrap;
}

.mc-progress-bar {
  flex-shrink: 0;
  padding: 6px 10px 4px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-subtle);
}

.mc-banner {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: var(--font-size-2xs);
  font-family: var(--font-mono);
  border-bottom: 1px solid var(--border-subtle);
}

.mc-banner.is-yield {
  color: var(--accent-amber);
  background: var(--accent-amber-subtle);
}

.mc-banner.is-offline {
  color: var(--text-dim);
  background: var(--bg-tertiary);
}

.mc-workspace {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(240px, 0.85fr);
  grid-template-rows: minmax(0, 1fr);
}

.mc-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--border-subtle);
}

.mc-tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 4px 8px 0;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  flex-shrink: 0;
  overflow-x: auto;
}

.mc-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  padding: 7px 10px;
  font-size: var(--font-size-sm);
  font-weight: 500;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.mc-tabs button:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.mc-tabs button.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary-subtle) 70%, transparent);
}

.mc-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px;
}

.mc-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mc-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: linear-gradient(180deg, var(--surface-lift), transparent), var(--bg-secondary);
  box-shadow: var(--shadow-sm);
}

.mc-card.is-primary {
  border-color: var(--color-primary-muted);
  background:
    linear-gradient(180deg, var(--color-primary-subtle), transparent 42%), var(--bg-secondary);
}

.mc-card.is-danger {
  border-color: var(--accent-red-border);
  background:
    linear-gradient(180deg, var(--accent-red-subtle), transparent 48%), var(--bg-secondary);
}

.mc-card-copy {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
  line-height: var(--line-height-normal);
}

.mc-row,
.mc-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  background: var(--bg-inset);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  cursor: pointer;
}

.mc-history button:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--color-primary-muted);
}

.mc-history button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mc-result-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg-secondary);
}

.mc-result-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 4px 12px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.mc-result-title {
  flex: 1;
}

.mc-result-empty {
  flex: 1;
  display: grid;
  place-content: center;
  gap: 8px;
  text-align: center;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
  padding: 24px;
}

.mc-result-empty-mark {
  font-family: var(--font-mono);
  font-size: 28px;
  opacity: 0.35;
  letter-spacing: 2px;
}

.mc-result-empty p {
  margin: 0;
  max-width: 220px;
}

.mc-result {
  margin: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  background: var(--bg-inset);
  color: var(--text-primary);
  padding: 10px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
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

@keyframes mc-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 50%, transparent);
  }
  70% {
    box-shadow: 0 0 0 6px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

@media (max-width: 900px) {
  .mc-workspace {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1.2fr) minmax(160px, 0.8fr);
  }

  .mc-main {
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
  }
}
</style>
