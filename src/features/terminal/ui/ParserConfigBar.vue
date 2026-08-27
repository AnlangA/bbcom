<template>
  <section class="parser-config-shell" :class="{ editing }">
    <header class="parser-header">
      <span class="pp-title">
        <Binary class="icon-sm" />
        {{ t('parser.title') }}
      </span>
      <span class="pp-config-summary" :title="configSummary">{{ configSummary }}</span>
      <n-button
        v-if="!editing"
        size="tiny"
        quaternary
        class="pp-edit"
        :aria-label="t('parser.config.edit')"
        @click="$emit('edit')"
      >
        <template #icon><Pencil class="icon-sm" /></template>
        {{ t('parser.config.edit') }}
      </n-button>
      <button
        class="pp-close"
        type="button"
        :title="t('parser.close')"
        :aria-label="t('parser.close')"
        @click="$emit('close')"
      >
        <X class="icon-sm" />
      </button>
    </header>

    <p v-if="recoveryWarning" class="config-recovery-warning" role="status" aria-live="polite">
      {{ recoveryWarning }}
    </p>

    <form
      v-if="editing"
      class="pp-config-drawer"
      :aria-label="t('parser.config.editor')"
      @submit.prevent="$emit('apply')"
      @keydown.esc.prevent.stop="$emit('cancel')"
    >
      <div class="pp-config-grid">
        <label class="config-field config-field-wide">
          <span>{{ t('parser.config.preset') }}</span>
          <AppSelect
            :value="presetId"
            :options="presetOptions"
            :placeholder="t('parser.presetPlaceholder')"
            :aria-label="t('parser.presetPlaceholder')"
            size="small"
            @update:value="(value) => $emit('apply-preset', value)"
          />
          <small v-if="presetDescription" class="config-help">{{ presetDescription }}</small>
        </label>

        <fieldset class="config-mode-field">
          <legend>{{ t('parser.config.mode') }}</legend>
          <div class="parser-kind-options" role="radiogroup" :aria-label="t('parser.config.mode')">
            <button
              v-for="option in kindOptions"
              :key="option.value"
              class="parser-kind-option"
              :class="{ active: kind === option.value }"
              type="button"
              role="radio"
              :aria-checked="kind === option.value"
              :tabindex="kind === option.value ? 0 : -1"
              @click="emit('update:kind', option.value)"
              @keydown="handleKindKeydown($event, option.value)"
            >
              <strong>{{ option.label }}</strong>
              <small>{{ kindDescription(option.value) }}</small>
            </button>
          </div>
        </fieldset>

        <template v-if="kind === 'delimiter'">
          <label class="config-field config-field-wide">
            <span>{{ t('parser.config.delimiter') }}</span>
            <n-input
              :value="delimiterHex"
              size="small"
              :placeholder="t('parser.delimiterPlaceholder')"
              :aria-label="t('parser.delimiterPlaceholder')"
              :input-props="{ spellcheck: false }"
              @update:value="(value) => $emit('update:delimiterHex', value ?? '')"
            />
          </label>
          <label class="config-check-field">
            <n-checkbox
              :checked="includeDelimiter"
              size="small"
              @update:checked="(value) => $emit('update:includeDelimiter', value)"
            >
              {{ t('parser.includeDelimiter') }}
            </n-checkbox>
          </label>
        </template>

        <label v-if="kind === 'fixed'" class="config-field">
          <span>{{ t('parser.config.frameSize') }}</span>
          <n-input-number
            :value="fixedSize"
            size="small"
            :aria-label="t('parser.config.frameSize')"
            @update:value="(value) => $emit('update:fixedSize', value)"
          >
            <template #suffix>B</template>
          </n-input-number>
        </label>

        <template v-if="kind === 'length'">
          <label class="config-field">
            <span>{{ t('parser.config.lengthOffset') }}</span>
            <n-input-number
              :value="lenOffset"
              size="small"
              :aria-label="t('parser.config.lengthOffset')"
              @update:value="(value) => $emit('update:lenOffset', value)"
            />
          </label>
          <label class="config-field">
            <span>{{ t('parser.config.lengthSize') }}</span>
            <AppSelect
              :value="lenSize"
              :aria-label="t('parser.config.lengthSize')"
              :options="lenSizeOptions"
              size="small"
              @update:value="(value) => $emit('update:lenSize', value)"
            />
          </label>
          <label class="config-field">
            <span>{{ t('parser.config.lengthAdjust') }}</span>
            <n-input-number
              :value="lenAdjust"
              size="small"
              :aria-label="t('parser.config.lengthAdjust')"
              @update:value="(value) => $emit('update:lenAdjust', value)"
            />
          </label>
          <label class="config-check-field">
            <n-checkbox
              :checked="lenBigEndian"
              size="small"
              @update:checked="(value) => $emit('update:lenBigEndian', value)"
            >
              {{ t('parser.config.bigEndian') }}
            </n-checkbox>
          </label>
        </template>

        <template v-if="kind === 'mcumgr-smp'">
          <label class="config-field config-field-wide">
            <span>{{ t('parser.smp.transport') }}</span>
            <AppSelect
              :value="smpTransport"
              :aria-label="t('parser.smp.transport')"
              :options="transportOptions"
              size="small"
              @update:value="(value) => $emit('update:smpTransport', value)"
            />
          </label>
          <label class="config-field">
            <span>{{ t('parser.smp.maxPacketBytes') }}</span>
            <n-input-number
              :value="smpMaxPacketBytes"
              size="small"
              :aria-label="t('parser.smp.maxPacketBytes')"
              @update:value="(value) => $emit('update:smpMaxPacketBytes', value)"
            >
              <template #suffix>B</template>
            </n-input-number>
          </label>
          <label class="config-field">
            <span>{{ t('parser.smp.reassemblyTimeout') }}</span>
            <n-input-number
              :value="smpReassemblyTimeoutMs"
              size="small"
              :aria-label="t('parser.smp.reassemblyTimeout')"
              @update:value="(value) => $emit('update:smpReassemblyTimeoutMs', value)"
            >
              <template #suffix>ms</template>
            </n-input-number>
          </label>
        </template>
      </div>

      <div class="pp-config-footer">
        <n-checkbox
          :checked="reparseExisting"
          size="small"
          @update:checked="(value) => $emit('update:reparseExisting', value)"
        >
          {{ t('parser.config.reparseExisting') }}
        </n-checkbox>
        <span v-if="validationError" class="config-error" role="alert">{{ validationError }}</span>
        <n-button size="small" quaternary @click="$emit('cancel')">
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          attr-type="submit"
          :disabled="Boolean(validationError)"
        >
          {{ t('parser.config.apply') }}
        </n-button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { NButton, NCheckbox, NInput, NInputNumber } from 'naive-ui';
