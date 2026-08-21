import { MGMT_ERR, type SmpError } from './smp';

export type McumgrFailureKind =
  | 'timeout'
  | 'cancelled'
  | 'partial-write'
  | 'unknown-outcome'
  | 'io-error'
  | 'protocol-error'
  | 'device-error';

export class McumgrError extends Error {
  readonly kind: McumgrFailureKind;
  readonly rc?: number;
  readonly group?: number;

  constructor(
    kind: McumgrFailureKind,
    message: string,
    extras: { rc?: number; group?: number } = {},
  ) {
    super(message);
    this.name = 'McumgrError';
    this.kind = kind;
    this.rc = extras.rc;
    this.group = extras.group;
  }
}

export function deviceError(error: SmpError): McumgrError {
  return new McumgrError('device-error', formatDeviceError(error), {
    rc: error.rc,
    group: error.group,
  });
}

export function formatDeviceError(error: SmpError): string {
  const name = mgmtErrorName(error.rc);
  if (error.rsn) return `${name}: ${error.rsn}`;
  if (error.group !== undefined) return `${name} (group ${error.group})`;
  return name;
}

export function mgmtErrorName(rc: number): string {
  switch (rc) {
    case MGMT_ERR.ok:
      return 'ok';
    case MGMT_ERR.unknown:
      return 'unknown';
    case MGMT_ERR.noMemory:
      return 'no-memory';
    case MGMT_ERR.invalid:
      return 'invalid';
    case MGMT_ERR.timeout:
      return 'timeout';
    case MGMT_ERR.noEntry:
      return 'not-found';
    case MGMT_ERR.badState:
      return 'bad-state';
    case MGMT_ERR.msgSize:
      return 'message-too-large';
    case MGMT_ERR.notSupported:
      return 'not-supported';
    case MGMT_ERR.corrupt:
      return 'corrupt';
    case MGMT_ERR.busy:
      return 'busy';
    case MGMT_ERR.accessDenied:
      return 'access-denied';
    case MGMT_ERR.tooOld:
      return 'version-too-old';
    case MGMT_ERR.tooNew:
      return 'version-too-new';
    default:
      return `rc-${rc}`;
  }
}

export function isNotSupported(error: unknown): boolean {
  return error instanceof McumgrError && error.rc === MGMT_ERR.notSupported;
}
