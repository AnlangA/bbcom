import { ShutdownCoordinator } from './shutdown-coordinator';
import type {
  ShutdownCancellation,
  ShutdownCloseRequest,
  ShutdownConfirmation,
  ShutdownDrainResult,
} from './types';

/**
 * Application-boundary port. The integration owner maps these values to the
 * Rust-generated IPC DTOs; this feature deliberately does not duplicate them.
 */
export interface ShutdownProtocolPort {
  submitShutdownReport(result: ShutdownDrainResult): void | Promise<void>;
  confirmExit(confirmation: ShutdownConfirmation): void | Promise<void>;
  cancelExit(cancellation: ShutdownCancellation): void | Promise<void>;
}

/** Adapts prevented native close requests and UI decisions to the coordinator. */
export class ShutdownProtocolAdapter {
  private readonly publications = new WeakMap<
    Promise<ShutdownDrainResult>,
    Promise<ShutdownDrainResult>
  >();
  private readonly confirmations = new Map<string, Promise<ShutdownConfirmation>>();
  private readonly cancellations = new Map<string, Promise<ShutdownCancellation>>();

  constructor(
    private readonly coordinator: ShutdownCoordinator,
    private readonly port: ShutdownProtocolPort,
  ) {}

  handleCloseRequest(request: ShutdownCloseRequest): Promise<ShutdownDrainResult> {
    return this.publish(this.coordinator.requestClose(request));
  }

  wait(attemptId: string): Promise<ShutdownDrainResult> {
    return this.publish(this.coordinator.wait(attemptId));
  }

  cancel(attemptId: string): Promise<ShutdownCancellation> {
    const cancellation = this.coordinator.cancel(attemptId);
    const existing = this.cancellations.get(cancellation.attemptId);
    if (existing) return existing;
    const publication = Promise.resolve()
      .then(() => this.port.cancelExit(cancellation))
      .then(() => this.coordinator.acknowledgeCancellation(cancellation.attemptId))
      .catch((error: unknown) => {
        this.cancellations.delete(cancellation.attemptId);
        throw error;
      });
    this.cancellations.set(cancellation.attemptId, publication);
    return publication;
  }

  force(attemptId: string): Promise<ShutdownConfirmation> {
    const confirmation = this.coordinator.force(attemptId);
    return this.publishConfirmation(confirmation);
  }

  confirmExit(attemptId: string): Promise<ShutdownConfirmation> {
    const confirmation = this.coordinator.confirmExit(attemptId);
    return this.publishConfirmation(confirmation);
  }

  /** Retry publishing the latest immutable report without running drains again. */
  retryReport(attemptId: string): Promise<ShutdownDrainResult> {
    return this.publish(this.coordinator.requestClose({ attemptId }));
  }

  private publish(source: Promise<ShutdownDrainResult>): Promise<ShutdownDrainResult> {
    const existing = this.publications.get(source);
    if (existing) return existing;
    const publication = source
      .then(async (result) => {
        await this.port.submitShutdownReport(result);
        return result;
      })
      .catch((error: unknown) => {
        this.publications.delete(source);
        throw error;
      });
    this.publications.set(source, publication);
    return publication;
  }

  private publishConfirmation(confirmation: ShutdownConfirmation): Promise<ShutdownConfirmation> {
    const existing = this.confirmations.get(confirmation.attemptId);
    if (existing) return existing;
    const publication = Promise.resolve()
      .then(() => this.port.confirmExit(confirmation))
      .then(() => this.coordinator.acknowledgeConfirmation(confirmation.attemptId))
      .catch((error: unknown) => {
        this.confirmations.delete(confirmation.attemptId);
        throw error;
      });
    this.confirmations.set(confirmation.attemptId, publication);
    return publication;
  }
}
