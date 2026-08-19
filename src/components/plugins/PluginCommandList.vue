<template>
  <section class="plugin-commands" :aria-labelledby="headingId">
    <h3 :id="headingId">{{ t('plugins.commands.title') }}</h3>
    <EmptyState v-if="commands.length === 0" :title="t('plugins.commands.empty')" />
    <ul v-else>
      <li v-for="command in commands" :key="commandKey(command)">
        <div>
          <strong>{{ command.title }}</strong>
          <p>{{ command.description }}</p>
        </div>
        <button
          type="button"
          :class="{ 'plugin-commands__danger': command.dangerous }"
          :disabled="busy"
          @click="$emit('run', command)"
        >
          {{ t('plugins.commands.run') }}
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import { t } from '../../lib/i18n';
import type { PluginCommandContributionV2 } from '../../features/plugins';
import EmptyState from '../ui/EmptyState.vue';

defineProps<{
  commands: readonly PluginCommandContributionV2[];
  busy?: boolean;
}>();

defineEmits<{
  run: [command: PluginCommandContributionV2];
}>();

const headingId = `plugin-commands-${useId()}`;

function commandKey(command: PluginCommandContributionV2): string {
  return `${command.runtime.pluginId}:${command.runtime.instanceId}:${command.runtime.generation}:${command.commandId}`;
}
</script>

<style scoped>
.plugin-commands,
.plugin-commands ul {
  display: grid;
  gap: 0.6rem;
}

.plugin-commands h3,
.plugin-commands p,
.plugin-commands ul {
  margin: 0;
}

.plugin-commands ul {
  padding: 0;
  list-style: none;
}

.plugin-commands li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 0.75rem;
}

.plugin-commands p {
  color: var(--text-muted);
}

.plugin-commands__danger {
  border-color: var(--color-error);
}
</style>
