<template>
  <div class="mc-activity-strip" :class="{ 'is-busy': busy, 'is-error': hasError }">
    <CircleAlert v-if="hasError" :size="14" class="activity-icon" aria-hidden="true" />
    <Info v-else :size="14" class="activity-icon" aria-hidden="true" />
    <span
      class="activity-message"
      :title="message"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      >{{ message }}</span
    >
    <div class="activity-cancel-slot">
      <n-button v-if="busy" size="small" quaternary type="warning" @click="emit('cancel')">{{
        t('common.cancel')
      }}</n-button>
    </div>
    <McumgrProgressBar
      v-if="busy && percentage !== null"
      class="activity-progress"
      :percentage="percentage"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton } from 'naive-ui';
import { CircleAlert, Info } from '@lucide/vue';
import { t } from '@/lib/i18n';
import McumgrProgressBar from './McumgrProgressBar.vue';

const props = defineProps<{
  busy: boolean;
  hasError: boolean;
  connected: boolean;
  statusText: string;
  percentage: number | null;
}>();
const emit = defineEmits<{ cancel: [] }>();
const message = computed(() =>
  props.busy || props.hasError
    ? props.statusText
    : props.connected
      ? t('mcumgr.status.ready')
      : t('mcumgr.offlineOk'),
);
</script>

<style scoped>
/* Keep geometry identical through idle, port yield, progress, error and completion. */
.mc-activity-strip {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex: 0 0 32px;
  height: 32px;
  min-width: 0;
  margin: 0 var(--space-lg) var(--space-sm);
  color: var(--text-muted);
  overflow: hidden;
}
.activity-icon {
  flex: 0 0 14px;
}
.activity-message {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-data);
  line-height: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.is-busy .activity-icon {
  color: var(--color-primary);
}
.is-busy .activity-message {
  color: var(--text-secondary);
}
.is-error {
  color: var(--color-error);
}
.activity-cancel-slot {
  flex: 0 0 64px;
  width: 64px;
  display: flex;
  justify-content: flex-end;
}
.activity-progress {
  position: absolute;
  inset: auto 0 0;
  height: 2px;
  border-radius: 0;
  pointer-events: none;
}
</style>
