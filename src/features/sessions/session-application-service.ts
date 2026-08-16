import type { PortConfig, SerialSession } from '../../types';
import type {
  SessionCapturePort,
  SessionCatalogPort,
  SessionDocumentPort,
  SessionMutationPolicyPort,
} from './session-ports';

export interface SessionApplicationServiceOptions {
  readonly catalog: SessionCatalogPort;
  readonly mutationPolicy: SessionMutationPolicyPort;
  readonly captureFor: (sessionId: string) => SessionCapturePort;
  readonly documentFor: (sessionId: string) => SessionDocumentPort;
  readonly runtimeIsImportant: (sessionId: string) => boolean;
}

/** User-intent façade over the narrow session ports. */
export class SessionApplicationService {
  constructor(private readonly options: SessionApplicationServiceOptions) {}

  createSession(portName: string, config: PortConfig): string | null {
    if (!portName || !this.options.mutationPolicy.userMutationsAllowed.value) return null;
    return this.options.catalog.create(portName, { ...config });
  }

  session(sessionId: string): SerialSession | null {
    return this.options.catalog.sessions.value.find((session) => session.id === sessionId) ?? null;
  }

  isImportant(sessionId: string): boolean {
    const session = this.session(sessionId);
    if (!session) return false;
    const document = this.options.documentFor(sessionId);
    return (
      session.frames.length > 0 ||
      session.pausedFrames.length > 0 ||
      session.autoLogEnabled ||
      document.isDirty.value ||
      this.options.runtimeIsImportant(sessionId)
    );
  }

  async remove(sessionId: string): Promise<boolean> {
    if (!this.options.mutationPolicy.userMutationsAllowed.value) return false;
    return Boolean(await this.options.catalog.remove(sessionId));
  }

  clearCapture(sessionId: string): boolean {
    if (!this.options.mutationPolicy.userMutationsAllowed.value) return false;
    const capture = this.options.captureFor(sessionId);
    if (!capture.session.value || capture.session.value.frames.length === 0) return false;
    capture.clear();
    return true;
  }
}
