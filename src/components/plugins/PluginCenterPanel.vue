<template>
  <section v-if="service" class="plugin-center" :aria-labelledby="headingId">
    <header class="plugin-center__heading">
      <h2 :id="headingId">{{ t('plugins.title') }}</h2>
      <button type="button" :disabled="busy" @click="refresh">{{ t('common.refresh') }}</button>
    </header>

    <p class="plugin-center__trust-warning">
      {{ t('plugins.integrity_warning') }}
    </p>
    <p v-if="snapshot.failure" class="plugin-center__error" role="alert">
      {{ t(`plugins.error.${snapshot.failure.code}`) }}
      <button type="button" @click="service.clearFailure()">{{ t('common.dismiss') }}</button>
    </p>
    <p class="sr-only" role="status" aria-live="polite">{{ statusAnnouncement }}</p>

    <nav class="plugin-center__tabs" role="tablist" :aria-label="t('plugins.title')">
      <button
        v-for="tab in tabs"
        :id="`${headingId}-${tab}`"
        :key="tab"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab"
        :aria-controls="`${headingId}-${tab}-panel`"
        :tabindex="activeTab === tab ? 0 : -1"
        @click="activeTab = tab"
        @keydown="moveTab(tab, $event)"
      >
        {{ t(`plugins.tab.${tab}`) }}
      </button>
    </nav>

    <div
      v-if="activeTab === 'installed'"
      :id="`${headingId}-installed-panel`"
      role="tabpanel"
      :aria-labelledby="`${headingId}-installed`"
      tabindex="0"
    >
      <p v-if="snapshot.installed.length === 0" class="plugin-center__empty">
        {{ t('plugins.installed.empty') }}
      </p>
      <ul v-else class="plugin-center__list">
        <li v-for="plugin in snapshot.installed" :key="plugin.pluginId">
          <div>
            <strong>{{ plugin.displayName }}</strong>
            <small>{{ t('plugins.version', { version: plugin.version }) }}</small>
          </div>
          <span>{{ t(`plugins.status.${plugin.status}`) }}</span>
          <button
            type="button"
            :disabled="busy || lifecycleBusy(plugin.status)"
            @click="setEnabled(plugin.pluginId, !plugin.enabled)"
          >
            {{ t(plugin.enabled ? 'plugins.disable' : 'plugins.enable') }}
          </button>
        </li>
      </ul>
    </div>

    <div
      v-else-if="activeTab === 'catalog'"
      :id="`${headingId}-catalog-panel`"
      role="tabpanel"
      :aria-labelledby="`${headingId}-catalog`"
      tabindex="0"
    >
      <p v-if="snapshot.catalog.length === 0" class="plugin-center__empty">
        {{ t('plugins.catalog.empty') }}
      </p>
      <ul v-else class="plugin-center__list">
        <li v-for="item in snapshot.catalog" :key="item.catalogId">
          <div>
            <strong>{{ item.displayName }}</strong>
            <small>{{ item.description }}</small>
            <small>
              {{ item.publisherName }} ·
              {{
                t(
                  item.publisherVerified
                    ? 'plugins.publisher.verified'
                    : 'plugins.publisher.unverified',
                )
              }}
            </small>
          </div>
          <button
            type="button"
            :disabled="busy || item.installedVersion !== null"
            @click="install(item.catalogId)"
          >
            {{ t(item.installedVersion === null ? 'plugins.install' : 'plugins.installed') }}
          </button>
        </li>
      </ul>
    </div>

    <div
      v-else
      :id="`${headingId}-panels-panel`"
      role="tabpanel"
      :aria-labelledby="`${headingId}-panels`"
      tabindex="0"
      class="plugin-center__panels"
    >
      <p v-if="snapshot.panels.length === 0" class="plugin-center__empty">
        {{ t('plugins.panels.empty') }}
      </p>
      <PluginDeclarativePanel
        v-for="panel in snapshot.panels"
        v-else
        :key="panel.pluginId"
        :panel="panel"
        :busy="busy"
        @event="emitPanelEvent"
      />
    </div>

    <button v-if="busy" type="button" class="plugin-center__cancel" @click="service.cancelAction()">
      {{ t(snapshot.action?.status === 'cancelling' ? 'common.cancelling' : 'common.cancel') }}
    </button>

    <PluginAuthorizationDialog
      v-if="snapshot.authorizationReview"
      :key="snapshot.authorizationReview.reviewId"
      :review="snapshot.authorizationReview"
      :busy="busy"
      @submit="authorize"
      @dismiss="dismissAuthorization"
    />
    <PluginSerialProposalDialog
      v-if="activeProposal"
      :proposal="activeProposal"
      :busy="busy"
      @resolve="resolveProposal"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue';
