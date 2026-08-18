<template>
  <div class="session-runtime-host">
    <SessionView
      v-if="activeBinding"
      :key="activeBinding.runtime.instanceId"
      :session="activeBinding.session"
      :runtime="activeBinding.runtime"
      :data-session-view-id="activeBinding.session.id"
    />
    <!-- First activation of a lazily created runtime: the viewport would
         otherwise sit blank with no signal that anything is loading. -->
    <div
      v-else-if="activationPhase === 'pending'"
      class="session-runtime-status"
      data-testid="session-runtime-loading"
    >
      {{ t('session.runtimeLoading') }}
    </div>
    <div
      v-else-if="activationPhase === 'error'"
      class="session-runtime-status session-runtime-status--error"
      data-testid="session-runtime-error"
    >
      <span>{{ t('session.runtimeError') }}</span>
      <button type="button" class="session-runtime-retry" @click="retryActivation">
        {{ t('session.runtimeRetry') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { useMessage } from 'naive-ui';
import SessionView from '../../../components/session/SessionView.vue';
import { logger } from '../../../lib/logger';
import { t } from '../../../lib/i18n';
import type { SerialSession } from '../../../types';
import type { ApplicationRuntimeEntry } from '../../application';
import { useSessionApplicationServices } from '../runtime/session-application-services';
import type { ApplicationSessionRuntime } from '../runtime/session-runtime-factory';
import { useSessionMutationPolicy } from '../session-ports';

const props = defineProps<{
  sessions: readonly SerialSession[];
  activeSessionId: string | null;
}>();

const services = useSessionApplicationServices();
const mutationPolicy = useSessionMutationPolicy();
const message = useMessage();
const runtimeEntries = shallowRef<
  readonly ApplicationRuntimeEntry<SerialSession, ApplicationSessionRuntime>[]
>(services.runtimeRegistry.list());
let attached = true;
let catalogRevision = 0;
let reconcileTail = Promise.resolve();

/** Lazy first-activation feedback for the active session's runtime. */
const activationPhase = shallowRef<'idle' | 'pending' | 'error'>('idle');
let activationAttempt = 0;

const detachNotifications = services.notifications.attach({
  info: (text) => {
    message.info(text);
  },
  success: (text) => {
    message.success(text);
  },
  warning: (text) => {
    message.warning(text);
  },
  error: (text) => {
    message.error(text);
  },
});
const detachRegistry = services.runtimeRegistry.subscribe((entries) => {
  runtimeEntries.value = entries;
});

async function ensureActiveRuntime(session: SerialSession): Promise<void> {
  const attempt = ++activationAttempt;
  activationPhase.value = 'pending';
  try {
    await services.runtimeRegistry.ensure(session);
    if (attempt === activationAttempt) activationPhase.value = 'idle';
  } catch (runtimeError: unknown) {
    logger.warn('session runtime activation failed', runtimeError);
    if (attempt === activationAttempt) activationPhase.value = 'error';
  }
}

function retryActivation(): void {
  const activeSession = props.sessions.find((candidate) => candidate.id === props.activeSessionId);
  if (activeSession) void ensureActiveRuntime(activeSession);
}

const stopCatalogWatch = watch(
  () => ({ sessions: [...props.sessions], activeSessionId: props.activeSessionId }),
  ({ sessions, activeSessionId }) => {
    const catalog = [...sessions];
    const revision = ++catalogRevision;
    for (const session of catalog) {
      mutationPolicy.registerCleanup(session.id, () =>
        services.runtimeRegistry.disposeSession(session.id),
      );
    }
    reconcileTail = reconcileTail
      .then(async () => {
        await services.runtimeRegistry.reconcile(catalog);
        if (!attached || revision !== catalogRevision || !activeSessionId) return;
        const activeSession = catalog.find((session) => session.id === activeSessionId);
        if (activeSession) await ensureActiveRuntime(activeSession);
      })
      .catch((runtimeError: unknown) => {
        logger.warn('session runtime catalog reconciliation failed', runtimeError);
      });
  },
  { immediate: true },
);

const activeBinding = computed(() => {
  if (!props.activeSessionId) return null;
  const session = props.sessions.find((candidate) => candidate.id === props.activeSessionId);
  const runtime = runtimeEntries.value.find(
    (candidate) => candidate.sessionId === props.activeSessionId,
  )?.runtime;
  return session && runtime ? { session, runtime } : null;
});

// A runtime arriving from the registry (e.g. reconcile created it after a
// failed ensure) resolves the pending phase without another ensure round.
watch(activeBinding, (binding) => {
  if (binding) activationPhase.value = 'idle';
});

onBeforeUnmount(() => {
  attached = false;
  catalogRevision += 1;
  activationAttempt += 1;
  stopCatalogWatch();
  detachRegistry();
  detachNotifications();
});
</script>

<style scoped>
.session-runtime-host {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.session-runtime-status {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.session-runtime-status--error {
  color: var(--text-primary);
}

.session-runtime-retry {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
  color: var(--text-primary);
  padding: var(--space-xs) var(--space-md);
  cursor: pointer;
}

.session-runtime-retry:hover {
  border-color: var(--color-primary);
}
</style>
