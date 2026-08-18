<template>
  <div class="session-tabs">
    <div class="tabs-header">
      <div class="tabs-list" role="tablist" :aria-label="t('session.tabs')">
        <div
          v-for="(session, index) in sessions"
          :key="session.id"
          class="tab-item"
          :class="{
            active: session.id === activeId,
            connected: isConnected(session.id),
            dragging: dragIndex === index,
            'drag-over': dragOverIndex === index,
            disabled: !mutationPolicy.userMutationsAllowed.value,
          }"
          :aria-disabled="!mutationPolicy.userMutationsAllowed.value || undefined"
          :draggable="mutationPolicy.userMutationsAllowed.value"
          @click="switchSession(session.id)"
          @dragstart="onDragStart(index, $event)"
          @dragover.prevent="onDragOver(index)"
          @dragleave="onDragLeave"
          @drop.prevent="onDrop(index)"
          @dragend="onDragEnd"
          :title="tabTooltip(session)"
        >
          <button
            :id="`session-tab-${session.id}`"
            class="tab-button"
            type="button"
            role="tab"
            :aria-selected="session.id === activeId"
            :aria-controls="`session-panel-${session.id}`"
            :tabindex="session.id === activeId ? 0 : -1"
            :aria-disabled="!mutationPolicy.userMutationsAllowed.value"
            @keydown="onTabKeydown(index, $event)"
          >
            <span class="tab-status-dot" :class="{ connected: isConnected(session.id) }"></span>
            <span class="tab-port">{{ session.portName }}</span>
          </button>
          <button
            class="tab-close"
            type="button"
            :disabled="!mutationPolicy.userMutationsAllowed.value"
            @click.stop="closeSession(session.id)"
            :title="t('session.close')"
          >
            <X class="icon-sm" />
          </button>
        </div>
      </div>
      <button
        class="tab-add"
        type="button"
        :disabled="!mutationPolicy.userMutationsAllowed.value"
        @click="createSession"
        :title="t('session.newWithShortcut')"
      >
        <Plus class="icon-sm" />
      </button>
    </div>
    <div v-if="lastDeletedSession" class="undo-banner" role="status" aria-live="polite">
      <span>{{ lastDeletedSession.session.portName || lastDeletedSession.session.id }}</span>
      <button
        type="button"
        class="undo-action"
        :disabled="!mutationPolicy.userMutationsAllowed.value"
        @click="undoDelete"
      >
        {{ t('session.undoDelete') }}
      </button>
      <span v-if="undoFailure" class="undo-conflict" role="alert">
        {{ t(undoFailure === 'limit' ? 'session.undoDeleteLimit' : 'session.undoDeleteConflict') }}
      </span>
    </div>
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ reorderAnnouncement }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Plus, X } from '@lucide/vue';
import { useSessionActions } from '../../composables/useSessionActions';
import { t } from '../../lib/i18n';
import type { SerialSession } from '../../types';
import {
  useSessionCatalog,
  useSessionMutationPolicy,
  useSessionRuntimeStatuses,
} from '../../features/sessions';

const emit = defineEmits<{
  (e: 'create'): void;
}>();

const catalog = useSessionCatalog();
const mutationPolicy = useSessionMutationPolicy();
const { requestCloseSession } = useSessionActions();
const { isConnected } = useSessionRuntimeStatuses();

const activeId = computed(() => catalog.activeSessionId.value ?? '');
const sessions = computed(() => catalog.sessions.value);
const lastDeletedSession = computed(() => catalog.lastDeletedSession.value);

const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);
const undoFailure = ref<'conflict' | 'limit' | null>(null);
const reorderAnnouncement = ref('');

function onDragStart(index: number, e: DragEvent) {
  if (!mutationPolicy.userMutationsAllowed.value) return;
  dragIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }
}

function onDragOver(index: number) {
  dragOverIndex.value = index;
}

function onDragLeave() {
  dragOverIndex.value = null;
}

function onDrop(toIndex: number) {
  if (!mutationPolicy.userMutationsAllowed.value) return;
  if (dragIndex.value !== null && dragIndex.value !== toIndex) {
    catalog.reorder(dragIndex.value, toIndex);
  }
}

