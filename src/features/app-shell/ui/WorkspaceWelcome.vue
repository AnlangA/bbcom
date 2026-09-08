<template>
  <section class="empty-state" aria-labelledby="welcome-title">
    <div class="welcome-content">
      <div class="welcome-eyebrow"><span class="welcome-dot"></span>{{ t('welcome.eyebrow') }}</div>
      <div class="empty-mark" aria-hidden="true"><Cable /></div>
      <h1 id="welcome-title">{{ t('session.empty.title') }}</h1>
      <p class="welcome-description">{{ t('session.empty.hint') }}</p>
      <n-button type="primary" size="large" :disabled="!canCreate" @click="emit('create')">
        <template #icon><Plus :size="16" /></template>
        {{ t('common.newSession') }}
        <ArrowRight :size="15" aria-hidden="true" />
      </n-button>
      <span class="welcome-shortcut"
        ><kbd>Ctrl</kbd><kbd>N</kbd>{{ t('shortcut.newSession') }}</span
      >
    </div>
    <div class="welcome-features">
      <div v-for="feature in features" :key="feature.key" class="welcome-feature">
        <component :is="feature.icon" :size="19" aria-hidden="true" />
        <div>
          <h2>{{ t(`welcome.${feature.key}.title`) }}</h2>
          <p>{{ t(`welcome.${feature.key}.hint`) }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { NButton } from 'naive-ui';
import { ArrowRight, Cable, Plus, Radio, ScanLine, ChartNoAxesCombined } from '@lucide/vue';
import { t } from '@/lib/i18n';

defineProps<{ canCreate: boolean }>();
const emit = defineEmits<{ create: [] }>();
const features = [
  { key: 'connect', icon: Radio },
  { key: 'inspect', icon: ScanLine },
  { key: 'analyze', icon: ChartNoAxesCombined },
];
</script>

<style scoped>
.empty-state {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: safe center;
  gap: 48px;
  padding: 40px 24px;
  background: radial-gradient(ellipse at 50% 30%, var(--color-primary-subtle), transparent 65%);
}
.welcome-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 16px;
}
.welcome-eyebrow {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-muted);
  font-size: var(--font-size-data);
  letter-spacing: 0.1em;
}
.welcome-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-primary);
}
.empty-mark {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  margin: 8px 0;
  border: 1px solid var(--color-primary-muted);
  border-radius: 20px;
  background: var(--bg-primary);
  color: var(--color-primary);
  box-shadow: var(--shadow-md);
}
.empty-mark svg {
  width: 30px;
  height: 30px;
  stroke-width: 1.5;
}
h1 {
  color: var(--text-primary);
  font-size: clamp(22px, 3vw, 30px);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.04em;
}
.welcome-description {
  max-width: 390px;
  color: var(--text-muted);
  line-height: var(--line-height-relaxed);
}
.welcome-shortcut {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
kbd {
  padding: 1px 5px;
  border: 1px solid var(--border-color);
  border-bottom-width: 2px;
  border-radius: var(--radius-xs);
  background: var(--bg-secondary);
}
.welcome-features {
  width: min(100%, 680px);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-top: 1px solid var(--border-color);
  padding-top: 24px;
  gap: 24px;
}
.welcome-feature {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  color: var(--text-secondary);
}
.welcome-feature svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--color-primary);
}
h2 {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  margin-bottom: 6px;
}
.welcome-feature p {
  color: var(--text-muted);
  font-size: var(--font-size-data);
  line-height: var(--line-height-relaxed);
}
@media (max-width: 900px) {
  .welcome-features {
    grid-template-columns: 1fr;
    gap: 16px;
    max-width: 360px;
  }
  .empty-state {
    gap: 28px;
    padding: 28px 20px;
  }
}
</style>
