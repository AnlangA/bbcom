export { default as SessionRuntimeHost } from './ui/SessionRuntimeHost.vue';
export { SessionRuntimeManager } from './runtime/session-runtime-manager';
export {
  SESSION_APPLICATION_SERVICES_KEY,
  useSessionApplicationServices,
  type SessionApplicationServices,
} from './runtime/session-application-services';
export {
  createDetachedSessionRuntime,
  createSessionRuntimeRegistryOptions,
  type ApplicationSessionRuntime,
  type SessionRuntimeFactoryDependencies,
} from './runtime/session-runtime-factory';
export {
  reconcileResidentSessionIds,
  resolveActiveSessionRuntime,
} from './runtime/session-residency';
