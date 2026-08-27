<template>
  <span class="mc-hover-tip-host" :class="{ 'is-block': block }">
    <n-tooltip trigger="hover" :placement="placement" :delay="200" :disabled="!text">
      <template #trigger>
        <span class="mc-hover-tip" :class="{ 'is-block': block }">
          <slot />
        </span>
      </template>
      <span class="mc-hover-tip-text">{{ text }}</span>
    </n-tooltip>
  </span>
</template>

<script setup lang="ts">
import { NTooltip } from 'naive-ui';

withDefaults(
  defineProps<{
    text: string;
    placement?: 'top' | 'bottom' | 'left' | 'right';
    block?: boolean;
  }>(),
  {
    placement: 'top',
    block: false,
  },
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
