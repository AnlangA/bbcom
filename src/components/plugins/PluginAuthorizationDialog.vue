<template>
  <div
    v-if="request"
    ref="dialogRoot"
    class="plugin-authorization"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="headingId"
    :aria-describedby="descriptionId"
    @keydown="trapFocus"
  >
    <div class="plugin-authorization__backdrop" aria-hidden="true" />
    <section class="plugin-authorization__card">
      <h2 :id="headingId">{{ t('plugins.authorization.title') }}</h2>
      <p :id="descriptionId">
        {{
          t('plugins.authorization.description', {
            name: request.displayName,
            version: request.version,
          })
        }}
      </p>
      <p v-if="request.developmentSource" class="plugin-authorization__warning" role="alert">
        {{ t('plugins.authorization.development_warning') }}
      </p>
      <p class="plugin-authorization__digest">
        <span>{{ t('plugins.authorization.digest') }}</span>
        <code>{{ request.digestSha256 }}</code>
      </p>
      <h3>{{ t('plugins.authorization.capabilities') }}</h3>
      <ul>
        <li
          v-for="capability in request.requestedCapabilities"
          :key="capability"
          :class="{ 'plugin-authorization__new': request.addedCapabilities.includes(capability) }"
        >
          <strong>{{ capabilityLabel(capability) }}</strong>
          <span>{{ capabilityDescription(capability) }}</span>
          <small v-if="request.addedCapabilities.includes(capability)">
            {{ t('plugins.authorization.new_capability') }}
          </small>
        </li>
      </ul>
      <p v-if="request.requestedCapabilities.length === 0">
        {{ t('plugins.authorization.no_capabilities') }}
      </p>
      <footer>
        <button type="button" :disabled="busy" @click="$emit('resolve', request, 'reject')">
          {{ t('plugins.authorization.reject') }}
        </button>
        <button
          ref="approveButton"
          type="button"
          class="plugin-authorization__approve"
          :disabled="busy"
          @click="$emit('resolve', request, 'approve')"
        >
          {{ t('plugins.authorization.approve') }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, useId, watch } from 'vue';
import { t } from '../../lib/i18n';
import type { PluginAuthorizationRequestV2, PluginCapabilityV2 } from '../../features/plugins';

const props = defineProps<{
  request: PluginAuthorizationRequestV2 | null;
  busy?: boolean;
}>();

defineEmits<{
  resolve: [request: PluginAuthorizationRequestV2, decision: 'approve' | 'reject'];
}>();

const dialogRoot = ref<HTMLElement | null>(null);
const approveButton = ref<HTMLButtonElement | null>(null);
const headingId = `plugin-authorization-title-${useId()}`;
const descriptionId = `plugin-authorization-description-${useId()}`;

watch(
  () => props.request,
  async (request) => {
    if (!request) return;
    await nextTick();
    approveButton.value?.focus();
  },
  { immediate: true },
);

function capabilityLabel(capability: PluginCapabilityV2): string {
  return t(`plugins.v2_capability.${capability}`);
}

function capabilityDescription(capability: PluginCapabilityV2): string {
  return t(`plugins.v2_capability.${capability}.description`);
}

function trapFocus(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !dialogRoot.value) return;
  const candidates = Array.from(
    dialogRoot.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  );
  const first = candidates[0];
  const last = candidates.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.plugin-authorization {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 1rem;
}

.plugin-authorization__backdrop {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 55%);
}

.plugin-authorization__card {
  position: relative;
  display: grid;
  width: min(680px, 100%);
  max-height: min(760px, calc(100vh - 2rem));
  gap: 0.75rem;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 1rem;
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: var(--shadow-lg);
}

.plugin-authorization h2,
.plugin-authorization h3,
.plugin-authorization p,
.plugin-authorization ul {
  margin: 0;
}

.plugin-authorization ul {
  display: grid;
  gap: 0.5rem;
  padding: 0;
  list-style: none;
}

.plugin-authorization li {
  display: grid;
  gap: 0.2rem;
  border-left: 3px solid var(--border-color);
  padding: 0.5rem 0.65rem;
}

.plugin-authorization li span,
.plugin-authorization li small,
.plugin-authorization__digest span {
  color: var(--text-muted);
}

.plugin-authorization__new,
.plugin-authorization__warning {
  border-left-color: var(--color-warning) !important;
}

.plugin-authorization__warning {
  border-left: 3px solid;
  padding-left: 0.65rem;
}

.plugin-authorization__digest {
  display: grid;
  gap: 0.25rem;
}

.plugin-authorization__digest code {
  overflow-wrap: anywhere;
}

.plugin-authorization footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.plugin-authorization__approve {
  border-color: var(--color-primary);
}
</style>
