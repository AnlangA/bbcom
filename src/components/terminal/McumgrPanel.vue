<!--
  First-class MCUMgr / SMP client. Protocol work lives in src/lib/mcumgr;
  this panel is the session-owned console for OS/Image/Shell/FS/Settings/Stats.
-->
<template>
  <div class="mcumgr-panel">
    <div class="mc-header">
      <span class="mc-title">{{ t('mcumgr.title') }}</span>
      <span class="mc-status" :class="statusClass">{{ statusText }}</span>
      <n-button size="tiny" :disabled="!mcumgr.busy.value" @click="mcumgr.cancel()">
        {{ t('common.cancel') }}
      </n-button>
      <button class="mc-close" type="button" :title="t('common.close')" @click="emit('close')">
        <X class="icon-sm" />
      </button>
    </div>

    <div class="mc-transport">
      <label>
        {{ t('mcumgr.transport') }}
        <select :value="config.transport" @change="patch({ transport: asTransport($event) })">
          <option value="console">{{ t('mcumgr.transport.console') }}</option>
          <option value="raw-uart">{{ t('mcumgr.transport.raw') }}</option>
        </select>
      </label>
      <label>
        {{ t('mcumgr.smp') }}
        <select
          :value="String(config.smpVersion)"
          @change="patch({ smpVersion: asVersion($event) })"
        >
          <option value="2">v2</option>
          <option value="1">v1</option>
        </select>
      </label>
      <label>
        {{ t('mcumgr.lineLength') }}
        <input
          type="number"
          :value="config.lineLength"
          min="16"
          max="8192"
          @change="patch({ lineLength: asInt($event, 16, 8192) })"
        />
      </label>
      <label>
        {{ t('mcumgr.mtu') }}
        <input
          type="number"
          :value="config.mtu"
          min="64"
          max="65535"
          @change="patch({ mtu: asInt($event, 64, 65535) })"
        />
      </label>
      <label>
        {{ t('mcumgr.timeout') }}
        <input
          type="number"
          :value="config.timeoutMs"
          min="100"
          @change="patch({ timeoutMs: asInt($event, 100, 120000) })"
        />
      </label>
    </div>

    <div class="mc-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab"
        :class="{ active: activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ t(`mcumgr.tab.${tab}`) }}
      </button>
    </div>

    <div class="mc-body scrollbar-thin">
      <section v-if="activeTab === 'os'" class="mc-grid">
        <label>
          {{ t('mcumgr.os.echo') }}
          <input v-model="osEcho" />
        </label>
        <n-button size="tiny" :disabled="disabled" @click="runOsEcho">{{
          t('mcumgr.run')
        }}</n-button>
        <n-button size="tiny" :disabled="disabled" @click="runNamed('tasks', (c) => c.tasks())">
          {{ t('mcumgr.os.tasks') }}
        </n-button>
        <n-button
          size="tiny"
          :disabled="disabled"
          @click="runNamed('mpstat', (c) => c.memoryPools())"
        >
          {{ t('mcumgr.os.mpstat') }}
        </n-button>
        <n-button
          size="tiny"
          :disabled="disabled"
          @click="runNamed('datetime', (c) => c.datetimeGet())"
        >
          {{ t('mcumgr.os.datetime') }}
        </n-button>
        <n-button
          size="tiny"
          :disabled="disabled"
          @click="runNamed('params', (c) => c.parameters())"
        >
          {{ t('mcumgr.os.params') }}
        </n-button>
        <n-button
          size="tiny"
          :disabled="disabled"
          @click="runNamed('info', (c) => c.applicationInfo())"
        >
          {{ t('mcumgr.os.info') }}
        </n-button>
        <n-button
          size="tiny"
          type="error"
          :disabled="disabled"
          @click="confirmRun('reset', t('mcumgr.confirm.reset'), (c) => c.reset())"
        >
          {{ t('mcumgr.os.reset') }}
        </n-button>
      </section>

      <section v-else-if="activeTab === 'image'" class="mc-stack">
        <div class="mc-row">
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('image-state', (c) => c.imageState())"
          >
            {{ t('mcumgr.image.state') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="confirmRun('image-erase', t('mcumgr.confirm.erase'), (c) => c.imageErase())"
          >
            {{ t('mcumgr.image.erase') }}
          </n-button>
          <input v-model="imageHash" :placeholder="t('mcumgr.image.hash')" class="mc-grow" />
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="
              confirmRun('image-test', t('mcumgr.confirm.test'), (c) =>
                c.imageTest(parseHexBytes(imageHash)),
              )
            "
          >
            {{ t('mcumgr.image.test') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="
              confirmRun('image-confirm', t('mcumgr.confirm.confirm'), (c) =>
                c.imageConfirm(parseOptionalHash(imageHash)),
              )
            "
          >
            {{ t('mcumgr.image.confirm') }}
          </n-button>
        </div>
        <div class="mc-row">
          <input ref="imageInput" type="file" hidden @change="onImagePicked" />
          <n-button size="tiny" @click="imageInput?.click()">{{ t('mcumgr.image.pick') }}</n-button>
          <span class="mc-file">{{ imageName || t('mcumgr.image.none') }}</span>
          <n-button
            size="tiny"
            type="primary"
            :disabled="disabled || !imageFile"
            @click="runImageUpload"
          >
            {{ t('mcumgr.image.upload') }}
          </n-button>
        </div>
      </section>

      <section v-else-if="activeTab === 'shell'" class="mc-stack">
        <div class="mc-row">
          <input
            v-model="shellLine"
            class="mc-grow"
            :placeholder="t('mcumgr.shell.placeholder')"
            @keydown.enter="runShell"
          />
          <n-button
            size="tiny"
            type="primary"
            :disabled="disabled || !shellLine.trim()"
            @click="runShell"
          >
            {{ t('mcumgr.run') }}
          </n-button>
        </div>
        <div class="mc-history">
          <button
            v-for="item in config.shellHistory.slice().reverse()"
            :key="item"
            type="button"
            @click="shellLine = item"
          >
            {{ item }}
          </button>
        </div>
      </section>

      <section v-else-if="activeTab === 'fs'" class="mc-stack">
        <input v-model="fsPath" :placeholder="t('mcumgr.fs.path')" />
        <div class="mc-row">
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('fs-status', (c) => c.fsStatus(fsPath))"
          >
            {{ t('mcumgr.fs.status') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('fs-hash', (c) => c.fsHash(fsPath))"
          >
            {{ t('mcumgr.fs.hash') }}
          </n-button>
          <n-button size="tiny" :disabled="disabled" @click="runFsDownload">{{
            t('mcumgr.fs.download')
          }}</n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('fs-close', (c) => c.fsClose())"
          >
            {{ t('mcumgr.fs.close') }}
          </n-button>
        </div>
        <div class="mc-row">
          <input ref="fsInput" type="file" hidden @change="onFsPicked" />
          <n-button size="tiny" @click="fsInput?.click()">{{ t('mcumgr.fs.pick') }}</n-button>
          <span class="mc-file">{{ fsName || t('mcumgr.fs.none') }}</span>
          <n-button size="tiny" :disabled="disabled || !fsFile" @click="runFsUpload">
            {{ t('mcumgr.fs.upload') }}
          </n-button>
        </div>
      </section>

      <section v-else-if="activeTab === 'settings'" class="mc-stack">
        <input v-model="settingName" :placeholder="t('mcumgr.settings.name')" />
        <input v-model="settingValue" :placeholder="t('mcumgr.settings.value')" />
        <div class="mc-row">
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('settings-read', (c) => c.settingsRead(settingName))"
          >
            {{ t('mcumgr.settings.read') }}
          </n-button>
          <n-button size="tiny" :disabled="disabled" @click="runSettingsWrite">
            {{ t('mcumgr.settings.write') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="
              confirmRun('settings-delete', t('mcumgr.confirm.delete'), (c) =>
                c.settingsDelete(settingName),
              )
            "
          >
            {{ t('mcumgr.settings.delete') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('settings-commit', (c) => c.settingsCommit())"
          >
            {{ t('mcumgr.settings.commit') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('settings-load', (c) => c.settingsLoad())"
          >
            {{ t('mcumgr.settings.load') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('settings-save', (c) => c.settingsSave())"
          >
            {{ t('mcumgr.settings.save') }}
          </n-button>
        </div>
      </section>

      <section v-else-if="activeTab === 'stats'" class="mc-stack">
        <input v-model="statsName" :placeholder="t('mcumgr.stats.name')" />
        <div class="mc-row">
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('stats-list', (c) => c.statsList())"
          >
            {{ t('mcumgr.stats.list') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('stats-show', (c) => c.statsShow(statsName))"
          >
            {{ t('mcumgr.stats.show') }}
          </n-button>
        </div>
      </section>

      <section v-else-if="activeTab === 'groups'" class="mc-stack">
        <div class="mc-row">
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('enum-list', (c) => c.enumList())"
          >
            {{ t('mcumgr.enum.list') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('enum-count', (c) => c.enumCount())"
          >
            {{ t('mcumgr.enum.count') }}
          </n-button>
          <n-button
            size="tiny"
            :disabled="disabled"
            @click="runNamed('enum-details', (c) => c.enumDetails())"
          >
            {{ t('mcumgr.enum.details') }}
          </n-button>
        </div>
        <div class="mc-row">
          <input v-model.number="rawGroup" type="number" :placeholder="t('mcumgr.raw.group')" />
          <input v-model.number="rawCommand" type="number" :placeholder="t('mcumgr.raw.command')" />
          <select v-model="rawOp">
            <option value="read">read</option>
            <option value="write">write</option>
          </select>
        </div>
        <textarea v-model="rawPayload" :placeholder="t('mcumgr.raw.payload')" rows="4" />
        <n-button size="tiny" :disabled="disabled" @click="runRaw">{{
          t('mcumgr.raw.execute')
        }}</n-button>
      </section>

      <section v-else class="mc-stack">
        <n-button
          size="tiny"
          type="error"
          :disabled="disabled"
          @click="
            confirmRun('zephyr-erase', t('mcumgr.confirm.zephyr'), (c) => c.zephyrEraseStorage())
          "
        >
          {{ t('mcumgr.zephyr.erase') }}
        </n-button>
      </section>
    </div>

    <pre class="mc-result scrollbar-thin">{{ resultText }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { X } from '@lucide/vue';
import { t } from '../../lib/i18n';
import {
  byteSourceFromBlob,
  encodeRawHexPayload,
  encodeRawJsonPayload,
  parseMcubootImage,
  SMP_OP,
} from '../../lib/mcumgr';
import type { SessionMcumgrController } from '../../composables/useSessionMcumgr';
import type { McumgrClient } from '../../lib/mcumgr';
import type { McumgrClientConfig, McumgrSmpVersion, McumgrTransportMode } from '../../types';

const props = defineProps<{
  sessionId: string;
  config: McumgrClientConfig;
  isConnected: boolean;
  mcumgr: SessionMcumgrController;
}>();
const emit = defineEmits<{ close: [] }>();

const tabs = ['os', 'image', 'shell', 'fs', 'settings', 'stats', 'groups', 'zephyr'] as const;
type Tab = (typeof tabs)[number];

const activeTab = ref<Tab>('os');
const osEcho = ref('hi');
const imageHash = ref('');
const imageFile = ref<File | null>(null);
const imageName = ref('');
const imageInput = ref<HTMLInputElement | null>(null);
const shellLine = ref('');
const fsPath = ref('/');
const fsFile = ref<File | null>(null);
const fsName = ref('');
const fsInput = ref<HTMLInputElement | null>(null);
const settingName = ref('');
const settingValue = ref('');
const statsName = ref('');
const rawGroup = ref(0);
const rawCommand = ref(0);
const rawOp = ref<'read' | 'write'>('read');
const rawPayload = ref('{}');

const disabled = computed(() => !props.isConnected || props.mcumgr.busy.value);
const statusText = computed(() => {
  const status = props.mcumgr.status.value;
  if (status.kind === 'progress') {
    return t('mcumgr.status.progress', {
      action: status.action,
      offset: String(status.offset),
      total: String(status.total),
    });
  }
  if (status.kind === 'busy') return t('mcumgr.status.busy', { action: status.action });
  if (status.kind === 'timeout') return t('mcumgr.status.timeout');
  if (status.kind === 'error') return status.message;
  return t('mcumgr.status.idle');
});
const statusClass = computed(() => `is-${props.mcumgr.status.value.kind}`);
const resultText = computed(() => props.mcumgr.lastResult.value || t('mcumgr.result.empty'));

function patch(next: Partial<McumgrClientConfig>): void {
  props.mcumgr.patchConfig(next);
}

function asTransport(event: Event): McumgrTransportMode {
  return (event.target as HTMLSelectElement).value === 'raw-uart' ? 'raw-uart' : 'console';
}

function asVersion(event: Event): McumgrSmpVersion {
  return (event.target as HTMLSelectElement).value === '1' ? 1 : 2;
}

function asInt(event: Event, min: number, max: number): number {
  const value = Number((event.target as HTMLInputElement).value);
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : min));
}

function show(value: unknown): void {
  props.mcumgr.setResult(formatResult(value));
}

async function runNamed(
  action: string,
  work: (client: McumgrClient) => Promise<unknown>,
): Promise<void> {
  const result = await props.mcumgr.run(action, work);
  if (result !== null) show(result);
}

async function confirmRun(
  action: string,
  message: string,
  work: (client: McumgrClient) => Promise<unknown>,
): Promise<void> {
  if (!window.confirm(message)) return;
  await runNamed(action, work);
}

async function runOsEcho(): Promise<void> {
  await runNamed('echo', (client) => client.echo(osEcho.value));
}

async function runShell(): Promise<void> {
  const line = shellLine.value.trim();
  if (!line) return;
  const result = await props.mcumgr.run('shell', (client) => client.shellExecute(line));
  if (result) {
    props.mcumgr.rememberShell(line);
    show(result);
  }
}

async function runImageUpload(): Promise<void> {
  const file = imageFile.value;
  if (!file) return;
  const info = parseMcubootImage(new Uint8Array(await file.slice(0, 64).arrayBuffer()));
  if (!info.magicOk && !window.confirm(t('mcumgr.confirm.notMcuboot'))) return;
  const result = await props.mcumgr.run('image-upload', (client, signal) =>
    client.imageUpload(byteSourceFromBlob(file), {
      signal,
      onProgress: (offset, total) => props.mcumgr.reportProgress('image-upload', offset, total),
    }),
  );
  if (result) show({ ...result, version: info.version, magicOk: info.magicOk });
}

async function runFsUpload(): Promise<void> {
  const file = fsFile.value;
  if (!file) return;
  const result = await props.mcumgr.run('fs-upload', (client, signal) =>
    client.fsUpload(fsPath.value, byteSourceFromBlob(file), {
      signal,
      onProgress: (offset, total) => props.mcumgr.reportProgress('fs-upload', offset, total),
    }),
  );
  if (result !== null) show({ uploaded: fsPath.value });
}

async function runFsDownload(): Promise<void> {
  const result = await props.mcumgr.run('fs-download', (client, signal) =>
    client.fsDownload(fsPath.value, {
      signal,
      onProgress: (offset, total) => props.mcumgr.reportProgress('fs-download', offset, total),
    }),
  );
  if (result) show({ bytes: result.length, hex: toHex(result.slice(0, 64)) });
}

async function runSettingsWrite(): Promise<void> {
  await runNamed('settings-write', (client) =>
    client.settingsWrite(settingName.value, textOrHex(settingValue.value)),
  );
}

async function runRaw(): Promise<void> {
  const payload = rawPayload.value.trim().startsWith('{')
    ? encodeRawJsonPayload(rawPayload.value)
    : encodeRawHexPayload(rawPayload.value);
  await runNamed('raw', (client) =>
    client.rawExecute({
      group: rawGroup.value,
      command: rawCommand.value,
      op: rawOp.value === 'write' ? SMP_OP.write : SMP_OP.read,
      payload,
    }),
  );
}

function onImagePicked(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  imageFile.value = file;
  imageName.value = file?.name ?? '';
}

function onFsPicked(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  fsFile.value = file;
  fsName.value = file?.name ?? '';
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

function parseOptionalHash(value: string): Uint8Array | undefined {
  return value.trim() ? parseHexBytes(value) : undefined;
}

function textOrHex(value: string): Uint8Array {
  try {
    return parseHexBytes(value);
  } catch {
    return new TextEncoder().encode(value);
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function formatResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return toHex(value);
  if (value instanceof Map) return JSON.stringify(Object.fromEntries(value), hexReplacer, 2);
  return JSON.stringify(value, hexReplacer, 2);
}

function hexReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return toHex(value);
  return value;
}
</script>

<style scoped>
.mcumgr-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 8px;
  padding: 8px 10px;
}
.mc-header,
.mc-transport,
.mc-row,
.mc-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mc-title {
  font-weight: 600;
}
.mc-status {
  flex: 1;
  font-size: 12px;
  color: var(--text-muted);
}
.mc-status.is-error,
.mc-status.is-timeout {
  color: var(--color-error);
}
.mc-close {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.mc-transport label,
.mc-grid label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.mc-transport input,
.mc-body input,
.mc-body select,
.mc-body textarea {
  background: var(--bg-secondary);
  color: inherit;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 2px 6px;
}
.mc-tabs button {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px 8px;
}
.mc-tabs button.active {
  color: var(--text-primary);
  border-bottom: 2px solid var(--color-primary);
}
.mc-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.mc-grid,
.mc-stack {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.mc-stack {
  flex-direction: column;
  align-items: stretch;
}
.mc-grow {
  flex: 1;
}
.mc-file {
  font-size: 12px;
  color: var(--text-muted);
}
.mc-history {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mc-history button {
  font-size: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: inherit;
  border-radius: 4px;
  cursor: pointer;
}
.mc-result {
  margin: 0;
  min-height: 88px;
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
  background: var(--bg-secondary);
  padding: 8px;
  border-radius: 6px;
}
</style>
