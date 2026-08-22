<template>
  <section v-if="workspace" class="workspace-panel" :aria-label="t('workspace.library')">
    <div class="workspace-heading">
      <strong>{{ t('workspace.library') }}</strong>
      <span class="workspace-save-health" role="status" aria-live="polite">
        {{ saveHealthLabel }}
      </span>
    </div>

    <p v-if="applicationSnapshot.currentWorkspace" class="workspace-current">
      {{
        t('workspace.current', {
          name: applicationSnapshot.currentWorkspace.name,
        })
      }}
    </p>
    <p v-if="messageKey" class="workspace-error" role="alert">{{ t(messageKey) }}</p>

    <div class="workspace-actions">
      <n-button size="tiny" :disabled="busy" @click="showCreate = true">
        {{ t('workspace.new') }}
      </n-button>
      <n-button size="tiny" :disabled="busy" @click="importProject">
        {{ t('workspace.import') }}
      </n-button>
      <n-button
        size="tiny"
        :disabled="busy || !applicationSnapshot.currentWorkspace"
        @click="exportProject"
      >
        {{ t('workspace.export') }}
      </n-button>
      <n-button v-if="exporting" size="tiny" type="warning" @click="cancelProjectExport">
        {{ t('common.cancel') }}
      </n-button>
    </div>

    <div v-if="librarySnapshot.library.projects.length" class="workspace-project-list">
      <div
        v-for="project in librarySnapshot.library.projects"
        :key="project.workspaceId"
        class="workspace-project-row"
        :class="{ active: project.active }"
      >
        <button
          type="button"
          class="workspace-project-item"
          :disabled="busy || project.active"
          @click="openProject(project.workspaceId)"
        >
          <span>{{ project.name }}</span>
          <small>{{ saveHealthText(project.saveHealth) }}</small>
        </button>
        <n-button
          class="workspace-project-delete"
          size="tiny"
          quaternary
          type="error"
          :disabled="busy"
          :title="
            armedDeleteId === project.workspaceId ? t('common.confirmDelete') : t('common.delete')
          "
          :aria-label="
            armedDeleteId === project.workspaceId ? t('common.confirmDelete') : t('common.delete')
          "
          @click="requestDelete(project.workspaceId)"
        >
          <template #icon><Trash2 class="icon-sm" /></template>
          <span v-if="armedDeleteId === project.workspaceId">{{ t('common.confirmDelete') }}</span>
        </n-button>
      </div>
    </div>

    <n-modal
      v-model:show="showCreate"
      preset="card"
      class="workspace-dialog"
      :title="t('workspace.new')"
      @after-leave="projectName = ''"
    >
      <label class="workspace-field">
        <span>{{ t('workspace.name') }}</span>
        <n-input v-model:value="projectName" :maxlength="256" autofocus />
      </label>
      <template #footer>
        <div class="workspace-dialog-actions">
          <n-button @click="showCreate = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :disabled="!projectName.trim()" @click="createProject">
            {{ t('workspace.new') }}
          </n-button>
        </div>
      </template>
    </n-modal>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NButton, NInput, NModal, useMessage } from 'naive-ui';
import { Trash2 } from '@lucide/vue';
import { t } from '@/lib/i18n';
import type { WorkspaceSaveHealth } from '@/generated/ipc-contracts';
import {
  useOptionalWorkspaceApplication,
  type WorkspaceApplicationOutcome,
  type WorkspaceApplicationViewModel,
} from '@/features/workspace/application';
import type { WorkspaceCoordinatorSnapshot } from '@/features/workspace';

const workspace = useOptionalWorkspaceApplication();
const message = useMessage();
const applicationSnapshot = ref<WorkspaceApplicationViewModel>(
  workspace?.application.snapshot() ?? emptyApplicationSnapshot(),
);
const librarySnapshot = ref<WorkspaceCoordinatorSnapshot>(
  workspace?.coordinator.snapshot() ?? emptyCoordinatorSnapshot(),
);
const showCreate = ref(false);
const projectName = ref('');
let stopApplication: (() => void) | null = null;
let stopCoordinator: (() => void) | null = null;
const armedDeleteId = ref<string | null>(null);

const busy = computed(
  () =>
    applicationSnapshot.value.hydrating ||
    applicationSnapshot.value.exporting ||
    librarySnapshot.value.navigationAction !== null ||
    librarySnapshot.value.exporting,
);
const messageKey = computed(
  () => applicationSnapshot.value.messageKey ?? librarySnapshot.value.library.messageKey,
);
const saveHealthLabel = computed(() => saveHealthText(applicationSnapshot.value.saveHealth));
const exporting = computed(
  () => applicationSnapshot.value.exporting || librarySnapshot.value.exporting,
);

