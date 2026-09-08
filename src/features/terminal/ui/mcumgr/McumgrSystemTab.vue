<template>
  <section class="mc-system">
    <div class="echo-section">
      <div class="section-heading">
        <h4>{{ t('mcumgr.os.echo') }}</h4>
        <span>{{ t('mcumgr.os.echoHint') }}</span>
      </div>
      <div class="echo-command">
        <span class="echo-prefix" aria-hidden="true"><Radio :size="16" />echo</span>
        <n-input
          v-model:value="echoModel"
          :disabled="busy"
          :bordered="false"
          class="echo-input"
          :input-props="{ 'aria-label': t('mcumgr.os.echo'), spellcheck: false }"
          @keydown="onEchoKeydown"
        />
        <n-button size="small" type="primary" :disabled="busy" @click="sendEcho">
          {{ t('mcumgr.run') }}<ArrowUpRight :size="14" aria-hidden="true" />
        </n-button>
      </div>
    </div>

    <div class="query-section">
      <h4>{{ t('mcumgr.os.queries') }}</h4>
      <div class="query-list">
        <button
          v-for="query in queries"
          :key="query.action"
          type="button"
          class="query-tool"
          :disabled="busy"
          :aria-label="t(query.label)"
          @click="runQuery(query.action, query.op)"
        >
          <span class="query-icon"
            ><component :is="query.icon" :size="18" :stroke-width="1.6" aria-hidden="true"
          /></span>
          <span class="query-copy"
            ><strong>{{ t(query.label) }}</strong
            ><span>{{ t(query.hint) }}</span></span
          >
          <ChevronRight :size="14" class="query-arrow" aria-hidden="true" />
        </button>
      </div>
    </div>

    <footer class="reset-row">
      <RotateCcw :size="16" class="reset-icon" aria-hidden="true" />
      <span>{{ t('mcumgr.os.resetHint') }}</span>
      <n-button size="small" quaternary type="error" :disabled="busy" @click="resetDevice">
        {{ t('mcumgr.os.reset') }}
      </n-button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NInput } from 'naive-ui';
import {
  ArrowUpRight,
  ChevronRight,
  CircuitBoard,
  Clock3,
  ListTree,
  MemoryStick,
  Package,
  Radio,
  RotateCcw,
  SlidersHorizontal,
} from '@lucide/vue';
import { t } from '@/lib/i18n';
import type { McumgrOp } from '@/generated/ipc-contracts';
import type { SessionMcumgrController } from '@/features/sessions/application/use-session-mcumgr';

const props = defineProps<{ echo: string; busy: boolean; mcumgr: SessionMcumgrController }>();
const emit = defineEmits<{ 'update:echo': [value: string] }>();
const echoModel = computed({
  get: () => props.echo,
  set: (value: string) => emit('update:echo', value),
});
const queries = [
  {
    action: 'tasks',
    label: 'mcumgr.os.tasks',
    hint: 'mcumgr.os.tasksHint',
    icon: ListTree,
    op: { kind: 'os-tasks' },
  },
  {
    action: 'mpstat',
    label: 'mcumgr.os.mpstat',
    hint: 'mcumgr.os.mpstatHint',
    icon: MemoryStick,
    op: { kind: 'os-memory-pools' },
  },
  {
    action: 'datetime',
    label: 'mcumgr.os.datetime',
    hint: 'mcumgr.os.datetimeHint',
    icon: Clock3,
    op: { kind: 'os-datetime' },
  },
  {
    action: 'params',
    label: 'mcumgr.os.params',
    hint: 'mcumgr.os.paramsHint',
    icon: SlidersHorizontal,
    op: { kind: 'os-params' },
  },
  {
    action: 'info',
    label: 'mcumgr.os.info',
    hint: 'mcumgr.os.infoHint',
    icon: Package,
    op: { kind: 'os-info', format: null },
  },
  {
    action: 'bootloader',
    label: 'mcumgr.os.bootloader',
    hint: 'mcumgr.os.bootloaderHint',
    icon: CircuitBoard,
    op: { kind: 'os-bootloader-info' },
  },
] satisfies { action: string; label: string; hint: string; icon: unknown; op: McumgrOp }[];

function sendEcho() {
  if (!props.busy) void props.mcumgr.runOsEcho(props.echo);
}
function onEchoKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  sendEcho();
}
function runQuery(action: string, op: McumgrOp) {
  if (!props.busy) void props.mcumgr.execute(action, op);
}
function resetDevice() {
  if (props.busy || !window.confirm(t('mcumgr.confirm.reset'))) return;
  void props.mcumgr.execute('reset', { kind: 'os-reset', force: false });
}
</script>

<style scoped>
.mc-system {
  container: system-tools / inline-size;
  min-width: 0;
  padding: 4px 2px 0;
}
h4 {
  color: var(--text-secondary);
  font-size: var(--font-size-data);
  font-weight: var(--font-weight-medium);
}
.section-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
  margin-bottom: 10px;
}
.section-heading > span {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
.echo-command {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 5px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  transition: border-color var(--transition-normal);
}
.echo-command:focus-within {
  border-color: var(--color-primary-muted);
}
.echo-prefix {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-left: 9px;
  padding-right: 12px;
  border-right: 1px solid var(--border-color);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-size-data);
}
.echo-prefix svg {
  color: var(--color-primary);
}
.echo-input {
  flex: 1;
  min-width: 0;
  --n-color: transparent !important;
  --n-color-focus: transparent !important;
  --n-font-family: var(--font-mono) !important;
}
.echo-input :deep(.n-input-wrapper) {
  padding-inline: 0;
}
.echo-command :deep(.n-button) {
  flex-shrink: 0;
}
.query-section {
  margin-top: 28px;
}
.query-section > h4 {
  margin-bottom: 10px;
}
.query-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 22px;
}
.query-tool {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  min-height: 72px;
  padding: 12px 6px;
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  border-radius: 0;
  background: transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.query-icon {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-muted);
  transition:
    color var(--transition-normal),
    border-color var(--transition-normal);
}
.query-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.query-copy strong {
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  font-size: var(--font-size-base);
}
.query-copy > span {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
}
.query-arrow {
  flex-shrink: 0;
  color: var(--text-dim);
  transition:
    color var(--transition-normal),
    transform var(--transition-normal);
}
.query-tool:hover:not(:disabled) {
  background: var(--bg-hover);
  border-radius: var(--radius-md);
}
.query-tool:hover:not(:disabled) .query-icon {
  color: var(--color-primary);
  border-color: var(--color-primary-muted);
}
.query-tool:hover:not(:disabled) .query-arrow {
  color: var(--color-primary);
  transform: translateX(2px);
}
.query-tool:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
  border-radius: var(--radius-md);
}
.query-tool:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.reset-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 4px 0;
  margin-top: 18px;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}
.reset-icon {
  flex-shrink: 0;
  color: var(--text-dim);
}
.reset-row > span {
  flex: 1;
  line-height: var(--line-height-normal);
}
.reset-row :deep(.n-button) {
  flex-shrink: 0;
}
@container system-tools (max-width: 420px) {
  .query-list {
    grid-template-columns: minmax(0, 1fr);
  }
  .query-tool {
    min-height: 64px;
  }
  .echo-prefix {
    padding-left: 5px;
    padding-right: 8px;
  }
  .echo-prefix svg {
    display: none;
  }
}
</style>
