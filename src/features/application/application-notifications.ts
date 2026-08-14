export type ApplicationNotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface ApplicationNotificationPort {
  info(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

export type ApplicationNotificationSink = ApplicationNotificationPort;

/**
 * Application-owned notification fan-out. Runtime code receives this stable
 * port instead of reading a component injection context; the visible shell
 * may attach and detach a concrete UI sink without owning runtime lifetime.
 */
export class ApplicationNotificationRouter implements ApplicationNotificationPort {
  private readonly sinks = new Set<ApplicationNotificationSink>();
  private shutDown = false;

  attach(sink: ApplicationNotificationSink): () => void {
    if (this.shutDown) return () => undefined;
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  info(message: string): void {
    this.publish('info', message);
  }

  success(message: string): void {
    this.publish('success', message);
  }

  warning(message: string): void {
    this.publish('warning', message);
  }

  error(message: string): void {
    this.publish('error', message);
  }

  shutdown(): void {
    this.shutDown = true;
    this.sinks.clear();
  }

  private publish(level: ApplicationNotificationLevel, message: string): void {
    if (this.shutDown) return;
    for (const sink of this.sinks) {
      try {
        sink[level](message);
      } catch {
        // A renderer notification cannot change application task state.
      }
    }
  }
}
