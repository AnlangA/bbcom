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
      <n-button size="tiny" :disabled="busy" @click="beginImport">
        {{ t('workspace.import') }}
      </n-button>
      <n-button
        size="tiny"
        :disabled="busy || !applicationSnapshot.currentWorkspace"
        @click="showExport = true"
      >
        {{ t('workspace.export') }}
      </n-button>
    </div>

    <div v-if="librarySnapshot.library.projects.length" class="workspace-recents">
      <button
        v-for="project in librarySnapshot.library.projects"
        :key="project.workspaceId"
        type="button"
        class="workspace-recent"
        :class="{ active: project.active }"
        :disabled="busy || project.active"
        @click="openProject(project.workspaceId)"
      >
        <span>{{ project.name }}</span>
        <small>{{ saveHealthText(project.saveHealth) }}</small>
      </button>
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

    <n-modal
      v-model:show="showImport"
      preset="card"
      class="workspace-dialog"
      :title="t('workspace.import')"
      :mask-closable="!busy"
      :closable="!busy"
      @after-leave="clearPassphrases"
    >
      <label class="workspace-field">
        <span>{{ t('workspace.encryption.age') }}</span>
        <n-input
          v-model:value="passphrase"
          type="password"
          show-password-on="click"
          :placeholder="t('workspace.passphrase')"
          :maxlength="1024"
        />
      </label>
      <template #footer>
        <div class="workspace-dialog-actions">
          <n-button @click="cancelImport">{{ t('common.cancel') }}</n-button>
          <n-button :disabled="busy" @click="importPlaintext">
            {{ t('workspace.encryption.plaintext') }}
          </n-button>
          <n-button type="primary" :disabled="passphrase.length < 12" @click="importEncrypted">
            {{ t('workspace.import') }}
          </n-button>
        </div>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showExport"
      preset="card"
      class="workspace-dialog"
      :title="t('workspace.export')"
      :mask-closable="!busy"
      :closable="!busy"
      @after-leave="clearPassphrases"
    >
      <label class="workspace-field">
        <span>{{ t('workspace.encryption.age') }}</span>
        <n-input
          v-model:value="passphrase"
          type="password"
          show-password-on="click"
          :placeholder="t('workspace.passphrase')"
          :maxlength="1024"
        />
      </label>
      <label class="workspace-field">
        <span>{{ t('workspace.passphraseConfirm') }}</span>
        <n-input
          v-model:value="passphraseConfirmation"
          type="password"
          show-password-on="click"
          :placeholder="t('workspace.passphraseConfirm')"
          :maxlength="1024"
        />
      </label>
      <p class="workspace-warning">{{ t('workspace.passphraseNoRecovery') }}</p>
      <p v-if="passphraseMismatch" class="workspace-error" role="alert">
        {{ t('workspace.passphraseMismatch') }}
      </p>
      <template #footer>
        <div class="workspace-dialog-actions">
          <n-button @click="cancelProjectExport">{{ t('common.cancel') }}</n-button>
          <n-button :disabled="busy" @click="exportPlaintext">
            {{ t('workspace.encryption.plaintext') }}
          </n-button>
          <n-button type="primary" :disabled="busy || !canExportEncrypted" @click="exportEncrypted">
            {{ t('workspace.encryption.age') }}
          </n-button>
        </div>
      </template>
    </n-modal>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NButton, NInput, NModal, useMessage } from 'naive-ui';
import { t } from '../../lib/i18n';
import type { WorkspaceSaveHealth } from '../../generated/ipc-contracts';
import {
  useOptionalWorkspaceApplication,
  type WorkspaceApplicationOutcome,
  type WorkspaceApplicationViewModel,
} from '../../features/workspace/application';
import type { WorkspaceCoordinatorSnapshot } from '../../features/workspace';

