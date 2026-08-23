import Panel from '../ui/Panel.vue';
import { invoke } from '@tauri-apps/api/core';
import { helper } from '../../../lib/helper';
export const service = { Panel, invoke, helper };
