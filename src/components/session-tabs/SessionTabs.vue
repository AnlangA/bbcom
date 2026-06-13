<template>
  <div class="session-tabs">
    <div class="tabs-header">
      <div class="tabs-list">
        <div
          v-for="(session, index) in sessions"
          :key="session.id"
          class="tab-item"
          :class="{
            active: session.id === activeId,
            connected: session.isConnected,
            dragging: dragIndex === index,
            'drag-over': dragOverIndex === index,
          }"
          draggable="true"
          @click="switchSession(session.id)"
          @dragstart="onDragStart(index, $event)"
          @dragover.prevent="onDragOver(index)"
          @dragleave="onDragLeave"
          @drop.prevent="onDrop(index)"
          @dragend="onDragEnd"
          :title="tabTooltip(session)"
        >
          <span class="tab-status-dot" :class="{ connected: session.isConnected }"></span>
          <span class="tab-port">{{ session.portName }}</span>
          <button
            class="tab-close"
            type="button"
            @click.stop="closeSession(session.id)"
            title="关闭会话"
          >
            <X class="icon-sm" />
          </button>
        </div>
      </div>
      <button class="tab-add" type="button" @click="emit('create')" title="新建会话 (Ctrl+N)">
        <Plus class="icon-sm" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Plus, X } from 'lucide-vue-next';
import { useSessionStore } from '../../stores/sessions';
import { useSessionActions } from '../../composables/useSessionActions';
import type { SerialSession } from '../../types';

const emit = defineEmits<{
  (e: 'create'): void;
}>();

const sessionStore = useSessionStore();
const { requestCloseSession } = useSessionActions();

const activeId = computed(() => sessionStore.activeSessionId ?? '');
const sessions = computed(() => sessionStore.sessions);

const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);

function onDragStart(index: number, e: DragEvent) {
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
  if (dragIndex.value !== null && dragIndex.value !== toIndex) {
    sessionStore.reorderSessions(dragIndex.value, toIndex);
  }
}

function onDragEnd() {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

function closeSession(id: string) {
  requestCloseSession(id);
}
function switchSession(id: string) {
  sessionStore.setActiveSession(id);
}

function tabTooltip(session: SerialSession): string {
  const status = session.isConnected ? '已连接' : '未连接';
  const baud = session.portConfig.baudRate;
  const frames = session.frames.length;
  return `${session.portName} | ${baud} bps | ${frames} 帧 | ${status}`;
}
</script>

<style scoped>
.session-tabs {
  flex-shrink: 0;
}

.tabs-header {
  display: flex;
  align-items: center;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
  padding: 6px 8px 0;
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
  font-size: 12px;
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

.tab-item.connected {
  border-left: 2px solid var(--accent-green);
  background-image: linear-gradient(90deg, var(--accent-green-subtle), transparent 80px);
}

.tab-item.connected.active {
  background-image: linear-gradient(90deg, var(--accent-green-subtle), transparent 80px),
    linear-gradient(180deg, var(--bg-primary), var(--bg-primary));
}

.tab-item.dragging {
  opacity: 0.5;
}

.tab-item.drag-over {
  border-left: 2px solid var(--color-primary);
}

.tab-port {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: 11px;
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
  opacity: 0.5;
  cursor: pointer;
  padding: 0;
  border-radius: var(--radius-sm);
  margin-left: 2px;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    opacity var(--transition-fast);
}

.tab-item:hover .tab-close,
.tab-item.active .tab-close {
  opacity: 1;
}

.tab-close:hover {
  color: var(--text-primary) !important;
  background: rgba(255, 255, 255, 0.09);
  opacity: 1;
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
  margin-bottom: 6px;
}

.tab-add:hover {
  border-color: var(--accent-green);
  border-style: solid;
  color: var(--accent-green);
  background: var(--accent-green-subtle);
  transform: scale(1.05);
}
</style>