import { t } from '../../lib/i18n';
import {
  useOptionalPluginCenter,
  type PluginCenterSnapshot,
  type PluginLifecycleStatus,
  type PluginPanelEvent,
  type SubmitPluginAuthorization,
} from '../../features/plugins';
import PluginAuthorizationDialog from './PluginAuthorizationDialog.vue';
import PluginDeclarativePanel from './PluginDeclarativePanel.vue';
import PluginSerialProposalDialog from './PluginSerialProposalDialog.vue';

type PluginTab = 'installed' | 'catalog' | 'panels';

const service = useOptionalPluginCenter();
const headingId = `plugin-center-${useId()}`;
const tabs: readonly PluginTab[] = ['installed', 'catalog', 'panels'];
const activeTab = ref<PluginTab>('installed');
const snapshot = ref<PluginCenterSnapshot>(service?.snapshot() ?? emptySnapshot());
let detach: (() => void) | null = null;

const busy = computed(() => snapshot.value.action !== null);
const activeProposal = computed(() => snapshot.value.serialProposals[0] ?? null);
const statusAnnouncement = computed(() => {
  if (snapshot.value.action) return t(`plugins.action.${snapshot.value.action.status}`);
  if (snapshot.value.failure) return t(`plugins.error.${snapshot.value.failure.code}`);
  return t('plugins.ready');
});

onMounted(() => {
  if (!service) return;
  detach = service.subscribe((next) => {
    snapshot.value = next;
  });
  void service.start();
});

onUnmounted(() => detach?.());

function refresh(): void {
  void service?.refresh();
}

function install(catalogId: string): void {
  void service?.install(catalogId);
}

function setEnabled(pluginId: string, enabled: boolean): void {
  void service?.setEnabled(pluginId, enabled);
}

function authorize(input: SubmitPluginAuthorization): void {
  void service?.submitAuthorization(input);
}

function dismissAuthorization(): void {
  const review = snapshot.value.authorizationReview;
  if (review) void service?.dismissAuthorization(review.reviewId);
}

function resolveProposal(decision: 'approve' | 'reject'): void {
  const proposal = activeProposal.value;
  if (proposal) void service?.resolveSerialProposal(proposal.proposalId, decision);
}

function emitPanelEvent(event: PluginPanelEvent): void {
  void service?.emitPanelEvent(event);
}

function moveTab(current: PluginTab, event: KeyboardEvent): void {
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  const nextIndex = (tabs.indexOf(current) + direction + tabs.length) % tabs.length;
  const next = tabs[nextIndex];
  if (!next) return;
  activeTab.value = next;
  document.getElementById(`${headingId}-${next}`)?.focus();
}

function lifecycleBusy(status: PluginLifecycleStatus): boolean {
  return ['starting', 'updating', 'rolling-back'].includes(status);
}

function emptySnapshot(): PluginCenterSnapshot {
  return Object.freeze({
    revision: 0,
    catalog: Object.freeze([]),
    installed: Object.freeze([]),
    authorizationReview: null,
    serialProposals: Object.freeze([]),
    panels: Object.freeze([]),
    started: false,
    action: null,
    failure: null,
  });
}
</script>

<style scoped>
.plugin-center {
  display: grid;
  gap: 0.8rem;
}

.plugin-center__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.plugin-center__heading h2 {
  margin: 0;
  font-size: 1.05rem;
}

.plugin-center__trust-warning,
.plugin-center__error {
  margin: 0;
  border-left: 3px solid var(--warning-color, #f59e0b);
  padding-left: 0.65rem;
}

.plugin-center__error {
  border-left-color: var(--error-color, #ef4444);
}

.plugin-center__tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border-color, #475569);
}

.plugin-center__tabs button[aria-selected='true'] {
  border-bottom-color: var(--primary-color, #60a5fa);
  font-weight: 700;
}

.plugin-center__list {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-center__list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  border: 1px solid var(--border-color, #475569);
  border-radius: 0.4rem;
  padding: 0.65rem;
}

.plugin-center__list li div,
.plugin-center__list small {
  display: block;
}

.plugin-center__list small {
  color: var(--muted-color, #94a3b8);
}

.plugin-center__panels {
  display: grid;
  gap: 0.75rem;
}

.plugin-center__empty {
  color: var(--muted-color, #94a3b8);
  text-align: center;
}

button {
  min-height: 2.25rem;
  border: 1px solid var(--border-color, #475569);
  border-radius: 0.35rem;
  padding: 0.35rem 0.65rem;
  background: transparent;
  color: inherit;
}

button:focus-visible,
[role='tabpanel']:focus-visible {
  outline: 3px solid var(--primary-color, #60a5fa);
  outline-offset: 2px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
</style>
