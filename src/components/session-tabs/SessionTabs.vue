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
          <button class="tab-close" @click.stop="closeSession(session.id)" title="关闭会话">×</button>
        </div>
      </div>
      <button class="tab-add" @click="emit('create')" title="新建会话 (Ctrl+N)">+</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSessionStore } from '../../stores/sessions';
import type { SerialSession } from '../../types';

const sessionStore = useSessionStore();

const activeId = computed(() => sessionStore.activeSessionId ?? '');
const sessions = computed(() => sessionStore.sessions);

function closeSession(id: string) {
  sessionStore.removeSession(id);
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
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  padding: 0 4px;
  height: 36px;
  min-height: 36px;
}

.tabs-list {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  flex: 1;
}

.tabs-list::-webkit-scrollbar {
  height: 0;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  cursor: pointer;
  border-radius: 4px 4px 0 0;
  font-size: 12px;
  color: #999;
  background: transparent;
  white-space: nowrap;
  transition: all 0.15s;
  user-select: none;
}

.tab-item:hover {
  background: #2d2d2d;
  color: #ccc;
}

.tab-item.active {
  background: var(--bg-primary);
  color: #e0e0e0;
  border-bottom: 2px solid var(--accent-green);
  margin-bottom: -1px;
}

.tab-port {
  font-family: var(--font-mono);
  font-weight: 500;
}

.tab-status {
  font-size: 8px;
}

.tab-status.connected {
  color: var(--accent-green);
}

.tab-status.disconnected {
  color: #666;
}

.tab-close {
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  border-radius: 2px;
  margin-left: 2px;
}

.tab-close:hover {
  color: #e0e0e0;
  background: rgba(255, 255, 255, 0.1);
}

.tab-add {
  background: none;
  border: 1px dashed #555;
  color: #888;
  cursor: pointer;
  font-size: 16px;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s;
}

.tab-add:hover {
  border-color: var(--accent-green);
  color: var(--accent-green);
  background: rgba(76, 175, 80, 0.1);
}
</style>
