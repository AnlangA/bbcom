<template>
  <section v-if="service" class="plugin-center" :aria-labelledby="headingId">
    <header class="plugin-center__heading">
      <h2 :id="headingId">{{ t('plugins.title') }}</h2>
      <button type="button" :disabled="busy" @click="refresh">{{ t('common.refresh') }}</button>
    </header>

    <!-- Bootstrap composition failures used to be stderr-only; surface the
         stable code so a broken plugin runtime is diagnosable in-UI. -->
    <p
      v-if="runtimeUnavailable"
      class="plugin-center__error"
      role="alert"
      data-testid="plugin-runtime-unavailable"
    >
      {{ bootstrapMessage }}
    </p>
    <p v-if="snapshot.failure" class="plugin-center__error" role="alert">
      {{ t(`plugins.error.${snapshot.failure.code}`) }}
      <IconActionButton :label="t('common.dismiss')" @click="service.clearFailure()">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </IconActionButton>
    </p>
    <p class="sr-only" role="status" aria-live="polite">{{ statusAnnouncement }}</p>

    <nav class="plugin-center__tabs" role="tablist" :aria-label="t('plugins.title')">
      <button
        v-for="tab in tabs"
        :id="`${headingId}-${tab}`"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab"
        :aria-controls="`${headingId}-${tab}-panel`"
        :tabindex="activeTab === tab ? 0 : -1"
        @click="activeTab = tab"
        @keydown="moveTab(tab, $event)"
      >
        {{ t(`plugins.tab.${tab}`) }}
      </button>
    </nav>

    <div
      v-if="activeTab === 'installed'"
      :id="`${headingId}-installed-panel`"
      role="tabpanel"
      :aria-labelledby="`${headingId}-installed`"
      tabindex="0"
    >
      <EmptyState v-if="snapshot.installed.length === 0" :title="t('plugins.installed.empty')" />
      <ul v-else class="plugin-center__list">
        <li v-for="plugin in snapshot.installed" :key="plugin.pluginId">
          <div>
            <strong>{{ plugin.displayName }}</strong>
            <small>{{ t('plugins.version', { version: plugin.version }) }}</small>
          </div>
          <span>{{ t(`plugins.status.${plugin.status}`) }}</span>
          <div class="plugin-center__row-actions">
            <button
              type="button"
              :disabled="busy || lifecycleBusy(plugin.status)"
              @click="setEnabled(plugin.pluginId, !plugin.enabled)"
            >
              {{ t(plugin.enabled ? 'plugins.disable' : 'plugins.enable') }}
            </button>
            <button
              type="button"
              class="plugin-center__uninstall"
              :disabled="busy || lifecycleBusy(plugin.status)"
              @click="requestUninstall(plugin)"
            >
              {{ t('plugins.uninstall') }}
            </button>
          </div>
        </li>
      </ul>
    </div>

    <div
      v-else-if="activeTab === 'catalog'"
      :id="`${headingId}-catalog-panel`"
      role="tabpanel"
      :aria-labelledby="`${headingId}-catalog`"
      tabindex="0"
    >
      <EmptyState v-if="snapshot.catalog.length === 0" :title="t('plugins.catalog.empty')" />
      <ul v-else class="plugin-center__list">
        <li v-for="item in snapshot.catalog" :key="item.catalogId">
          <div>
            <strong>{{ item.displayName }}</strong>
            <small>{{ item.description }}</small>
            <small>
              {{ item.publisherName }}
            </small>
          </div>
          <button
            type="button"
            :disabled="busy || !catalogActionAvailable(item.version, item.installedVersion)"
            @click="install(item.catalogId)"
          >
            {{ t(catalogActionLabel(item.version, item.installedVersion)) }}
          </button>
        </li>
      </ul>
    </div>

    <div
      v-else-if="activeTab === 'sources'"
      :id="`${headingId}-sources-panel`"
      role="tabpanel"
      :aria-labelledby="`${headingId}-sources`"
      tabindex="0"
      class="plugin-center__sources"
    >
      <p class="plugin-center__trust-warning">
        {{ t('plugins.integrity_warning') }}
      </p>
      <div class="plugin-center__local-install">
        <button type="button" :disabled="busy" @click="installLocal">
          {{ t('plugins.local_install.install') }}
        </button>
        <button type="button" :disabled="busy" @click="installDevDirectory">
          {{ t('plugins.dev_install.install') }}
        </button>
      </div>
      <EmptyState
        v-if="snapshot.sources.length === 0 && !editingSource"
        :title="t('plugins.sources.empty')"
      />
      <div v-else class="plugin-center__source-list">
        <ActionListItem
          v-for="source in snapshot.sources"
          :key="source.sourceId"
          :title="source.displayName"
          :description="source.url ?? t(`plugins.source.kind.${source.kind}`)"
          :meta="t(`plugins.source.health.${source.health}`)"
        >
          <template #actions>
            <label class="plugin-center__source-toggle">
              <input
                type="checkbox"
                :checked="source.enabled"
                :disabled="busy"
                :aria-label="t('plugins.source.enabled')"
                @change="toggleSource(source, $event)"
              />
            </label>
            <IconActionButton
              v-if="source.kind === 'https'"
              :label="t('common.refresh')"
              :disabled="busy"
              @click="service.refreshSource(source.sourceId)"
            >
              <RefreshCw class="icon-sm" />
            </IconActionButton>
            <IconActionButton
              v-if="source.kind === 'https'"
              :label="t('common.edit')"
              :disabled="busy"
              @click="startEditSource(source)"
            >
              <Pencil class="icon-sm" />
            </IconActionButton>
            <IconActionButton
              :label="t('common.delete')"
              :disabled="busy"
              tone="danger"
              @click="requestRemoveSource(source)"
            >
              <Trash2 class="icon-sm" />
            </IconActionButton>
          </template>
        </ActionListItem>
      </div>
      <div v-if="editingSource" class="plugin-center__source-form">
        <input
          v-model.trim="sourceDraft.sourceId"
          type="text"
          :disabled="editingSourceId !== null"
          :placeholder="t('plugins.source.id')"
          :aria-label="t('plugins.source.id')"
        />
        <input
          v-model.trim="sourceDraft.url"
          type="url"
          inputmode="url"
          autocomplete="off"
          :placeholder="t('plugins.source.url')"
          :aria-label="t('plugins.source.url')"
        />
        <InlineEditorActions
          :can-save="sourceDraft.sourceId.length >= 2 && sourceDraft.url.startsWith('https://')"
          :busy="busy"
          @save="saveSource"
          @cancel="cancelSourceEdit"
        />
      </div>
      <button v-else type="button" :disabled="busy" @click="startAddSource">
        {{ t('plugins.source.add') }}
      </button>
    </div>

    <div
      v-else-if="activeTab === 'tasks'"
      :id="`${headingId}-tasks-panel`"
      role="tabpanel"
      :aria-labelledby="`${headingId}-tasks`"
      tabindex="0"
      class="plugin-center__tasks"
    >
      <PluginTaskCenter :tasks="snapshot.tasks ?? []" :busy="busy" @cancel="cancelPluginTask" />
      <PluginCommandList
        :commands="snapshot.commandContributions ?? []"
        :busy="busy"
        @run="runPluginCommand"
      />
    </div>

    <div
      v-else
      :id="`${headingId}-panels-panel`"
      role="tabpanel"
      :aria-labelledby="`${headingId}-panels`"
      tabindex="0"
      class="plugin-center__panels"
    >
      <EmptyState
        v-if="(snapshot.surfaces?.length ?? 0) === 0"
        :title="t('plugins.panels.empty')"
      />
      <PluginSurfaceRenderer
        v-for="surface in snapshot.surfaces ?? []"
        :key="`${surface.runtime.pluginId}:${surface.runtime.instanceId}:${surface.runtime.generation}:${surface.surfaceId}`"
        :surface="surface"
        :busy="busy"
        :confirm-dangerous="confirmDangerousSurfaceAction"
        @event="emitSurfaceEvent"
        @detach="service.setSurfacePlacement(surface, 'detached-window')"
        @attach="service.setSurfacePlacement(surface, 'workspace')"
      />
    </div>

    <button v-if="busy" type="button" class="plugin-center__cancel" @click="service.cancelAction()">
      {{ t(snapshot.action?.status === 'cancelling' ? 'common.cancelling' : 'common.cancel') }}
    </button>

    <PluginAuthorizationDialog
      :request="snapshot.authorizationRequests?.[0] ?? null"
      :busy="busy"
      @resolve="resolveAuthorization"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, getCurrentInstance, h, onMounted, onUnmounted, reactive, ref, useId } from 'vue';
