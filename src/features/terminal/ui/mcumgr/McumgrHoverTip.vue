<template>
  <span class="mc-hover-tip-host" :class="{ 'is-block': block }">
    <n-tooltip
      trigger="hover"
      :placement="placement"
      :delay="200"
      :disabled="disabled || !text"
      :show="visible"
      @update:show="updateVisible"
    >
      <template #trigger>
        <span
          class="mc-hover-tip"
          :class="{ 'is-block': block }"
          @mouseenter="enter"
          @mouseleave="leave"
          @pointerdown.capture="dismiss"
          @click.capture="dismiss"
          @keydown.capture="onKeydown"
        >
          <slot />
        </span>
      </template>
      <span class="mc-hover-tip-text">{{ text }}</span>
    </n-tooltip>
  </span>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { NTooltip } from 'naive-ui';

const props = withDefaults(
  defineProps<{
    text: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    block?: boolean;
    disabled?: boolean;
  }>(),
  {
    placement: 'top',
    block: false,
    disabled: false,
  },
);

const visible = ref(false);
let hovered = false;
let dismissedUntilLeave = false;

function updateVisible(show: boolean): void {
  visible.value = show && hovered && !dismissedUntilLeave && !props.disabled && Boolean(props.text);
}

function enter(): void {
  hovered = true;
  dismissedUntilLeave = false;
}

function leave(): void {
  hovered = false;
  dismissedUntilLeave = false;
  visible.value = false;
}

function dismiss(): void {
  dismissedUntilLeave = true;
  visible.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') dismiss();
}

// Keep a delayed hover callback or a completed command from reopening help
// under a stationary pointer. Capture listeners leave slot actions untouched.
watch(
  () => props.disabled || !props.text,
  (disabled) => {
    if (disabled) dismiss();
  },
  { flush: 'sync' },
);
</script>

<style scoped>
.mc-hover-tip-host.is-block {
  display: block;
  width: 100%;
}

.mc-hover-tip-host.is-block :deep(.n-tooltip) {
  display: block;
  width: 100%;
}

.mc-hover-tip {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}

.mc-hover-tip.is-block {
  display: flex;
  width: 100%;
}

.mc-hover-tip.is-block :deep(.n-input),
.mc-hover-tip.is-block :deep(.n-button) {
  width: 100%;
}

.mc-hover-tip-text {
  display: inline-block;
  max-width: 24em;
  white-space: normal;
  line-height: var(--line-height-normal);
}
</style>
