import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ShutdownCancellation,
  ShutdownCloseRequest,
  ShutdownConfirmation,
  ShutdownDrainResult,
} from './types';
import type { ShutdownProtocolPort } from './shutdown-protocol-adapter';

export const SHUTDOWN_CLOSE_REQUEST_EVENT = 'shutdown-close-request';
export const SUBMIT_SHUTDOWN_REPORT_COMMAND = 'submit_shutdown_report';
export const CONFIRM_EXIT_COMMAND = 'confirm_exit';
export const CANCEL_EXIT_COMMAND = 'cancel_exit';

export interface ShutdownCloseRequestSource {
  listen(handler: (request: ShutdownCloseRequest) => void): Promise<() => void>;
}

export interface TauriShutdownBoundaryNames {
  readonly closeRequestEvent: string;
  readonly submitReportCommand: string;
  readonly confirmExitCommand: string;
  readonly cancelExitCommand: string;
}

const DEFAULT_BOUNDARY_NAMES: TauriShutdownBoundaryNames = Object.freeze({
  closeRequestEvent: SHUTDOWN_CLOSE_REQUEST_EVENT,
  submitReportCommand: SUBMIT_SHUTDOWN_REPORT_COMMAND,
  confirmExitCommand: CONFIRM_EXIT_COMMAND,
  cancelExitCommand: CANCEL_EXIT_COMMAND,
});

/** Native boundary for the prevented-close handshake. */
export class TauriShutdownPort implements ShutdownProtocolPort, ShutdownCloseRequestSource {
  constructor(private readonly names: TauriShutdownBoundaryNames = DEFAULT_BOUNDARY_NAMES) {}

  listen(handler: (request: ShutdownCloseRequest) => void): Promise<() => void> {
    if (!isTauri()) return Promise.resolve(() => undefined);
    return listen<ShutdownCloseRequest>(this.names.closeRequestEvent, (event) => {
      handler(event.payload);
    });
  }

  submitShutdownReport(result: ShutdownDrainResult): Promise<void> {
    return invoke<void>(this.names.submitReportCommand, { result });
  }

  confirmExit(confirmation: ShutdownConfirmation): Promise<void> {
    return invoke<void>(this.names.confirmExitCommand, { confirmation });
  }

  cancelExit(cancellation: ShutdownCancellation): Promise<void> {
    return invoke<void>(this.names.cancelExitCommand, { cancellation });
  }
}