const workspace = useOptionalWorkspaceApplication();
const message = useMessage();
const applicationSnapshot = ref<WorkspaceApplicationViewModel>(
  workspace?.application.snapshot() ?? emptyApplicationSnapshot(),
);
const librarySnapshot = ref<WorkspaceCoordinatorSnapshot>(
  workspace?.coordinator.snapshot() ?? emptyCoordinatorSnapshot(),
);
const showCreate = ref(false);
const showImport = ref(false);
const showExport = ref(false);
const projectName = ref('');
const passphrase = ref('');
const passphraseConfirmation = ref('');
let stopApplication: (() => void) | null = null;
let stopCoordinator: (() => void) | null = null;

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
const passphraseMismatch = computed(
  () =>
    passphraseConfirmation.value.length > 0 && passphrase.value !== passphraseConfirmation.value,
);
const canExportEncrypted = computed(
  () => passphrase.value.length >= 12 && passphrase.value === passphraseConfirmation.value,
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

function beginImport(): void {
  // Encryption mode is an explicit user choice before opening the native file
  // picker. A failed plaintext attempt must never consume one grant and then
  // surprise the user with a second picker for the same file.
  showImport.value = true;
}

function cancelImport(): void {
  if (!workspace) return;
  if (librarySnapshot.value.navigationAction === 'import') {
    workspace.application.cancelActivation();
  }
  showImport.value = false;
}

async function importPlaintext(): Promise<void> {
  if (!workspace) return;
  const outcome = await workspace.application.importWorkspace({ mode: 'plaintext' });
  if (outcome.outcome === 'completed') showImport.value = false;
  reportFailure(outcome);
}

async function importEncrypted(): Promise<void> {
  if (!workspace || passphrase.value.length < 12) return;
  const outcome = await workspace.application.importWorkspace({
    mode: 'age-passphrase',
    passphrase: passphrase.value,
  });
  if (outcome.outcome === 'completed') showImport.value = false;
  reportFailure(outcome);
}

async function exportPlaintext(): Promise<void> {
  if (!workspace) return;
  const current = applicationSnapshot.value.currentWorkspace;
  if (!current) return;
  const outcome = await workspace.application.exportWorkspace(`${current.name}.bbcom`, {
    mode: 'plaintext',
  });
  if (outcome.outcome === 'completed') showExport.value = false;
  reportFailure(outcome);
}

async function exportEncrypted(): Promise<void> {
  if (!workspace || !canExportEncrypted.value) return;
  const current = applicationSnapshot.value.currentWorkspace;
  if (!current) return;
  const outcome = await workspace.application.exportWorkspace(`${current.name}.bbcom`, {
    mode: 'age-passphrase',
    passphrase: passphrase.value,
  });
  if (outcome.outcome === 'completed') showExport.value = false;
  reportFailure(outcome);
}

async function cancelProjectExport(): Promise<void> {
  if (!workspace) return;
  const outcome = await workspace.application.cancelExport();
  if (!outcome) {
    showExport.value = false;
    return;
  }
  if (outcome.outcome === 'completed') {
    message.info(t('workspace.export.cancel_too_late'));
  }
  if (outcome.outcome !== 'failed') showExport.value = false;
  reportFailure(outcome);
}

async function reportOutcome(outcome: Promise<WorkspaceApplicationOutcome>): Promise<void> {
  reportFailure(await outcome);
}

function reportFailure(outcome: { outcome: string; messageKey?: string }): void {
  if (outcome.outcome === 'failed' && outcome.messageKey) message.error(t(outcome.messageKey));
}

function clearPassphrases(): void {
  passphrase.value = '';
  passphraseConfirmation.value = '';
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
.workspace-recent small {
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

.workspace-recents {
  display: grid;
  gap: 4px;
}

.workspace-recent {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  background: transparent;
  text-align: left;
}

.workspace-recent.active {
  border-color: var(--color-primary);
}

.workspace-field {
  display: grid;
  gap: 6px;
}
</style>
