import type { InjectionKey } from 'vue';

/** Centralized Vue injection keys. Value types are enforced by feature inject helpers. */
export const SESSION_APPLICATION_SERVICES_KEY: InjectionKey<unknown> = Symbol(
  'bbcom.session-application-services',
);

export const SESSION_UI_STATE_KEY: InjectionKey<unknown> = Symbol('bbcom-session-ui-state');

export const WORKSPACE_APPLICATION_KEY: InjectionKey<unknown> = Symbol(
  'bbcom-workspace-application',
);

export const APPLICATION_SHUTDOWN_KEY: InjectionKey<unknown> = Symbol('bbcom-application-shutdown');