import AppSelect from '@/design-system/AppSelect.vue';
import { Binary, Pencil, X } from '@lucide/vue';
import { t } from '@/lib/i18n';

const props = defineProps<{
  editing: boolean;
  configSummary: string;
  recoveryWarning: string;
  validationError: string;
  presetId: string | null;
  presetDescription: string;
  presetOptions: { label: string; value: string }[];
  kindOptions: { label: string; value: string }[];
  lenSizeOptions: { label: string; value: number }[];
  transportOptions: { label: string; value: string }[];
  kind: string;
  delimiterHex: string;
  includeDelimiter: boolean;
  fixedSize: number | null;
  lenOffset: number | null;
  lenSize: number;
  lenBigEndian: boolean;
  lenAdjust: number | null;
  smpTransport: string;
  smpMaxPacketBytes: number | null;
  smpReassemblyTimeoutMs: number | null;
  reparseExisting: boolean;
}>();

const emit = defineEmits<{
  close: [];
  edit: [];
  apply: [];
  cancel: [];
  'apply-preset': [string];
  'update:kind': [string];
  'update:delimiterHex': [string];
  'update:includeDelimiter': [boolean];
  'update:fixedSize': [number | null];
  'update:lenOffset': [number | null];
  'update:lenSize': [number];
  'update:lenBigEndian': [boolean];
  'update:lenAdjust': [number | null];
  'update:smpTransport': [string];
  'update:smpMaxPacketBytes': [number | null];
  'update:smpReassemblyTimeoutMs': [number | null];
  'update:reparseExisting': [boolean];
}>();