import { useDialog } from 'naive-ui';
import { Pencil, RefreshCw, Trash2 } from '@lucide/vue';
import { t } from '../../lib/i18n';
import EmptyState from '../ui/EmptyState.vue';
import IconActionButton from '../ui/IconActionButton.vue';
import ActionListItem from '../ui/ActionListItem.vue';
import InlineEditorActions from '../ui/InlineEditorActions.vue';
import { logger } from '../../lib/logger';
import {
  useOptionalPluginCenter,
  type InstalledPluginView,
  type PluginCenterSnapshot,
  type PluginAuthorizationRequestV2,
  type PluginCommandContributionV2,
  type PluginContributionDisposition,
  type PluginLifecycleStatus,
  type PluginSurfaceEventV2,
  type PluginTaskViewV2,
  type PluginSourceView,
} from '../../features/plugins';
import PluginSurfaceRenderer from './PluginSurfaceRenderer.vue';
import PluginAuthorizationDialog from './PluginAuthorizationDialog.vue';
import PluginCommandList from './PluginCommandList.vue';
import PluginTaskCenter from './PluginTaskCenter.vue';

type PluginTab = 'installed' | 'catalog' | 'sources' | 'tasks' | 'panels';

const service = useOptionalPluginCenter();
const headingId = `plugin-center-${useId()}`;
const tabs: readonly PluginTab[] = ['installed', 'catalog', 'sources', 'tasks', 'panels'];
const activeTab = ref<PluginTab>('installed');
const snapshot = ref<PluginCenterSnapshot>(service?.snapshot() ?? emptySnapshot());
let detach: (() => void) | null = null;
const editingSource = ref(false);
const editingSourceId = ref<string | null>(null);
const sourceDraft = reactive({ sourceId: '', url: '' });

