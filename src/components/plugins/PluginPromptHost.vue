<template>
  <PluginSerialProposalDialog
    v-if="activeProposal"
    :proposal="activeProposal"
    :busy="busy"
    @resolve="resolve"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  useOptionalPluginCenter,
  type PluginCenterSnapshot,
  type PluginSerialProposal,
} from '../../features/plugins';
import PluginSerialProposalDialog from './PluginSerialProposalDialog.vue';

/**
 * Application-scoped prompt surface. It remains mounted while users switch
 * between sessions, settings, and the plugin workspace, so a first-write
 * review cannot become unreachable merely because a panel was closed.
 */
const service = useOptionalPluginCenter();
const snapshot = ref<PluginCenterSnapshot | null>(service?.snapshot() ?? null);
let detach: (() => void) | null = null;

/** Proposals already hidden locally because their TTL elapsed. */
const dismissedExpired = ref<ReadonlySet<string>>(new Set());
const liveProposal = computed<PluginSerialProposal | null>(
  () =>
    snapshot.value?.serialProposals.find(
      (proposal) => !dismissedExpired.value.has(proposal.proposalId),
    ) ?? null,
);
const activeProposal = computed<PluginSerialProposal | null>(() => {
  const proposal = liveProposal.value;
  // Belt-and-braces: never offer an approve button whose backend resolution
  // would already be `NoAction(Expired)` — the user would see success while
  // nothing was sent.
  return proposal && Date.now() < proposal.expiresAtMs ? proposal : null;
});
const busy = computed(
  () => snapshot.value?.action?.kind === 'serial-proposal' && snapshot.value.action !== null,
);

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleExpiry(proposal: PluginSerialProposal | null): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  if (!proposal) return;
  const remaining = Math.max(0, proposal.expiresAtMs - Date.now());
  expiryTimer = setTimeout(() => {
    const next = new Set(dismissedExpired.value);
    next.add(proposal.proposalId);
    dismissedExpired.value = next;
  }, remaining + 50);
}

watch(liveProposal, (proposal) => scheduleExpiry(proposal), { immediate: true });

onMounted(() => {
  if (!service) return;
  detach = service.subscribe((next) => {
    snapshot.value = next;
  });
});

onUnmounted(() => {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  detach?.();
});

function resolve(decision: 'approve' | 'reject'): void {
  const proposal = activeProposal.value;
  if (!proposal || busy.value) return;
  void service?.resolveSerialProposal(proposal.proposalId, decision);
}
</script>
