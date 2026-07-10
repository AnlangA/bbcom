<template>
  <div class="session-runtime-host">
    <SessionView
      v-for="session in residentSessions"
      v-show="session.id === activeSessionId"
      :key="session.id"
      :session="session"
      :active="session.id === activeSessionId"
      :data-session-runtime-id="session.id"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import SessionView from '../../../components/session/SessionView.vue';
import type { SerialSession } from '../../../types';
import { reconcileResidentSessionIds } from '../runtime/session-residency';

const props = defineProps<{
  sessions: readonly SerialSession[];
  activeSessionId: string | null;
}>();

const residentSessionIds = ref<string[]>([]);

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