onMounted(() => {
  if (!workspace) return;
  stopApplication = workspace.application.subscribe((snapshot) => {
    applicationSnapshot.value = snapshot;
  });
  stopCoordinator = workspace.coordinator.subscribe((snapshot) => {
    librarySnapshot.value = snapshot;
  });
  void workspace.coordinator.refreshCatalog();
});

onUnmounted(() => {
  stopApplication?.();
  stopCoordinator?.();
});

async function openProject(workspaceId: string): Promise<void> {
  if (!workspace) return;
  await reportOutcome(workspace.application.openWorkspace(workspaceId));
}

async function createProject(): Promise<void> {
  if (!workspace) return;
  const name = projectName.value.trim();
  if (!name) return;
  const outcome = await workspace.application.createWorkspace(name);
  if (outcome.outcome === 'completed') showCreate.value = false;
  reportFailure(outcome);
}

async function deleteProject(workspaceId: string): Promise<void> {
  if (!workspace) return;
  reportFailure(await workspace.application.deleteWorkspace(workspaceId));
}

function requestDelete(workspaceId: string): void {
  if (armedDeleteId.value !== workspaceId) {
    armedDeleteId.value = workspaceId;
    return;
  }
  armedDeleteId.value = null;
  void deleteProject(workspaceId);
}

async function importProject(): Promise<void> {
  if (!workspace) return;
  reportFailure(await workspace.application.importWorkspace());
}

async function exportProject(): Promise<void> {
  if (!workspace) return;
  const current = applicationSnapshot.value.currentWorkspace;
  if (!current) return;
  reportFailure(await workspace.application.exportWorkspace(`${current.name}.bbcom`));
}

async function cancelProjectExport(): Promise<void> {
  if (!workspace) return;
  const outcome = await workspace.application.cancelExport();
  if (!outcome) return;
  if (outcome.outcome === 'completed') message.info(t('workspace.export.cancel_too_late'));
  reportFailure(outcome);
}

async function reportOutcome(outcome: Promise<WorkspaceApplicationOutcome>): Promise<void> {
  reportFailure(await outcome);
}

function reportFailure(outcome: { outcome: string; messageKey?: string }): void {
  if (outcome.outcome === 'failed' && outcome.messageKey) message.error(t(outcome.messageKey));
}

function saveHealthText(health: WorkspaceSaveHealth): string {
  return t(`workspace.save.${health}`);
}

function emptyApplicationSnapshot(): WorkspaceApplicationViewModel {
  return Object.freeze({
    status: 'idle',
    currentWorkspace: null,
    saveHealth: 'clean',
    acceptsSaves: false,
    acceptsPersistenceEvents: false,
    readOnly: false,
    recoveryRequired: false,
    hydrating: false,
    exporting: false,
    messageKey: null,
    unsavedMutationCount: 0,
  });
}

function emptyCoordinatorSnapshot(): WorkspaceCoordinatorSnapshot {
  return Object.freeze({
    library: Object.freeze({
      status: 'idle',
      activeWorkspaceId: null,
      messageKey: null,
      actions: Object.freeze({
        newProject: Object.freeze({ id: 'new-project', enabled: false, busy: false }),
        openProject: Object.freeze({ id: 'open-project', enabled: false, busy: false }),
        importProject: Object.freeze({ id: 'import-project', enabled: false, busy: false }),
      }),
      recentProjects: Object.freeze([]),
      projects: Object.freeze([]),
    }),
    activeWorkspace: null,
    navigationAction: null,
    exporting: false,
    acceptsMutations: false,
  });
}
</script>

<style scoped>
.workspace-panel {
  display: grid;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--border-subtle);
}

.workspace-heading,
.workspace-actions,
.workspace-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.workspace-actions {
  justify-content: flex-start;
  flex-wrap: wrap;
}

.workspace-save-health,
.workspace-current,
.workspace-project-row small {
  color: var(--text-muted);
  font-size: var(--font-size-data);
}

.workspace-current,
.workspace-error,
.workspace-warning {
  margin: 0;
}

.workspace-error {
  color: var(--color-error);
}

.workspace-warning {
  color: var(--color-warning);
}

.workspace-project-list {
  display: grid;
  gap: 4px;
}

.workspace-project-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.workspace-project-item {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 0;
  color: var(--text-primary);
  background: transparent;
  text-align: left;
}

.workspace-project-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-project-row.active {
  border-color: var(--color-primary);
}

.workspace-project-delete {
  flex: none;
  margin-right: 2px;
}

.workspace-field {
  display: grid;
  gap: 6px;
}
</style>
