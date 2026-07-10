<template>
  <span v-if="false" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted } from 'vue';
import { useSessionStore } from '../../../stores/sessions';
import type { SerialSession } from '../../../types';
import {
  useSessionRuntimeController,
  type SessionRuntimeController,
} from '../runtime/session-runtime-controller';

const props = defineProps<{
  session: SerialSession;
}>();

const emit = defineEmits<{
  ready: [controller: SessionRuntimeController];
  dispose: [controller: SessionRuntimeController];
}>();

const sessionStore = useSessionStore();
const controller = markRaw(useSessionRuntimeController(computed(() => props.session)));

// Store removal awaits this cleanup before deleting the session record. The
// subsequent component unmount calls dispose again, which is intentionally
// idempotent.
sessionStore.registerCleanup(props.session.id, controller.dispose);

onMounted(() => emit('ready', controller));
onBeforeUnmount(() => {
  emit('dispose', controller);
  void controller.dispose();
});
</script>