function onDragEnd() {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

function closeSession(id: string) {
  if (!mutationPolicy.userMutationsAllowed.value) return;
  undoFailure.value = null;
  requestCloseSession(id);
}

function undoDelete(): void {
  if (!mutationPolicy.userMutationsAllowed.value) return;
  const result = catalog.undo();
  undoFailure.value = result.ok
    ? null
    : result.reason === 'id-conflict'
      ? 'conflict'
      : result.reason === 'limit-exceeded'
        ? 'limit'
        : null;
}
function switchSession(id: string) {
  catalog.activate(id);
}

function createSession(): void {
  if (!mutationPolicy.userMutationsAllowed.value) return;
  emit('create');
}

function onTabKeydown(index: number, event: KeyboardEvent) {
  if (sessions.value.length === 0) return;
  if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    if (!mutationPolicy.userMutationsAllowed.value) return;
    const target = event.key === 'ArrowLeft' ? index - 1 : index + 1;
    if (target < 0 || target >= sessions.value.length) return;
    event.preventDefault();
    const session = sessions.value[index];
    if (!session) return;
    catalog.reorder(index, target);
    reorderAnnouncement.value = t('session.reordered', {
      name: session.portName,
      position: target + 1,
    });
    requestAnimationFrame(() => document.getElementById(`session-tab-${session.id}`)?.focus());
    return;
  }
  let nextIndex: number;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % sessions.value.length;
  else if (event.key === 'ArrowLeft') {
    nextIndex = (index - 1 + sessions.value.length) % sessions.value.length;
  } else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = sessions.value.length - 1;
  else return;
  event.preventDefault();
  const session = sessions.value[nextIndex];
  if (!session) return;
  switchSession(session.id);
  requestAnimationFrame(() => document.getElementById(`session-tab-${session.id}`)?.focus());
}

function tabTooltip(session: SerialSession): string {
  // Track only this session's raw frame-buffer invalidation signal.
  void catalog.framesVersion(session.id);
  const status = isConnected(session.id) ? t('session.connected') : t('session.disconnected');
  const baud = session.portConfig.baudRate;
  const frames = session.frames.length;
  return `${session.portName} | ${baud} bps | ${frames} ${t('status.frames')} | ${status}`;
}
</script>

<style scoped>
.session-tabs {
  flex-shrink: 0;
}

.undo-banner {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-height: 34px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--font-size-data);
}

.undo-action {
  padding: 3px 8px;
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
}

.undo-conflict {
  color: var(--color-error);
}

.tabs-header {
  display: flex;
  align-items: center;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
  /* Left/right padding matches the toolbar below so the tabs' content edge and
     the toolbar's content edge share a vertical line, instead of visually
     stepping inward by 4px. */
  padding: 6px 12px 0;
  height: 42px;
  min-height: 42px;
}

.tabs-list {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
  align-self: stretch;
}

.tabs-list::-webkit-scrollbar {
  height: 0;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 230px;
  padding: 0 10px;
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  font-size: var(--font-size-data);
  color: var(--text-muted);
  background: transparent;
  white-space: nowrap;
  transition:
    background var(--transition-normal),
    color var(--transition-normal),
    border-color var(--transition-normal),
    opacity var(--transition-fast);
  user-select: none;
  position: relative;
}

.tab-button {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.tab-button:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.tab-item:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.tab-item.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  border-color: var(--border-subtle);
  box-shadow: inset 0 2px 0 var(--color-primary);
}

.tab-item.dragging {
  opacity: 0.5;
}

/* Quiesce/read-only windows: switching is fail-closed in the store, so the
 * hot zone at least advertises that it is inert instead of silently eating
 * clicks. */
.tab-item.disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.tab-item.disabled:hover {
  background: transparent;
  color: var(--text-muted);
}

.tab-item.drag-over {
  border-left: 2px solid var(--color-primary);
}

.tab-port {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-status-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--text-dim);
}

.tab-status-dot.connected {
  background: var(--accent-green);
  box-shadow: 0 0 0 3px var(--accent-green-subtle);
}

.tab-close {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  margin-left: 2px;
  opacity: 0;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    opacity var(--transition-fast);
}

.tab-item:hover .tab-close,
.tab-item.active .tab-close,
.tab-close:focus-visible {
  opacity: 1;
}

.tab-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tab-add {
  background: var(--bg-tertiary);
  border: 1px dashed var(--border-color);
  color: var(--text-dim);
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  display: grid;
  place-items: center;
  flex-shrink: 0;
  transition: all var(--transition-normal);
  margin-left: 6px;
  /* Vertically centered by the header's align-items:center; a manual bottom
     margin would push the + button below the tabs' baseline, making it read as
     misaligned with the tab strip. */
}

.tab-add:hover {
  border-color: var(--accent-green);
  border-style: solid;
  color: var(--accent-green);
  background: var(--accent-green-subtle);
  transform: scale(1.05);
}
</style>
