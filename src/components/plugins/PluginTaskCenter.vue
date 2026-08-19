<template>
  <section class="plugin-task-center" :aria-labelledby="headingId">
    <h3 :id="headingId">{{ t('plugins.tasks.title') }}</h3>
    <EmptyState v-if="tasks.length === 0" :title="t('plugins.tasks.empty')" />
    <ul v-else class="plugin-task-center__list">
      <li v-for="task in tasks" :key="taskKey(task)">
        <div class="plugin-task-center__summary">
          <strong>{{ task.title }}</strong>
          <span class="plugin-task-center__status" :data-status="task.status">
            {{ t(`plugins.tasks.status.${task.status}`) }}
          </span>
        </div>
        <progress
          v-if="task.total > 0"
          :value="task.completed"
          :max="task.total"
          :aria-label="task.title"
        />
        <p class="plugin-task-center__message" role="status" aria-live="polite">
          {{ task.statusText }}
        </p>
        <p v-if="task.failure" class="plugin-task-center__failure" role="alert">
          {{ task.failure.detail ?? task.failure.messageKey }}
        </p>
        <button
          v-if="task.cancellable"
          type="button"
          :disabled="busy || task.status === 'cancelling'"
          @click="$emit('cancel', task)"
        >
          {{ t(task.status === 'cancelling' ? 'common.cancelling' : 'common.cancel') }}
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import { t } from '../../lib/i18n';
import type { PluginTaskViewV2 } from '../../features/plugins';
import EmptyState from '../ui/EmptyState.vue';

defineProps<{
  tasks: readonly PluginTaskViewV2[];
  busy?: boolean;
}>();

defineEmits<{
  cancel: [task: PluginTaskViewV2];
}>();

const headingId = `plugin-tasks-${useId()}`;

function taskKey(task: PluginTaskViewV2): string {
  return `${task.runtime.pluginId}:${task.runtime.instanceId}:${task.runtime.generation}:${task.taskId}`;
}
</script>

<style scoped>
.plugin-task-center,
.plugin-task-center__list,
.plugin-task-center__list li {
  display: grid;
  gap: 0.6rem;
}

.plugin-task-center h3,
.plugin-task-center__message,
.plugin-task-center__failure {
  margin: 0;
}

.plugin-task-center__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-task-center__list li {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 0.75rem;
}

.plugin-task-center__summary {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}

.plugin-task-center__status,
.plugin-task-center__message {
  color: var(--text-muted);
}

.plugin-task-center__status[data-status='failed'],
.plugin-task-center__status[data-status='unknown-outcome'],
.plugin-task-center__failure {
  color: var(--color-error);
}

.plugin-task-center progress {
  width: 100%;
}

.plugin-task-center button {
  justify-self: end;
}
</style>
