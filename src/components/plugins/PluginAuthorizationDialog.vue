<template>
  <AccessiblePluginDialog
    :title="t('plugins.permissions.title', { name: review.displayName })"
    :close-label="t('common.cancel')"
    :close-disabled="busy"
    @close="emit('dismiss')"
  >
    <p class="plugin-review__version">
      {{ t('plugins.version', { version: review.version }) }}
    </p>

    <p v-if="review.unavailableCapabilities.length" class="plugin-review__unavailable" role="alert">
      {{ t('plugins.permissions.unavailable') }}
      {{ review.unavailableCapabilities.map(capabilityLabel).join(', ') }}
    </p>

    <fieldset v-if="review.persistentPermissions.length" class="plugin-review__group">
      <legend>{{ t('plugins.permissions.persistent') }}</legend>
      <label
        v-for="permission in review.persistentPermissions"
        :key="permission"
        class="plugin-review__option"
      >
        <input v-model="grants[permission]" type="checkbox" :disabled="busy" />
        <span>
          <strong>{{ permissionLabel(permission) }}</strong>
          <small>{{ permissionDescription(permission) }}</small>
        </span>
      </label>
    </fieldset>

    <fieldset v-if="review.perRequestPermissions.length" class="plugin-review__group">
      <legend>{{ t('plugins.permissions.per_request') }}</legend>
      <p>{{ t('plugins.permissions.per_request_help') }}</p>
      <label
        v-for="permission in review.perRequestPermissions"
        :key="permission"
        class="plugin-review__option"
      >
        <input v-model="perRequestAcknowledged[permission]" type="checkbox" :disabled="busy" />
        <span>
          <strong>{{ permissionLabel(permission) }}</strong>
          <small>{{ permissionDescription(permission) }}</small>
        </span>
      </label>
    </fieldset>

    <fieldset v-if="requiresExtraConfirmation" class="plugin-review__risk">
      <legend>{{ t('plugins.permissions.combined_risk') }}</legend>
      <ul>
        <li v-for="reason in review.extraConfirmationReasons" :key="reason">
          {{ t(`plugins.risk.${reason}`) }}
        </li>
      </ul>
      <label class="plugin-review__confirm">
        <input v-model="extraConfirmed" type="checkbox" :disabled="busy" />
        {{ t('plugins.permissions.combined_risk_confirm') }}
      </label>
    </fieldset>

    <div class="plugin-review__actions">
      <button type="button" :disabled="busy" @click="emit('dismiss')">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="primary"
        :disabled="
          busy ||
          !allPerRequestCapabilitiesAcknowledged ||
          (requiresExtraConfirmation && !extraConfirmed)
        "
        @click="submit"
      >
        {{ t('plugins.permissions.save') }}
      </button>
    </div>
  </AccessiblePluginDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { t } from '../../lib/i18n';
import type {
  PluginAuthorizationReview,
  PluginPermission,
  SubmitPluginAuthorization,
} from '../../features/plugins';
import AccessiblePluginDialog from './AccessiblePluginDialog.vue';

const props = defineProps<{
  review: PluginAuthorizationReview;
  busy: boolean;
}>();

const emit = defineEmits<{
  submit: [input: SubmitPluginAuthorization];
  dismiss: [];
}>();

const grants = reactive<Partial<Record<PluginPermission, boolean>>>({});
const perRequestAcknowledged = reactive<Partial<Record<PluginPermission, boolean>>>({});
const extraConfirmed = ref(false);
const grantsAnyCapability = computed(
  () =>
    props.review.persistentPermissions.some((permission) => grants[permission] === true) ||
    props.review.perRequestPermissions.some(
      (permission) => perRequestAcknowledged[permission] === true,
    ),
);
const allPerRequestCapabilitiesAcknowledged = computed(() =>
  props.review.perRequestPermissions.every(
    (permission) => perRequestAcknowledged[permission] === true,
  ),
);
const requiresExtraConfirmation = computed(
  () => props.review.extraConfirmationReasons.length > 0 && grantsAnyCapability.value,
);

watch(
  () => props.review.reviewId,
  () => {
    clearSelections(grants);
    clearSelections(perRequestAcknowledged);
    extraConfirmed.value = false;
  },
);

function submit(): void {
  if (
    props.busy ||
    !allPerRequestCapabilitiesAcknowledged.value ||
    (requiresExtraConfirmation.value && !extraConfirmed.value)
  ) {
    return;
  }
  emit('submit', {
    reviewId: props.review.reviewId,
    decisions: props.review.persistentPermissions.map((permission) => ({
      permission,
      state: grants[permission] === true ? 'granted' : 'denied',
    })),
    perRequestCapabilitiesAcknowledged: props.review.perRequestPermissions.filter(
      (permission) => perRequestAcknowledged[permission] === true,
    ),
    extraConfirmationAcknowledged: !requiresExtraConfirmation.value || extraConfirmed.value,
  });
}

function permissionLabel(permission: PluginPermission): string {
  return t(`plugins.permission.${permission}`);
}

function permissionDescription(permission: PluginPermission): string {
  return t(`plugins.permission.${permission}.description`);
}

function capabilityLabel(capability: PluginPermission | 'network'): string {
  return capability === 'network' ? t('plugins.capability.network') : permissionLabel(capability);
}

function clearSelections(selections: Partial<Record<PluginPermission, boolean>>): void {
  for (const permission of Object.keys(selections) as PluginPermission[]) {
    delete selections[permission];
  }
}
</script>

<style scoped>
.plugin-review__version {
  color: var(--muted-color, #94a3b8);
}

.plugin-review__unavailable,
.plugin-review__risk {
  border: 1px solid var(--warning-color, #f59e0b);
  border-radius: 0.4rem;
  padding: 0.75rem;
}

.plugin-review__group,
.plugin-review__risk {
  margin: 1rem 0;
}

.plugin-review__option {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  margin: 0.75rem 0;
}

.plugin-review__option input,
.plugin-review__confirm input {
  width: 1.1rem;
  height: 1.1rem;
}

.plugin-review__option span,
.plugin-review__option small {
  display: block;
}

.plugin-review__option small {
  margin-top: 0.2rem;
  color: var(--muted-color, #94a3b8);
}

.plugin-review__confirm {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  font-weight: 600;
}

.plugin-review__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 1rem;
}

button {
  min-height: 2.25rem;
  border: 1px solid var(--border-color, #475569);
  border-radius: 0.35rem;
  padding: 0.35rem 0.85rem;
  background: transparent;
  color: inherit;
}

button.primary {
  border-color: var(--primary-color, #60a5fa);
  background: var(--primary-color, #2563eb);
  color: white;
}

button:focus-visible,
input:focus-visible {
  outline: 3px solid var(--primary-color, #60a5fa);
  outline-offset: 2px;
}
</style>
