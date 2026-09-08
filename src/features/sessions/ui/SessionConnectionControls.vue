<template>
  <div class="connection-controls">
    <n-button
      class="connection-toggle"
      size="small"
      :type="buttonType"
      :loading="transitioning"
      :disabled="connectionLocked || transitioning"
      :aria-label="buttonLabel"
      :aria-busy="transitioning"
      @click="onPrimaryAction"
    >
      <template #icon
        ><Cable v-if="needsRebind" class="icon-sm" /><PowerOff
          v-else-if="isConnected"
          class="icon-sm" /><Power v-else class="icon-sm"
      /></template>
      {{ buttonLabel }}
    </n-button>
    <span class="connection-cancel-slot">
      <IconActionButton
        v-show="canCancel"
        :label="reconnecting ? t('serial.action.cancelReconnect') : t('serial.action.cancelOpen')"
        :disabled="!canCancel"
        @click="cancelConnection"
        ><X class="icon-sm"
      /></IconActionButton>
    </span>
    <span
      class="connection-state"
      :class="{
        connected: isConnected && !transitioning,
        pending: transitioning,
        failed: closeFailed && !transitioning,
      }"
      role="status"
      aria-live="polite"
      :title="statusLabel"
    >
      <span class="connection-dot" aria-hidden="true"></span>
      <span class="connection-state-text">{{ statusLabel }}</span>
    </span>
    <span class="connection-baud">{{ baudRate }} <span>bps</span></span>
    <span class="connection-divider" aria-hidden="true"></span>
    <n-button
      class="capture-action"
      size="small"
      quaternary
      :disabled="!canClear"
      @click="$emit('clear')"
    >
      <template #icon><Trash2 class="icon-sm" /></template>
      {{ t('session.clear') }}
    </n-button>
    <n-button
      class="capture-action"
      :disabled="isClosing || (!isConnected && !capturePaused)"
      size="small"
      quaternary
      :type="capturePaused ? 'warning' : 'default'"
      :title="capturePaused ? t('session.resume.title') : t('session.pause.title')"
      :aria-pressed="capturePaused"
      @click="$emit('toggle-pause')"
    >
      <template #icon>
        <Play v-if="capturePaused" class="icon-sm" />
        <Pause v-else class="icon-sm" />
      </template>
      {{ capturePaused ? t('session.resume') : t('session.pause') }}
    </n-button>
    <n-button
      class="capture-action"
      size="small"
      quaternary
      :loading="sendingBreak"
      :disabled="!isConnected || connectionLocked || transitioning"
      :title="t('session.break.title')"
      @click="$emit('send-break')"
    >
      <template #icon><Unplug class="icon-sm" /></template>
      {{ t('session.break') }}
    </n-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton } from 'naive-ui';
import { Cable, Pause, Play, Power, PowerOff, Trash2, Unplug, X } from '@lucide/vue';
import IconActionButton from '@/design-system/IconActionButton.vue';
import { t } from '@/lib/i18n';

const props = defineProps<{
  isConnected: boolean;
  isConnecting: boolean;
  isClosing?: boolean;
  closeFailed?: boolean;
  reconnecting: boolean;
  needsRebind?: boolean;
  connectionLocked?: boolean;
  baudRate: number;
  capturePaused: boolean;
  canClear: boolean;
  sendingBreak: boolean;
}>();

const emit = defineEmits<{
  connect: [];
  disconnect: [];
  rebind: [];
  clear: [];
  'toggle-pause': [];
  'send-break': [];
}>();

const transitioning = computed(() => props.isConnecting || props.isClosing || props.reconnecting);
const canCancel = computed(
  () => !props.connectionLocked && !props.isClosing && (props.isConnecting || props.reconnecting),
);
const buttonType = computed(() =>
  transitioning.value
    ? 'default'
    : props.closeFailed || props.needsRebind
      ? 'warning'
      : props.isConnected
        ? 'default'
        : 'primary',
);
const buttonLabel = computed(() => {
  if (props.isClosing) return t('serial.action.closing');
  if (props.reconnecting) return t('serial.action.reconnecting');
  if (props.isConnecting) return t('serial.action.opening');
  if (props.closeFailed) return t('serial.action.retryClose');
  if (props.needsRebind) return t('session.rebind');
  return t(props.isConnected ? 'serial.action.close' : 'serial.action.open');
});
function onPrimaryAction() {
  if (props.connectionLocked || transitioning.value) return;
  if (props.closeFailed) emit('disconnect');
  else if (props.needsRebind) emit('rebind');
  else if (props.isConnected) emit('disconnect');
  else emit('connect');
}
function cancelConnection() {
  if (canCancel.value) emit('disconnect');
}
const statusLabel = computed(() => {
  if (props.isClosing) return t('serial.action.closing');
  if (props.closeFailed) return t('serial.status.closeFailed');
  if (props.reconnecting) return t('session.reconnecting');
  if (props.isConnecting) return t('session.connecting');
  return t(props.isConnected ? 'session.connected' : 'session.disconnected');
});
</script>

<style scoped>
.connection-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-xs) var(--space-sm);
  min-width: 0;
}

.connection-toggle {
  width: 112px;
  flex: 0 0 112px;
}
.connection-cancel-slot {
  display: flex;
  align-items: center;
  width: 28px;
  height: var(--control-h-md);
  flex: 0 0 28px;
}
.capture-action {
  width: 68px;
  flex: 0 0 68px;
}
.connection-state-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.connection-state {
  width: 104px;
  flex: 0 0 104px;
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.connection-state.connected {
  color: var(--accent-green);
}

.connection-state.failed {
  color: var(--color-error);
}

.connection-state.pending {
  color: var(--accent-amber);
}

.connection-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: currentColor;
}

.connection-baud {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.connection-baud span {
  color: var(--text-dim);
  font-family: var(--font-sans);
}

.connection-divider {
  width: 1px;
  height: 16px;
  margin: 0 var(--space-2xs);
  background: var(--border-subtle);
}
</style>
