import type { DataFrame } from '../../../types';

export interface SessionMutationPermissions {
  readonly userMutations: boolean;
  readonly runtimeCapture: boolean;
  readonly preflightRuntimeCapture?: (
    sessionId: string,
    frame: Pick<DataFrame, 'direction' | 'data'>,
  ) => boolean;
  readonly preflightSessionRegistration?: (
    sessionId: string,
    frameCount: number,
    captureBytes: number,
  ) => boolean;
}

/** Synchronous authority installed by workspace persistence. */
export class SessionMutationGate {
  private permissions: SessionMutationPermissions;

  constructor(
    initial: SessionMutationPermissions,
    private readonly onChanged: (permissions: SessionMutationPermissions) => void = () => undefined,
  ) {
    this.permissions = Object.freeze({ ...initial });
  }

  set(permissions: SessionMutationPermissions): void {
    this.permissions = Object.freeze({ ...permissions });
    this.onChanged(this.permissions);
  }

  preflightRuntimeCapture(
    sessionId: string,
    frame: Pick<DataFrame, 'direction' | 'data'>,
  ): boolean {
    return this.permissions.preflightRuntimeCapture?.(sessionId, frame) ?? true;
  }

  preflightSessionRegistration(
    sessionId: string,
    frameCount: number,
    captureBytes: number,
  ): boolean {
    return (
      this.permissions.preflightSessionRegistration?.(sessionId, frameCount, captureBytes) ?? true
    );
  }
}
