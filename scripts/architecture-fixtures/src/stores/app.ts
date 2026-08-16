import { invoke } from '@tauri-apps/api/core';
import { listPorts } from 'tauri-plugin-serialplugin-api';
export const appStore = { invoke, listPorts };
