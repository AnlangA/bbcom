<template>
  <section class="plugin-hosted-panel" :aria-labelledby="titleId">
    <h3 :id="titleId">{{ panel.title }}</h3>
    <div class="plugin-hosted-panel__fields">
      <template v-for="field in panel.fields" :key="field.id">
        <label v-if="field.kind === 'text'" class="plugin-hosted-panel__field">
          <span>{{ field.label }}</span>
          <input
            :value="field.value"
            type="text"
            :disabled="field.disabled || busy"
            maxlength="4096"
            @change="emitInput(field, $event)"
          />
        </label>
        <label v-else-if="field.kind === 'number'" class="plugin-hosted-panel__field">
          <span>{{ field.label }}</span>
          <input
            :value="field.value"
            type="number"
            :disabled="field.disabled || busy"
            @change="emitInput(field, $event)"
          />
        </label>
        <label v-else-if="field.kind === 'toggle'" class="plugin-hosted-panel__toggle">
          <input
            type="checkbox"
            :checked="field.value === 'true'"
            :disabled="field.disabled || busy"
            @change="emitToggle(field, $event)"
          />
          <span>{{ field.label }}</span>
        </label>
        <label v-else-if="field.kind === 'select'" class="plugin-hosted-panel__field">
          <span>{{ field.label }}</span>
          <select
            :value="field.value"
            :disabled="field.disabled || busy"
            @change="emitInput(field, $event)"
          >
            <option v-for="option in field.options" :key="option" :value="option">
              {{ option }}
            </option>
          </select>
        </label>
        <button
          v-else-if="field.kind === 'button'"
          type="button"
          :disabled="field.disabled || busy"
          @click="emitEvent(field, '')"
        >
          {{ field.label }}
        </button>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useId } from 'vue';
import type {
  PluginDeclarativePanel,
  PluginPanelEvent,
  PluginPanelField,
} from '../../features/plugins';

const props = defineProps<{
  panel: PluginDeclarativePanel;
  busy: boolean;
}>();

const emit = defineEmits<{
  event: [event: PluginPanelEvent];
}>();

const titleId = `plugin-panel-${useId()}`;

function emitInput(field: PluginPanelField, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  emitEvent(field, target.value);
}

function emitToggle(field: PluginPanelField, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  emitEvent(field, target.checked ? 'true' : 'false');
}

function emitEvent(field: PluginPanelField, value: string): void {
  emit('event', { pluginId: props.panel.pluginId, fieldId: field.id, value });
}
</script>

<style scoped>
.plugin-hosted-panel {
  border: 1px solid var(--border-color, #475569);
  border-radius: 0.5rem;
  padding: 0.85rem;
}

.plugin-hosted-panel h3 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.plugin-hosted-panel__fields {
  display: grid;
  gap: 0.75rem;
}

.plugin-hosted-panel__field {
  display: grid;
  gap: 0.25rem;
}

.plugin-hosted-panel__toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

input,
select,
button {
  min-height: 2.25rem;
  border: 1px solid var(--border-color, #475569);
  border-radius: 0.35rem;
  padding: 0.35rem 0.55rem;
  background: var(--input-bg, #0f172a);
  color: inherit;
}

input[type='checkbox'] {
  min-height: auto;
  width: 1.1rem;
  height: 1.1rem;
}

input:focus-visible,
select:focus-visible,
button:focus-visible {
  outline: 3px solid var(--primary-color, #60a5fa);
  outline-offset: 2px;
}
</style>
