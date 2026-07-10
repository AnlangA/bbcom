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
import {
  reconcileResidentSessionIds,
  resolveActiveSessionRuntime,
} from '../runtime/session-residency';

const props = defineProps<{
  sessions: readonly SerialSession[];
  activeSessionId: string | null;
}>();

const residentSessionIds = ref<string[]>([]);
const runtimes = shallowReactive(new Map<string, SessionRuntimeController>());

watch(
  () => [props.sessions, props.activeSessionId] as const,
  ([sessions, activeSessionId]) => {
    residentSessionIds.value = reconcileResidentSessionIds(
      residentSessionIds.value,
      sessions.map((session) => session.id),
      activeSessionId,
    );
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
  resolveActiveSessionRuntime(props.sessions, runtimes, props.activeSessionId),
);

function registerRuntime(runtime: SessionRuntimeController) {
  runtimes.set(runtime.sessionId, runtime);
}

function unregisterRuntime(runtime: SessionRuntimeController) {
  if (runtimes.get(runtime.sessionId) === runtime) runtimes.delete(runtime.sessionId);
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
