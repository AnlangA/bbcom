<template>
  <div v-if="percentage !== null" class="mc-progress-bar">
    <n-progress
      type="line"
      :percentage="percentage"
      :show-indicator="true"
      :height="5"
      :border-radius="3"
      processing
    />
  </div>
</template>

<script setup lang="ts">
import { NProgress } from 'naive-ui';

defineProps<{
  percentage: number | null;
}>();
</script>

<style scoped>
.mc-progress-bar {
  flex-shrink: 0;
  padding: 6px 10px 4px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-subtle);
}
</style>
