<template>
  <div v-if="visible" class="shutdown-backdrop" @keydown="onDialogKeydown">
    <section
      ref="dialogRef"
      class="shutdown-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="shutdown-title"
      aria-describedby="shutdown-description"
      tabindex="-1"
    >
      <h2 id="shutdown-title">{{ t('shutdown.title') }}</h2>
      <p id="shutdown-description">
        {{
          state === 'timed-out'
            ? t('shutdown.description.timedOut')
            : t('shutdown.description.failed')
        }}
      </p>

      <ul v-if="report" class="shutdown-participants" aria-live="polite">
        <li v-for="participant in report.participants" :key="participant.name">
          <span>{{ participant.name }}</span>
          <span :data-status="participant.status">
            {{ t(participant.messageKey) }} · {{ participant.elapsedMs }} ms
          </span>
        </li>
      </ul>

      <p v-if="snapshot.boundaryError" class="shutdown-error" role="status">
        {{ t('shutdown.boundaryError') }}
      </p>
      <p v-if="forceArmed" class="shutdown-warning" role="alert">
        {{ t('shutdown.forceWarning') }}
      </p>

      <div v-if="publicationFailed" class="shutdown-actions">
        <button
          ref="waitButtonRef"
          type="button"
          data-action="retry-publication"
          :disabled="busy"
          @click="retryPublication"
        >
          {{ t('shutdown.retryPublication') }}
        </button>
      </div>
      <div v-else class="shutdown-actions">
        <button ref="waitButtonRef" type="button" :disabled="busy" @click="waitLonger">
          {{ t('shutdown.wait') }}
        </button>
        <button type="button" :disabled="busy" @click="cancelClose">
          {{ t('shutdown.cancelExit') }}
        </button>
        <button class="danger" type="button" :disabled="busy" @click="forceClose">
          {{ forceArmed ? t('shutdown.forceConfirm') : t('shutdown.force') }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useOptionalApplicationShutdown } from '@/features/platform/shutdown';
import { t } from '@/lib/i18n';

const shutdown = useOptionalApplicationShutdown();
const snapshot = ref(
  shutdown?.snapshot() ?? {
    coordinator: {
      state: 'idle' as const,
      attemptId: null,
      acceptsNewWork: true,
      forced: false,
      report: null,
    },
    boundaryError: null,
  },
);
const busy = ref(false);
const forceArmed = ref(false);
const dialogRef = ref<HTMLElement | null>(null);
const waitButtonRef = ref<HTMLButtonElement | null>(null);
let previouslyFocused: HTMLElement | null = null;
const detach =
  shutdown?.subscribe((value) => {
    snapshot.value = value;
  }) ?? (() => undefined);

const state = computed(() => snapshot.value.coordinator.state);
const report = computed(() => snapshot.value.coordinator.report);
const attemptId = computed(() => snapshot.value.coordinator.attemptId);
const publicationFailed = computed(
  () => snapshot.value.boundaryError !== null && snapshot.value.boundaryError !== 'listen',
);
const visible = computed(
  () => state.value === 'timed-out' || state.value === 'failed' || publicationFailed.value,
);

watch(
  visible,
  (show) => {
    if (!show) {
      forceArmed.value = false;
      const target = previouslyFocused;
      previouslyFocused = null;
      if (target?.isConnected) void nextTick(() => target.focus());
      return;
    }
    if (document.activeElement instanceof HTMLElement) previouslyFocused = document.activeElement;
    void nextTick(() => (waitButtonRef.value ?? dialogRef.value)?.focus());
  },
  { immediate: true },
);

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (publicationFailed.value) return;
    cancelClose();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = Array.from(
    dialogRef.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

async function withAction(action: (id: string) => Promise<unknown>): Promise<void> {
  const id = attemptId.value;
  if (!shutdown || !id || busy.value) return;
  busy.value = true;
  try {
    await action(id);
  } catch {
    // The controller records a stable boundary phase for the dialog. Native
    // error objects and prose are deliberately not retained in component state.
  } finally {
    busy.value = false;
  }
}

function waitLonger(): void {
  forceArmed.value = false;
  const controller = shutdown;
  if (controller) void withAction((id) => controller.wait(id));
}

function cancelClose(): void {
  forceArmed.value = false;
  const controller = shutdown;
  if (controller) void withAction((id) => controller.cancel(id));
}

function forceClose(): void {
  if (!forceArmed.value) {
    forceArmed.value = true;
    return;
  }
  const controller = shutdown;
  if (controller) void withAction((id) => controller.force(id));
}

function retryPublication(): void {
  forceArmed.value = false;
  const controller = shutdown;
  if (controller) void withAction((id) => controller.retryPublication(id));
}

onBeforeUnmount(detach);
</script>

<style scoped>
.shutdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-gate);
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(0 0 0 / 68%);
}

.shutdown-dialog {
  width: min(560px, 100%);
  max-height: min(640px, calc(100vh - 48px));
  overflow: auto;
  padding: 24px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  color: var(--text-primary);
  background: var(--bg-primary);
  box-shadow: 0 20px 60px rgb(0 0 0 / 45%);
}

.shutdown-dialog h2 {
  margin: 0 0 10px;
  font-size: 18px;
}

.shutdown-dialog p {
  margin: 0 0 16px;
  color: var(--text-secondary);
}

.shutdown-participants {
  display: grid;
  gap: 8px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
}

.shutdown-participants li {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-secondary);
}

.shutdown-participants [data-status='failed'],
.shutdown-participants [data-status='timed-out'],
.shutdown-error,
.shutdown-warning {
  color: var(--color-error);
}

.shutdown-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.shutdown-actions button {
  min-height: 36px;
  padding: 6px 14px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  cursor: pointer;
}

.shutdown-actions button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.shutdown-actions button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.shutdown-actions .danger {
  border-color: var(--color-error);
  color: var(--text-on-bright-accent);
  background: var(--color-error);
}
</style>