function handleKindKeydown(event: KeyboardEvent, value: string): void {
  const currentIndex = props.kindOptions.findIndex((option) => option.value === value);
  if (currentIndex < 0 || props.kindOptions.length === 0) return;

  let nextIndex: number;
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      nextIndex = (currentIndex - 1 + props.kindOptions.length) % props.kindOptions.length;
      break;
    case 'ArrowRight':
    case 'ArrowDown':
      nextIndex = (currentIndex + 1) % props.kindOptions.length;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = props.kindOptions.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  const group = (event.currentTarget as HTMLElement).parentElement;
  emit('update:kind', props.kindOptions[nextIndex].value);
  group?.querySelectorAll<HTMLElement>('[role="radio"]')[nextIndex]?.focus();
}

function kindDescription(kind: string): string {
  if (kind === 'delimiter') return t('parser.kindHelp.delimiter');
  if (kind === 'fixed') return t('parser.kindHelp.fixed');
  if (kind === 'length') return t('parser.kindHelp.length');
  return t('parser.kindHelp.mcumgrSmp');
}
</script>

<style scoped>
.parser-config-shell {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
}

.parser-config-shell.editing {
  box-shadow: 0 8px 20px color-mix(in srgb, var(--bg-primary) 35%, transparent);
  z-index: 2;
}

.config-recovery-warning {
  margin: 0;
  padding: 7px 10px;
  border-top: 1px solid var(--border-subtle);
  background: var(--accent-orange-subtle);
  color: var(--accent-orange);
  font-size: var(--font-size-sm);
}

.parser-header {
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 10px;
  color: var(--text-muted);
}

.pp-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 700;
  letter-spacing: 0.25px;
  white-space: nowrap;
}

.pp-config-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.pp-edit {
  margin-left: auto;
}

.pp-close {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}

.pp-close:hover,
.pp-close:focus-visible {
  color: var(--text-primary);
  background: var(--bg-hover);
  outline: none;
}

.pp-config-drawer {
  padding: 10px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-tertiary);
}

.pp-config-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 10px;
}

.config-field {
  min-width: 0;
  display: grid;
  gap: 5px;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.config-field-wide {
  grid-column: span 2;
}

.config-help {
  color: var(--text-dim);
  line-height: 1.35;
}

.config-mode-field {
  min-width: 0;
  grid-column: 1 / -1;
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.config-mode-field legend {
  margin-bottom: 5px;
  padding: 0;
}

.parser-kind-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
}

.parser-kind-option {
  min-width: 0;
  min-height: 54px;
  display: grid;
  align-content: center;
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-muted);
  text-align: left;
  cursor: pointer;
}

.parser-kind-option strong {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.parser-kind-option small {
  overflow: hidden;
  color: var(--text-dim);
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parser-kind-option:hover,
.parser-kind-option:focus-visible {
  border-color: var(--color-primary-muted);
  background: var(--bg-hover);
  outline: none;
}

.parser-kind-option.active {
  border-color: var(--color-primary);
  background: var(--bg-active);
  box-shadow: inset 0 0 0 1px var(--color-primary-muted);
}

.parser-kind-option.active strong {
  color: var(--color-primary);
}

.config-check-field {
  display: flex;
  align-items: end;
  min-height: 50px;
  padding-bottom: 6px;
}

.pp-config-footer {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
}

.config-error {
  flex: 1;
  color: var(--color-error);
  font-size: var(--font-size-sm);
}

@container parser-panel (max-width: 760px) {
  .pp-config-grid {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }

  .config-field-wide {
    grid-column: span 1;
  }

  .parser-kind-options {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .pp-config-footer {
    flex-wrap: wrap;
  }

  .config-error {
    flex-basis: 100%;
    order: 3;
  }
}

@container parser-panel (max-width: 460px) {
  .pp-config-grid {
    grid-template-columns: 1fr;
  }

  .parser-kind-options {
    grid-template-columns: 1fr;
  }

  .parser-kind-option small {
    white-space: normal;
  }
}
</style>
