<template>
  <slot v-if="snapshot.status === 'completed'" />

  <!-- Recovery-in-progress with a trusted completion marker: render nothing.
       The journal + workspace hydration still run underneath; only the gate's
       own flash is suppressed. -->
  <div v-else-if="reset && suppressed" class="sr-only" role="status" aria-live="polite">
    {{ t('migration.reset.checkingHint') }}
  </div>

  <!-- First run (or marker-less boot): a neutral loading screen. The 0.7.3
       migration copy is deliberately NOT shown here — it used to flash scary
       "old database" wording on every already-migrated startup. Without a
       native reset integration the full card must stay visible so the
       integration-unavailable alert is reachable. -->
  <div
    v-else-if="reset && snapshot.status === 'checking'"
    class="legacy-reset-gate legacy-reset-gate--neutral"
    role="status"
    aria-live="polite"
  >
    <span class="legacy-reset-spinner" aria-hidden="true"></span>
    <p class="legacy-reset-hint">{{ t('migration.reset.checkingHint') }}</p>
  </div>

  <div v-else class="legacy-reset-gate" @keydown="onKeydown">
    <section
      ref="dialogRef"
      class="legacy-reset-card"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="legacy-reset-title"
      aria-describedby="legacy-reset-description"
      tabindex="-1"
    >
      <h1 id="legacy-reset-title">{{ t('migration.reset.title') }}</h1>
      <p id="legacy-reset-description">{{ t('migration.reset.description') }}</p>

      <p class="legacy-reset-safety">{{ t('migration.reset.legacy_preserved') }}</p>
      <p v-if="!reset" class="legacy-reset-error" role="alert">
        {{ t('migration.reset.integration_unavailable') }}
      </p>
      <template v-if="reset && needsPassphrase">
        <label class="legacy-reset-field">
          <span>{{ t('workspace.passphrase') }}</span>
          <input
            v-model="passphrase"
            type="password"
            autocomplete="new-password"
            :maxlength="1024"
          />
        </label>
        <label class="legacy-reset-field">
          <span>{{ t('workspace.passphraseConfirm') }}</span>
          <input
            v-model="passphraseConfirmation"
            type="password"
            autocomplete="new-password"
            :maxlength="1024"
          />
        </label>
        <p class="legacy-reset-safety">{{ t('workspace.passphraseNoRecovery') }}</p>
        <p v-if="passphraseMismatch" class="legacy-reset-error" role="alert">
          {{ t('workspace.passphraseMismatch') }}
        </p>
      </template>
      <p
        v-else-if="snapshot.messageKey"
        class="legacy-reset-message"
        role="status"
        aria-live="polite"
      >
        {{ t(snapshot.messageKey) }}
      </p>
      <p v-else-if="busyLabel" class="legacy-reset-message" role="status" aria-live="polite">
        {{ busyLabel }}
      </p>

      <template v-if="reset">
        <div v-if="snapshot.status === 'backup-required'" class="legacy-reset-actions">
          <button
            ref="primaryActionRef"
            type="button"
            class="primary"
            :disabled="!canCreateBackup"
            @click="createBackup"
          >
            {{ t('migration.reset.create_encrypted_backup') }}
          </button>
          <button
            v-if="!discardChallenge"
            type="button"
            class="danger-secondary"
            @click="requestDiscard"
          >
            {{ t('migration.reset.without_backup_first') }}
          </button>
          <button v-else type="button" class="danger" @click="confirmDiscard">
            {{ t('migration.reset.without_backup_confirm') }}
          </button>
        </div>

        <div v-else-if="snapshot.status === 'ready-to-reset'" class="legacy-reset-actions">
          <button ref="primaryActionRef" type="button" class="primary" @click="activateEmpty">
            {{ t('migration.reset.activate_empty_workspace') }}
          </button>
        </div>

        <div v-else-if="snapshot.status === 'failed'" class="legacy-reset-actions">
          <button
            v-if="retryKind === 'read'"
            ref="primaryActionRef"
            type="button"
            class="primary"
            @click="start"
          >
            {{ t('migration.reset.retry_read') }}
          </button>
          <button
            v-else-if="retryKind === 'backup'"
            ref="primaryActionRef"
            type="button"
            class="primary"
            @click="createBackup"
          >
            {{ t('migration.reset.retry_backup') }}
          </button>
          <button
            v-else-if="retryKind === 'reset'"
            ref="primaryActionRef"
            type="button"
            class="primary"
            @click="activateEmpty"
          >
            {{ t('migration.reset.retry_activation') }}
          </button>
        </div>

        <button v-if="snapshot.canCancel" type="button" class="cancel" @click="cancel">
          {{ t('common.cancel') }}
        </button>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  isLegacyResetMarkerSet,
  useOptionalLegacyResetContext,
  type LegacyResetViewModel,
} from '../../features/migration';
import { t } from '../../lib/i18n';

const reset = useOptionalLegacyResetContext();
const snapshot = ref<LegacyResetViewModel>(
  reset?.coordinator.snapshot() ?? {
    status: 'checking',
    messageKey: null,
    canCancel: false,
    discardChallengePending: false,
    resetAuthorizedBy: null,
  },
);
// The completion marker is only written after the native journal committed.
// When present, the checking phase renders nothing at all — the journal
// confirm + workspace hydration continue underneath and flip straight to
// `completed`, so an already-migrated install never sees the gate flash.
const suppressed = ref(
  typeof window !== 'undefined' && isLegacyResetMarkerSet(window.localStorage),
);
const discardChallenge = ref<string | null>(null);
const passphrase = ref('');
const passphraseConfirmation = ref('');
const dialogRef = ref<HTMLElement | null>(null);
const primaryActionRef = ref<HTMLButtonElement | null>(null);
let stop: (() => void) | null = null;

