<script setup lang="ts">
import type { PanelProps } from './types';
import { invoke } from '@tauri-apps/api/core';
import { betaInternal } from '../../beta/internal';
const lazy = () => import('./lazy');
defineProps<PanelProps>();
void invoke;
void lazy;
void betaInternal;
</script>
<template><div /></template>
