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
          <span v-if="session.isConnected" class="tab-status connected" aria-label="已连接"></span>
          <span v-else class="tab-status disconnected" aria-label="未连接"></span>
          <button class="tab-close" type="button" @click.stop="closeSession(session.id)" aria-label="关闭会话" title="关闭会话">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
      <button class="tab-add" type="button" @click="emit('create')" aria-label="新建会话" title="新建会话 (Ctrl+N)">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
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
  height: 36px;
  min-height: 36px;
}

.tabs-list {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  flex: 1;
  padding-top: 3px;
}

.tabs-list::-webkit-scrollbar {
  height: 0;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 5px 14px;
  cursor: pointer;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  white-space: nowrap;
  transition: background var(--transition-normal), color var(--transition-normal);
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
  box-shadow: var(--shadow-inset);
}

.tab-item.active::before {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--gradient-brand);
  border-radius: 2px 2px 0 0;
}

.tab-port {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: 11px;
}

.tab-status {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tab-status.connected {
  background: var(--accent-green);
  box-shadow: 0 0 5px var(--accent-green-glow);
  animation: breathe 2.5s ease-in-out infinite;
}

.tab-status.disconnected {
  background: var(--text-dim);
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: transparent;
  cursor: pointer;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  margin-left: 2px;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.tab-item:hover .tab-close {
  color: var(--text-muted);
}

.tab-close:hover {
  color: var(--text-primary) !important;
  background: rgba(255, 255, 255, 0.12);
}

.tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px dashed var(--border-color);
  color: var(--text-dim);
  cursor: pointer;
  width: 28px;
  height: 26px;
  border-radius: var(--radius-md);
  flex-shrink: 0;
  transition: all var(--transition-normal);
  margin-left: 4px;
}

.tab-add:hover {
  border-color: var(--accent-green);
  border-style: solid;
  color: var(--accent-green);
  background: var(--accent-green-subtle);
  box-shadow: 0 0 8px rgba(76, 175, 80, 0.15);
}
</style>