const passphraseMismatch = computed(
  () =>
    passphraseConfirmation.value.length > 0 && passphrase.value !== passphraseConfirmation.value,
);
const canCreateBackup = computed(
  () => passphrase.value.length >= 12 && passphrase.value === passphraseConfirmation.value,
);
const needsPassphrase = computed(
  () =>
    snapshot.value.status === 'backup-required' ||
    (snapshot.value.status === 'failed' && retryKind.value === 'backup'),
);

const busyLabel = computed(() => {
  switch (snapshot.value.status) {
    case 'checking':
      return t('migration.reset.checking');
    case 'backing-up':
      return t('migration.reset.backing_up');
    case 'verifying':
      return t('migration.reset.verifying');
    case 'resetting':
      return t('migration.reset.activating');
    default:
      return null;
  }
});

const retryKind = computed<'read' | 'backup' | 'reset' | null>(() => {
  if (snapshot.value.status !== 'failed') return null;
  if (
    snapshot.value.messageKey === 'migration.reset.legacy_read_failed' ||
    snapshot.value.messageKey === 'migration.reset.cancelled'
  ) {
    return 'read';
  }
  if (
    snapshot.value.messageKey === 'migration.reset.backup_failed' ||
    snapshot.value.messageKey === 'migration.reset.backup_verification_failed'
  ) {
    return 'backup';
  }
  if (snapshot.value.messageKey === 'migration.reset.target_failed') return 'reset';
  // marker_rollback_failed is intentionally terminal: retrying could treat a
  // marker left behind by a failed target as a completed migration.
  return null;
});

onMounted(() => {
  if (!reset) {
    void nextTick(() => dialogRef.value?.focus());
    return;
  }
  stop = reset.coordinator.subscribe((value) => {
    snapshot.value = value;
    // Any definitive journal outcome ends suppression: `completed` releases
    // the slot, everything else needs the visible gate again.
    if (value.status !== 'checking') suppressed.value = false;
    if (!value.discardChallengePending) discardChallenge.value = null;
  });
  void start();
});

onBeforeUnmount(() => stop?.());

watch(
  () => [snapshot.value.status, snapshot.value.discardChallengePending] as const,
  () => {
    if (snapshot.value.status === 'completed') return;
    void nextTick(() => (primaryActionRef.value ?? dialogRef.value)?.focus());
  },
);

async function start(): Promise<void> {
  if (!reset) return;
  await reset.start();
}

async function createBackup(): Promise<void> {
  if (!reset || !canCreateBackup.value) return;
  const outcome = await reset.createVerifiedBackup(passphrase.value);
  if (outcome.outcome === 'completed') {
    passphrase.value = '';
    passphraseConfirmation.value = '';
  }
}

function requestDiscard(): void {
  if (!reset) return;
  const outcome = reset.coordinator.requestDiscard();
  if (outcome.outcome === 'challenge') discardChallenge.value = outcome.challenge;
}

function confirmDiscard(): void {
  if (!reset || !discardChallenge.value) return;
  reset.coordinator.confirmDiscard(discardChallenge.value);
}

async function activateEmpty(): Promise<void> {
  if (!reset) return;
  await reset.coordinator.activateEmptyV1();
}

function cancel(): void {
  reset?.coordinator.cancel();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && snapshot.value.canCancel) {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    dialogRef.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  );
  if (focusable.length === 0) {
    event.preventDefault();
    dialogRef.value?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.legacy-reset-gate {
  position: fixed;
  inset: 0;
  z-index: var(--z-gate);
  display: grid;
  place-items: center;
  padding: 24px;
  color: var(--text-primary);
  background: var(--bg-primary);
}

.legacy-reset-gate--neutral {
  gap: var(--space-md);
  grid-auto-flow: row;
  justify-items: center;
}

.legacy-reset-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-color);
  border-top-color: var(--color-primary);
  border-radius: var(--radius-full);
  animation: legacy-reset-spin 0.9s linear infinite;
}

.legacy-reset-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

@keyframes legacy-reset-spin {
  to {
    transform: rotate(360deg);
  }
}

.legacy-reset-card {
  width: min(620px, 100%);
  padding: 28px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-secondary);
  box-shadow: 0 18px 50px rgb(0 0 0 / 28%);
}

.legacy-reset-card h1 {
  margin: 0 0 12px;
  font-size: 22px;
}

.legacy-reset-card p {
  line-height: 1.55;
}

.legacy-reset-safety {
  padding: 10px 12px;
  border-left: 3px solid var(--color-primary);
  background: var(--bg-tertiary);
}

.legacy-reset-error {
  color: var(--color-error);
}

.legacy-reset-message {
  min-height: 24px;
}

.legacy-reset-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}

.legacy-reset-field {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}

.legacy-reset-field input {
  min-height: 38px;
  padding: 7px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: inherit;
  background: var(--bg-tertiary);
}

button {
  min-height: 36px;
  padding: 7px 14px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: inherit;
  background: var(--bg-tertiary);
  cursor: pointer;
}

button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

button.primary {
  border-color: var(--color-primary);
  color: white;
  background: var(--color-primary);
}

button.danger,
button.danger-secondary {
  border-color: var(--color-error);
}

button.danger {
  color: white;
  background: var(--color-error);
}

button.cancel {
  margin-top: 16px;
}
</style>