// The dialog provider is mounted by App.vue; the settings modal can still be
// rendered without it (embedded windows, component tests). Uninstall then stays
// unavailable instead of destroying a plugin without its confirmation step.
const dialog = getCurrentInstance() ? resolveDialog() : null;

function resolveDialog(): ReturnType<typeof useDialog> | null {
  try {
    return useDialog();
  } catch {
    return null;
  }
}

const busy = computed(() => snapshot.value.action !== null);

const runtimeUnavailable = computed(
  () => snapshot.value.runtimeStatus?.available === false && snapshot.value.runtimeStatus?.code,
);

const bootstrapMessage = computed(() => {
  const code = runtimeUnavailable.value;
  if (!code) return '';
  return t('plugins.bootstrap.unavailable', { code });
});
const statusAnnouncement = computed(() => {
  if (snapshot.value.action) return t(`plugins.action.${snapshot.value.action.status}`);
  if (snapshot.value.failure) return t(`plugins.error.${snapshot.value.failure.code}`);
  return t('plugins.ready');
});

onMounted(() => {
  if (!service) return;
  detach = service.subscribe((next) => {
    snapshot.value = next;
  });
});

onUnmounted(() => detach?.());

function refresh(): void {
  void service?.refresh();
}

function emitSurfaceEvent(event: PluginSurfaceEventV2): void {
  void service?.emitSurfaceEvent(event);
}

function resolveAuthorization(
  request: PluginAuthorizationRequestV2,
  decision: 'approve' | 'reject',
): void {
  void service?.resolveAuthorization(request, decision);
}

function cancelPluginTask(task: PluginTaskViewV2): void {
  void service?.cancelTask(task);
}

function runPluginCommand(command: PluginCommandContributionV2): void {
  if (!command.dangerous) {
    void service?.runCommand(command);
    return;
  }
  if (!dialog) return;
  dialog.warning({
    title: t('plugins.commands.confirm_title'),
    content: command.confirmation,
    positiveText: t('plugins.commands.run'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => void service?.runCommand(command),
  });
}

function confirmDangerousSurfaceAction(message: string): Promise<boolean> {
  if (!dialog) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    dialog.warning({
      title: t('plugins.surface.dangerous_title'),
      content: message,
      positiveText: t('plugins.commands.run'),
      negativeText: t('common.cancel'),
      closable: false,
      maskClosable: false,
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
    });
  });
}

