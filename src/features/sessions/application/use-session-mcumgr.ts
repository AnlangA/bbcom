export {
  createMcumgrBridge,
  McumgrBridge,
  useSessionMcumgr,
  type McumgrBridgeCreateOptions,
  type McumgrFirmwareUpdateOptions,
  type SessionMcumgrController,
} from './mcumgr-bridge';

/** @deprecated Use `McumgrBridgeCreateOptions` */
export type { McumgrBridgeCreateOptions as UseSessionMcumgrOptions } from './mcumgr-bridge';
