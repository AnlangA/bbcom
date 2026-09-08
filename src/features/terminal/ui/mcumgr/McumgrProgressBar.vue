<template>
  <div
    class="mc-progress-bar"
    role="progressbar"
    :aria-label="t('mcumgr.result.running')"
    :aria-valuenow="percentage ?? undefined"
    :aria-valuemin="0"
    :aria-valuemax="100"
  >
    <div
      class="mc-progress-fill"
      :class="{ indeterminate: percentage === null }"
      :style="percentage !== null ? { width: `${percentage}%` } : undefined"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/lib/i18n';
defineProps<{ percentage: number | null }>();
</script>

<style scoped>
.mc-progress-bar {
  flex: 0 0 100%;
  width: 100%;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--color-primary-muted);
  overflow: hidden;
}
.mc-progress-fill {
  height: 100%;
  background: var(--color-primary);
  border-radius: inherit;
  transition: width var(--transition-normal);
}
.mc-progress-fill.indeterminate {
  width: 35%;
  animation: transfer-wait 1.5s ease-in-out infinite alternate;
}
@keyframes transfer-wait {
  from {
    transform: translateX(-90%);
  }
  to {
    transform: translateX(285%);
  }
}
</style>
