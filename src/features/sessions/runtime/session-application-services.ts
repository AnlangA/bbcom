import { inject, type InjectionKey } from 'vue';
import type { SerialSession } from '../../../types';
import type { ApplicationServices } from '../../application/application-services';
import type { ApplicationSessionRuntime } from './session-runtime-factory';

export type SessionApplicationServices = ApplicationServices<
  SerialSession,
  ApplicationSessionRuntime
>;

export const SESSION_APPLICATION_SERVICES_KEY: InjectionKey<SessionApplicationServices> = Symbol(
  'bbcom.session-application-services',
);

export function useSessionApplicationServices(): SessionApplicationServices {
  const services = inject(SESSION_APPLICATION_SERVICES_KEY);
  if (!services) throw new Error('session application services were not provided');
  return services;
}