function installLocal(): void {
  void service?.installLocal('local-package');
}

function installDevDirectory(): void {
  void service?.installLocal('dev-directory');
}

function startAddSource(): void {
  editingSourceId.value = null;
  sourceDraft.sourceId = '';
  sourceDraft.url = 'https://';
  editingSource.value = true;
}

function startEditSource(source: PluginSourceView): void {
  editingSourceId.value = source.sourceId;
  sourceDraft.sourceId = source.sourceId;
  sourceDraft.url = source.url ?? '';
  editingSource.value = true;
}

function cancelSourceEdit(): void {
  editingSource.value = false;
  editingSourceId.value = null;
}

function saveSource(): void {
  const action = editingSourceId.value
    ? service?.updateSource(editingSourceId.value, sourceDraft.url, true)
    : service?.addSource(sourceDraft.sourceId, sourceDraft.url, true);
  void action?.then(cancelSourceEdit);
}

function toggleSource(source: PluginSourceView, event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked;
  if (source.kind === 'https' && source.url) {
    void service?.updateSource(source.sourceId, source.url, enabled);
  } else if (source.kind === 'dev-directory') {
    void service?.setWatchEnabled(source.sourceId, enabled);
  }
}

function requestRemoveSource(source: PluginSourceView): void {
  if (!dialog) return;
  dialog.warning({
    title: t('plugins.source.remove'),
    content: source.displayName,
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => void service?.removeSource(source.sourceId),
  });
}

function install(catalogId: string): void {
  void service?.install(catalogId);
}

function catalogActionAvailable(version: string, installedVersion: string | null): boolean {
  return installedVersion === null || compareSemver(version, installedVersion) > 0;
}

function catalogActionLabel(version: string, installedVersion: string | null): string {
  if (installedVersion === null) return 'plugins.install';
  return catalogActionAvailable(version, installedVersion)
    ? 'plugins.update'
    : 'plugins.up_to_date';
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(/[-+]/u, 1)[0]?.split('.').map(Number) ?? [];
  const rightParts = right.split(/[-+]/u, 1)[0]?.split('.').map(Number) ?? [];
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return left.localeCompare(right);
}

function requestUninstall(plugin: InstalledPluginView): void {
  if (!dialog) {
    logger.warn('plugin uninstall confirmation is unavailable without a dialog provider');
    return;
  }
  const contributionDisposition = ref<PluginContributionDisposition>('delete');
  const choiceName = `${headingId}-uninstall-${plugin.pluginId}`;
  dialog.warning({
    title: t('plugins.uninstall_confirm.title'),
    content: () =>
      h('div', { class: 'plugin-center__uninstall-confirmation' }, [
        h('p', t('plugins.uninstall_confirm.content', { name: plugin.displayName })),
        h('fieldset', [
          h('legend', t('plugins.uninstall_confirm.contributions.legend')),
          h('label', [
            h('input', {
              type: 'radio',
              name: choiceName,
              value: 'delete',
              checked: contributionDisposition.value === 'delete',
              onChange: () => {
                contributionDisposition.value = 'delete';
              },
            }),
            h('span', [
              h('strong', t('plugins.uninstall_confirm.contributions.delete')),
              h('small', t('plugins.uninstall_confirm.contributions.delete_description')),
            ]),
          ]),
          h('label', [
            h('input', {
              type: 'radio',
              name: choiceName,
              value: 'convert-to-user',
              checked: contributionDisposition.value === 'convert-to-user',
              onChange: () => {
                contributionDisposition.value = 'convert-to-user';
              },
            }),
            h('span', [
              h('strong', t('plugins.uninstall_confirm.contributions.convert')),
              h('small', t('plugins.uninstall_confirm.contributions.convert_description')),
            ]),
          ]),
        ]),
      ]),
    positiveText: t('plugins.uninstall'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => {
      void service?.uninstall(plugin.pluginId, contributionDisposition.value);
    },
  });
}

function setEnabled(pluginId: string, enabled: boolean): void {
  void service?.setEnabled(pluginId, enabled);
}

function moveTab(current: PluginTab, event: KeyboardEvent): void {
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  const directIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
  if (!direction && directIndex === null) return;
  event.preventDefault();
  const nextIndex = directIndex ?? (tabs.indexOf(current) + direction + tabs.length) % tabs.length;
  const next = tabs[nextIndex];
  if (!next) return;
  activeTab.value = next;
  document.getElementById(`${headingId}-${next}`)?.focus();
}

function lifecycleBusy(status: PluginLifecycleStatus): boolean {
  return ['starting', 'updating', 'rolling-back'].includes(status);
}

function emptySnapshot(): PluginCenterSnapshot {
  return Object.freeze({
    revision: 0,
    catalog: Object.freeze([]),
    installed: Object.freeze([]),
    sources: Object.freeze([]),
    surfaces: Object.freeze([]),
    tasks: Object.freeze([]),
    authorizationRequests: Object.freeze([]),
    commandContributions: Object.freeze([]),
    started: false,
    action: null,
    failure: null,
    runtimeStatus: null,
  });
}
</script>

<style scoped>
.plugin-center {
  display: grid;
  gap: 0.8rem;
}

.plugin-center__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.plugin-center__heading h2 {
  margin: 0;
  font-size: 1.05rem;
}

.plugin-center__trust-warning,
.plugin-center__error {
  margin: 0;
  border-left: 3px solid var(--color-warning);
  padding-left: 0.65rem;
}

.plugin-center__error {
  border-left-color: var(--color-error);
}

.plugin-center__tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border-color);
}

