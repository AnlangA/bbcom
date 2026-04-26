<template>
  <div class="session-tabs">
    <div class="tabs-header">
      <div class="tabs-list">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="tab-item"
          :class="{ active: session.id === activeId }"
          @click="switchSession(session.id)"
          :title="tabTooltip(session)"
        >
          <span class="tab-port">{{ session.portName }}</span>
          <span v-if="session.isConnected" class="tab-status connected">●</span>
          <span v-else class="tab-status disconnected">○</span>
          <button class="tab-close" type="button" @click.stop="closeSession(session.id)" title="关闭会话">×</button>
        </div>
      </div>
      <button class="tab-add" type="button" @click="emit('create')" title="新建会话 (Ctrl+N)">+</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSessionStore } from '../../stores/sessions';
import { useSessionActions } from '../../composables/useSessionActions';
import type { SerialSession } from '../../types';

const sessionStore = useSessionStore();
const { requestCloseSession } = useSessionActions();

const activeId = computed(() => sessionStore.activeSessionId ?? '');
const sessions = computed(() => sessionStore.sessions);

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

const emit = defineEmits<{
  (e: 'create'): void;
}>();
</script>

<style scoped>
.session-tabs {
  flex-shrink: 0;
}

.tabs-header {
  display: flex;
  align-items: center;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  padding: 0 6px;
  height: 34px;
  min-height: 34px;
}

.tabs-list {
  display: flex;
  gap: 1px;
  overflow-x: auto;
  flex: 1;
  padding-top: 2px;
}

.tabs-list::-webkit-scrollbar {
  height: 0;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  cursor: pointer;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  white-space: nowrap;
  transition: background var(--transition-normal), color var(--transition-normal), border-color var(--transition-normal);
  user-select: none;
  border-bottom: 2px solid transparent;
  position: relative;
}

.tab-item:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.tab-item.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  border-bottom-color: var(--accent-green);
}

.tab-port {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: 11px;
}

.tab-status {
  font-size: 7px;
  line-height: 1;
}

.tab-status.connected {
  color: var(--accent-green);
  text-shadow: 0 0 4px rgba(76, 175, 80, 0.5);
}

.tab-status.disconnected {
  color: var(--text-dim);
}

.tab-close {
  background: none;
  border: none;
  color: transparent;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 1px;
  border-radius: 2px;
  margin-left: 2px;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.tab-item:hover .tab-close {
  color: var(--text-muted);
}

.tab-close:hover {
  color: var(--text-primary) !important;
  background: rgba(255, 255, 255, 0.1);
}

.tab-add {
  background: none;
  border: 1px dashed var(--border-color);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 15px;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--transition-normal);
  margin-left: 4px;
}

.tab-add:hover {
  border-color: var(--accent-green);
  border-style: solid;
  color: var(--accent-green);
  background: var(--accent-green-subtle);
}
</style>
