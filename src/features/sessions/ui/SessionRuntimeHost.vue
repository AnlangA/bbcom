<template>
  <div class="session-runtime-host">
    <SessionView
      v-if="activeBinding"
      :key="activeBinding.runtime.instanceId"
      :session="activeBinding.session"
      :runtime="activeBinding.runtime"
      :data-session-view-id="activeBinding.session.id"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { useMessage } from 'naive-ui';
import SessionView from '../../../components/session/SessionView.vue';
import { logger } from '../../../lib/logger';
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
        if (activeSession) await services.runtimeRegistry.ensure(activeSession);
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

onBeforeUnmount(() => {
  attached = false;
  catalogRevision += 1;
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
</style>
