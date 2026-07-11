<template>
  <div class="session-runtime-host">
    <SessionRuntime
      v-for="session in residentSessions"
      :key="session.id"
      :session="session"
      @ready="registerRuntime"
      @dispose="unregisterRuntime"
    />
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
import { computed, ref, shallowReactive, watch } from 'vue';
import SessionView from '../../../components/session/SessionView.vue';
import type { SerialSession } from '../../../types';
import SessionRuntime from './SessionRuntime.vue';
import type { SessionRuntimeController } from '../runtime/session-runtime-controller';
import { SessionRuntimeManager } from '../runtime/session-runtime-manager';

const props = defineProps<{
  sessions: readonly SerialSession[];
  activeSessionId: string | null;
}>();

const residentSessionIds = ref<string[]>([]);
const runtimes = shallowReactive(new Map<string, SessionRuntimeController>());
const runtimeManager = new SessionRuntimeManager<SerialSession, SessionRuntimeController>(runtimes);

watch(
  () => [props.sessions, props.activeSessionId] as const,
  ([sessions, activeSessionId]) => {
    residentSessionIds.value = [...runtimeManager.reconcile(sessions, activeSessionId)];
  },
  { immediate: true },
);

const residentSessions = computed(() => {
  const sessionsById = new Map(props.sessions.map((session) => [session.id, session]));
  return residentSessionIds.value.flatMap((sessionId) => {
    const session = sessionsById.get(sessionId);
    return session ? [session] : [];
  });
});

const activeBinding = computed(() =>
  runtimeManager.resolveActive(props.sessions, props.activeSessionId),
);

function registerRuntime(runtime: SessionRuntimeController) {
  runtimeManager.register(runtime);
}

function unregisterRuntime(runtime: SessionRuntimeController) {
  runtimeManager.unregister(runtime);
}
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