.plugin-center__tabs button[aria-selected='true'] {
  border-bottom-color: var(--color-primary);
  font-weight: 700;
}

.plugin-center__list {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-center__list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: 0.4rem;
  padding: 0.65rem;
}

.plugin-center__list li div,
.plugin-center__list small {
  display: block;
}

.plugin-center__list small {
  color: var(--text-muted);
}

.plugin-center__row-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.plugin-center__uninstall {
  border-left-color: var(--color-error);
}

.plugin-center__uninstall-confirmation,
.plugin-center__uninstall-confirmation fieldset {
  display: grid;
  gap: 0.65rem;
}

.plugin-center__uninstall-confirmation p {
  margin: 0;
}

.plugin-center__uninstall-confirmation fieldset {
  margin: 0;
  border: 1px solid var(--border-color);
  border-radius: 0.4rem;
  padding: 0.65rem;
}

.plugin-center__uninstall-confirmation label {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: 0.5rem;
  cursor: pointer;
}

.plugin-center__uninstall-confirmation small {
  display: block;
  color: var(--text-muted);
}

.plugin-center__local-install {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.plugin-center__local-install label {
  flex-shrink: 0;
}

.plugin-center__local-install input {
  flex: 1;
  min-height: 2.25rem;
  border: 1px solid var(--border-color);
  border-radius: 0.35rem;
  padding: 0.35rem 0.65rem;
  background: transparent;
  color: inherit;
  font: inherit;
}

.plugin-center__panels,
.plugin-center__tasks {
  display: grid;
  gap: 0.75rem;
}

.plugin-center__sources,
.plugin-center__source-list {
  display: grid;
  gap: 0.75rem;
}

.plugin-center__source-form {
  display: grid;
  grid-template-columns: minmax(120px, 0.3fr) minmax(240px, 1fr) auto;
  gap: 0.5rem;
  align-items: center;
}

.plugin-center__source-form input {
  min-height: 2.25rem;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 0.35rem 0.65rem;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.plugin-center__source-toggle {
  display: inline-flex;
  min-width: 28px;
  min-height: 28px;
  align-items: center;
  justify-content: center;
}

.plugin-center__empty {
  color: var(--text-muted);
  text-align: center;
}

button {
  min-height: 2.25rem;
  border: 1px solid var(--border-color);
  border-radius: 0.35rem;
  padding: 0.35rem 0.65rem;
  background: transparent;
  color: inherit;
}

button:focus-visible,
.plugin-center__local-install input:focus-visible,
[role='tabpanel']:focus-visible {
  outline: 3px solid var(--color-primary);
  outline-offset: 2px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
</style>
