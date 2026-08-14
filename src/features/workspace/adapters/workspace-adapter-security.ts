import { WorkspaceAdapterValidationError } from './workspace-adapter-errors';

const FORBIDDEN_KEY_FRAGMENT = /(path|handle|token|grant|secret)/i;
const WORKSPACE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Validate the exact JSON-like value crossing into the workspace service.
 * Plugin-owned opaque state deliberately never passes through this adapter.
 */
export function assertSafeWorkspaceValue(
  value: unknown,
  field = 'payload',
  options: { rejectAbsolutePaths?: boolean } = {},
): void {
  visit(value, field, new Set<object>(), options.rejectAbsolutePaths !== false);
}

export function isAbsolutePathLike(text: string): boolean {
  const bytes = new TextEncoder().encode(text);
  return (
    text.startsWith('/') ||
    text.startsWith('\\\\') ||
    text.toLowerCase().startsWith('file:') ||
    (bytes.length >= 3 &&
      isAsciiLetter(bytes[0]) &&
      bytes[1] === 0x3a &&
      (bytes[2] === 0x2f || bytes[2] === 0x5c))
  );
}

export function validateWorkspaceIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) {
    throw new WorkspaceAdapterValidationError(field);
  }
  const normalized = value.trim();
  if (!WORKSPACE_IDENTIFIER.test(normalized)) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return normalized;
}

export function validateSafeText(
  value: unknown,
  field: string,
  options: { maxBytes: number; allowEmpty?: boolean },
): string {
  if (
    typeof value !== 'string' ||
    !isWellFormedUnicode(value) ||
    (!options.allowEmpty && value.length === 0) ||
    utf8ByteLength(value) > options.maxBytes ||
    isAbsolutePathLike(value)
  ) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return value;
}

/** Opaque user content is byte-bounded but never interpreted as a filesystem path. */
export function validateOpaqueText(
  value: unknown,
  field: string,
  options: { maxBytes: number; allowEmpty?: boolean },
): string {
  if (
    typeof value !== 'string' ||
    !isWellFormedUnicode(value) ||
    (!options.allowEmpty && value.length === 0) ||
    utf8ByteLength(value) > options.maxBytes
  ) {
    throw new WorkspaceAdapterValidationError(field);
  }
  return value;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function visit(
  value: unknown,
  field: string,
  ancestors: Set<object>,
  rejectAbsolutePaths: boolean,
): void {
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === 'string') {
    if (!isWellFormedUnicode(value) || (rejectAbsolutePaths && isAbsolutePathLike(value))) {
      throw new WorkspaceAdapterValidationError(field);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new WorkspaceAdapterValidationError(field);
    ancestors.add(value);
    value.forEach((child, index) =>
      visit(child, `${field}[${index}]`, ancestors, rejectAbsolutePaths),
    );
    ancestors.delete(value);
    return;
  }
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) throw new WorkspaceAdapterValidationError(field);
    ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (isForbiddenKey(key)) throw new WorkspaceAdapterValidationError(`${field}.${key}`);
      visit(child, `${field}.${key}`, ancestors, rejectAbsolutePaths);
    }
    ancestors.delete(value);
    return;
  }
  throw new WorkspaceAdapterValidationError(field);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll('-', '_');
  return (
    FORBIDDEN_KEY_FRAGMENT.test(normalized) ||
    normalized === 'key' ||
    normalized.endsWith('_key') ||
    normalized.endsWith('apikey')
  );
}

function isAsciiLetter(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
