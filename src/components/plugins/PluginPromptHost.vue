<template>
  <PluginSerialProposalDialog
    v-if="activeProposal"
    :proposal="activeProposal"
    :busy="busy"
    @resolve="resolve"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
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

const activeProposal = computed<PluginSerialProposal | null>(
  () => snapshot.value?.serialProposals[0] ?? null,
);
const busy = computed(
  () => snapshot.value?.action?.kind === 'serial-proposal' && snapshot.value.action !== null,
);

onMounted(() => {
  if (!service) return;
  detach = service.subscribe((next) => {
    snapshot.value = next;
  });
});

onUnmounted(() => detach?.());

function resolve(decision: 'approve' | 'reject'): void {
  const proposal = activeProposal.value;
  if (!proposal || busy.value) return;
  void service?.resolveSerialProposal(proposal.proposalId, decision);
}
</script>
