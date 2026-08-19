<template>
  <div
    v-if="node.kind === 'column' || node.kind === 'row'"
    :class="['plugin-node', `plugin-node--${node.kind}`]"
    :data-node-id="node.id"
  >
    <PluginUiNodeRenderer
      v-for="child in node.children"
      :key="child.id"
      :node="child"
      :editable="editable"
      :busy="busy"
      :confirm-dangerous="confirmDangerous"
      @interaction="forwardInteraction"
    />
  </div>

  <fieldset v-else-if="node.kind === 'group'" class="plugin-node plugin-node--group">
    <legend>{{ node.label }}</legend>
    <PluginUiNodeRenderer
      v-for="child in node.children"
      :key="child.id"
      :node="child"
      :editable="editable"
      :busy="busy"
      :confirm-dangerous="confirmDangerous"
      @interaction="forwardInteraction"
    />
  </fieldset>

  <section v-else-if="node.kind === 'tabs'" class="plugin-node plugin-node--tabs">
    <div role="tablist" :aria-label="node.id">
      <button
        v-for="tab in node.tabs"
        :id="domId(`tab-${tab.id}`)"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="tab.id === node.selectedId"
        :aria-controls="domId(`panel-${tab.id}`)"
        :tabindex="tab.id === node.selectedId ? 0 : -1"
        :disabled="!editable || busy"
        @click="emitInteraction(node.id, 'select-tab', tab.id)"
        @keydown="onTabKeydown(node, tab.id, $event)"
      >
        {{ tab.label }}
      </button>
    </div>
    <div
      v-for="tab in node.tabs"
      v-show="tab.id === node.selectedId"
      :id="domId(`panel-${tab.id}`)"
      :key="tab.id"
      role="tabpanel"
      :aria-labelledby="domId(`tab-${tab.id}`)"
    >
      <PluginUiNodeRenderer
        v-for="child in tab.children"
        :key="child.id"
        :node="child"
        :editable="editable"
        :busy="busy"
        :confirm-dangerous="confirmDangerous"
        @interaction="forwardInteraction"
      />
    </div>
  </section>

  <p
    v-else-if="node.kind === 'text'"
    :class="['plugin-node', 'plugin-node--text', `plugin-tone--${node.tone}`]"
  >
    {{ node.text }}
  </p>

  <span
    v-else-if="node.kind === 'badge'"
    :class="['plugin-node', 'plugin-node--badge', `plugin-tone--${node.tone}`]"
  >
    {{ node.text }}
  </span>

  <dl v-else-if="node.kind === 'key-value-list'" class="plugin-node plugin-node--key-values">
    <template v-for="entry in node.entries" :key="entry.key">
      <dt>{{ entry.key }}</dt>
      <dd :class="entry.tone ? `plugin-tone--${entry.tone}` : undefined">{{ entry.value }}</dd>
    </template>
  </dl>

  <div v-else-if="node.kind === 'progress'" class="plugin-node plugin-node--progress">
    <label :for="domId('progress')">{{ node.label }}</label>
    <progress :id="domId('progress')" :value="node.completed" :max="Math.max(node.total, 1)" />
    <output>{{ node.completed }} / {{ node.total }}</output>
  </div>

  <pre
    v-else-if="node.kind === 'log'"
    class="plugin-node plugin-node--log"
    role="log"
    aria-live="polite"
    aria-relevant="additions text"
    >{{ node.text }}</pre>

  <pre v-else-if="node.kind === 'code'" class="plugin-node plugin-node--code"><code
    :data-language="node.language"
  >{{ node.text }}</code></pre>

  <div v-else-if="node.kind === 'table'" class="plugin-node plugin-node--table">
    <div class="plugin-node__table-scroll" tabindex="0">
      <table>
        <thead>
          <tr>
            <th v-for="column in node.columns" :key="column.id" scope="col">
              {{ column.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in node.rows" :key="rowIndex">
            <td v-for="(cell, columnIndex) in row" :key="node.columns[columnIndex]?.id">
              {{ cell }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav
      v-if="node.pageCount > 1"
      :aria-label="t('plugins.surface.table_pages')"
      class="plugin-node__pagination"
    >
      <button
        type="button"
        :disabled="!editable || busy || node.page === 0"
        @click="emitInteraction(node.id, 'request-page', String(node.page - 1))"
      >
        {{ t('plugins.surface.previous_page') }}
      </button>
      <span>{{ node.page + 1 }} / {{ node.pageCount }}</span>
      <button
        type="button"
        :disabled="!editable || busy || node.page + 1 >= node.pageCount"
        @click="emitInteraction(node.id, 'request-page', String(node.page + 1))"
      >
        {{ t('plugins.surface.next_page') }}
      </button>
    </nav>
  </div>

  <label
    v-else-if="node.kind === 'text-input' || node.kind === 'number-input'"
    class="plugin-node plugin-node--field"
  >
    <span>{{ node.label }}</span>
    <input
      :type="node.kind === 'number-input' ? 'number' : 'text'"
      :value="node.value"
      :min="node.kind === 'number-input' ? node.min : undefined"
      :max="node.kind === 'number-input' ? node.max : undefined"
      :step="node.kind === 'number-input' ? node.step : undefined"
      :disabled="!editable || busy || node.disabled"
      maxlength="4096"
      @input="emitInput(node.id, 'input', $event)"
      @change="emitInput(node.id, 'change', $event)"
    />
  </label>

  <label v-else-if="node.kind === 'select'" class="plugin-node plugin-node--field">
    <span>{{ node.label }}</span>
    <select
      :value="node.value"
      :disabled="!editable || busy || node.disabled"
      @change="emitInput(node.id, 'change', $event)"
    >
      <option v-for="option in node.options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
  </label>

  <label v-else-if="node.kind === 'toggle'" class="plugin-node plugin-node--toggle">
    <input
      type="checkbox"
      :checked="node.value"
      :disabled="!editable || busy || node.disabled"
      @change="emitToggle(node.id, $event)"
    />
    <span>{{ node.label }}</span>
  </label>

  <button
    v-else-if="node.kind === 'button'"
    type="button"
    :class="['plugin-node', 'plugin-node--button', { 'plugin-node--danger': node.dangerous }]"
    :disabled="!editable || busy || node.disabled"
    @click="activateButton(node)"
  >
    {{ node.label }}
  </button>
</template>

<script setup lang="ts">
import type { PluginSurfaceEventKind, PluginUiNode } from '../../generated/ipc-contracts';
import { t } from '../../lib/i18n';

const props = defineProps<{
  node: PluginUiNode;
  editable: boolean;
  busy: boolean;
  confirmDangerous?: (message: string) => boolean | Promise<boolean>;
}>();

const emit = defineEmits<{
  interaction: [nodeId: string, event: PluginSurfaceEventKind, value?: string];
}>();

defineOptions({ name: 'PluginUiNodeRenderer' });

function domId(suffix: string): string {
  return `plugin-node-${props.node.id}-${suffix}`;
}

function emitInput(nodeId: string, eventKind: 'input' | 'change', event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  emitInteraction(nodeId, eventKind, target.value);
}

function emitToggle(nodeId: string, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  emitInteraction(nodeId, 'change', target.checked ? 'true' : 'false');
}

async function activateButton(node: Extract<PluginUiNode, { kind: 'button' }>): Promise<void> {
  if (node.dangerous) {
    const confirmation = node.confirmation;
    if (!confirmation) return;
    const confirm = props.confirmDangerous ?? globalThis.confirm;
    if (typeof confirm !== 'function' || !(await confirm(confirmation))) return;
  }
  emitInteraction(node.id, 'activate');
}

function emitInteraction(nodeId: string, event: PluginSurfaceEventKind, value?: string): void {
  emit('interaction', nodeId, event, value);
}

function forwardInteraction(nodeId: string, event: PluginSurfaceEventKind, value?: string): void {
  emitInteraction(nodeId, event, value);
}

function onTabKeydown(
  node: Extract<PluginUiNode, { kind: 'tabs' }>,
  tabId: string,
  event: KeyboardEvent,
): void {
  if (!props.editable || props.busy || node.tabs.length === 0) return;
  const current = node.tabs.findIndex((tab) => tab.id === tabId);
  if (current < 0) return;
  let next: number;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    next = (current + 1) % node.tabs.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    next = (current - 1 + node.tabs.length) % node.tabs.length;
  } else if (event.key === 'Home') {
    next = 0;
  } else if (event.key === 'End') {
    next = node.tabs.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  const target = node.tabs[next];
  if (!target) return;
  emitInteraction(node.id, 'select-tab', target.id);
  queueMicrotask(() => document.getElementById(domId(`tab-${target.id}`))?.focus());
}
</script>

<style scoped>
.plugin-node--column,
.plugin-node--group,
.plugin-node--tabs,
.plugin-node--progress,
.plugin-node--field {
  display: grid;
  gap: 0.55rem;
}

.plugin-node--row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.55rem;
}

.plugin-node--group {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  padding: 0.75rem;
}

.plugin-node--group legend {
  padding: 0 0.35rem;
  font-weight: 650;
}

.plugin-node--tabs [role='tablist'] {
  display: flex;
  gap: 0.2rem;
  overflow-x: auto;
  border-bottom: 1px solid var(--border-color);
}

.plugin-node--tabs [role='tab'][aria-selected='true'] {
  border-bottom-color: var(--color-primary);
  font-weight: 700;
}

.plugin-node--badge {
  display: inline-flex;
  width: fit-content;
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
  background: var(--bg-inset);
}

.plugin-node--key-values {
  display: grid;
  grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
  gap: 0.35rem 0.8rem;
  margin: 0;
}

.plugin-node--key-values dt {
  color: var(--text-muted);
}

.plugin-node--key-values dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.plugin-node--progress progress {
  width: 100%;
}

.plugin-node--log,
.plugin-node--code {
  max-height: 24rem;
  margin: 0;
  overflow: auto;
  border-radius: 0.4rem;
  padding: 0.65rem;
  background: var(--bg-inset);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.plugin-node__table-scroll {
  overflow: auto;
}

.plugin-node--table table {
  width: 100%;
  border-collapse: collapse;
}

.plugin-node--table th,
.plugin-node--table td {
  border-bottom: 1px solid var(--border-color);
  padding: 0.4rem 0.55rem;
  text-align: left;
}

.plugin-node__pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  padding-top: 0.5rem;
}

.plugin-node--field input,
.plugin-node--field select,
.plugin-node--button,
.plugin-node--tabs button,
.plugin-node__pagination button {
  min-height: 2.25rem;
  border: 1px solid var(--border-color);
  border-radius: 0.35rem;
  padding: 0.35rem 0.55rem;
  background: var(--bg-inset);
  color: inherit;
}

.plugin-node--toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.plugin-node--danger {
  border-color: var(--color-error);
  color: var(--color-error);
}

.plugin-tone--muted {
  color: var(--text-muted);
}

.plugin-tone--info {
  color: var(--color-primary);
}

.plugin-tone--success {
  color: var(--color-success);
}

.plugin-tone--warning {
  color: var(--color-warning);
}

.plugin-tone--danger {
  color: var(--color-error);
}

button:focus-visible,
input:focus-visible,
select:focus-visible,
[tabindex='0']:focus-visible {
  outline: 3px solid var(--color-primary);
  outline-offset: 2px;
}
</style>
