import { inject, type InjectionKey } from 'vue';
import type { PluginCenterService } from './plugin-center-service';

export const PLUGIN_CENTER_KEY: InjectionKey<PluginCenterService> = Symbol('bbcom-plugin-center');

export function usePluginCenter(): PluginCenterService {
  const service = inject(PLUGIN_CENTER_KEY, null);
  if (!service) throw new Error('plugin center context is unavailable');
  return service;
}

export function useOptionalPluginCenter(): PluginCenterService | null {
  return inject(PLUGIN_CENTER_KEY, null);
}
