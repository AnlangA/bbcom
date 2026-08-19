import type {
  PluginSurfaceEventKind,
  PluginSurfaceEventV2,
  PluginSurfacePatch,
  PluginSurfaceSnapshot,
  PluginUiNode,
  PluginUiPatchOperation,
  RuntimeInstanceKey,
} from '../../../generated/ipc-contracts';

export const PLUGIN_SURFACE_MAX_BYTES = 512 * 1024;
export const PLUGIN_SURFACE_MAX_NODES = 1024;
export const PLUGIN_SURFACE_MAX_DEPTH = 32;
export const PLUGIN_SURFACE_MAX_PATCH_OPERATIONS = 128;
export const PLUGIN_SURFACE_MAX_TABLE_ROWS = 256;
export const PLUGIN_SURFACE_MAX_TABLE_COLUMNS = 32;

const MAX_ID_BYTES = 128;
const MAX_SHORT_TEXT_BYTES = 1024;
const MAX_LONG_TEXT_BYTES = 256 * 1024;
const MAX_CHILDREN = 256;
const MAX_OPTIONS = 256;
const MAX_TABS = 32;
const NODE_ID = /^[a-z0-9](?:[a-z0-9]|[-_.:](?=[a-z0-9])){0,127}$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LANGUAGE = /^[a-z0-9][a-z0-9+_.-]{0,31}$/u;

export type SurfaceValidationFailure = Readonly<{
  code:
    | 'invalid-runtime'
    | 'invalid-surface'
    | 'invalid-revision'
    | 'invalid-tree'
    | 'duplicate-node'
    | 'limit-exceeded'
    | 'unsafe-text'
    | 'stale-revision'
    | 'invalid-patch';
  detail: string;
}>;

export type SurfaceValidationResult =
  | Readonly<{ ok: true; nodeCount: number; encodedBytes: number }>
  | Readonly<{ ok: false; failure: SurfaceValidationFailure }>;

export type SurfacePatchResult =
  | Readonly<{ ok: true; surface: PluginSurfaceSnapshot }>
  | Readonly<{ ok: false; failure: SurfaceValidationFailure }>;

class ValidationAbort {
  constructor(readonly failure: SurfaceValidationFailure) {}
}

/** Validate the entire renderer-facing snapshot before it enters Vue state. */
export function validatePluginSurface(surface: PluginSurfaceSnapshot): SurfaceValidationResult {
  if (!validRuntime(surface.runtime)) return failure('invalid-runtime', 'runtime');
  if (!validId(surface.surfaceId) || !safeText(surface.title, MAX_SHORT_TEXT_BYTES, false)) {
    return failure('invalid-surface', 'surface identity or title');
  }
  if (!positiveSafeInteger(surface.revision)) return failure('invalid-revision', 'revision');
  if (!['workspace', 'detached-window'].includes(surface.placement)) {
    return failure('invalid-surface', 'placement');
  }
  if (surface.placement === 'detached-window' && !surface.detachedAllowed) {
    return failure('invalid-surface', 'detached placement without capability');
  }

  const encodedBytes = jsonBytes(surface);
  if (encodedBytes > PLUGIN_SURFACE_MAX_BYTES) {
    return failure('limit-exceeded', 'surface byte limit');
  }

  const ids = new Set<string>();
  const state = { nodes: 0 };
  try {
    validateNode(surface.root, ids, state, 1);
  } catch (error) {
    if (error instanceof ValidationAbort) return { ok: false, failure: error.failure };
    return failure('invalid-tree', 'unexpected node value');
  }
  return { ok: true, nodeCount: state.nodes, encodedBytes };
}

/**
 * Apply a patch to an isolated clone and publish only after the resulting
 * surface passes every limit. The current snapshot is never partially
 * modified when one operation fails.
 */
export function applyPluginSurfacePatch(
  current: PluginSurfaceSnapshot,
  patch: PluginSurfacePatch,
): SurfacePatchResult {
  if (
    !sameRuntime(current.runtime, patch.runtime) ||
    current.surfaceId !== patch.surfaceId ||
    patch.baseRevision !== current.revision
  ) {
    return failure('stale-revision', 'runtime, surface, or base revision');
  }
  if (
    !positiveSafeInteger(patch.nextRevision) ||
    patch.nextRevision !== patch.baseRevision + 1 ||
    patch.operations.length === 0 ||
    patch.operations.length > PLUGIN_SURFACE_MAX_PATCH_OPERATIONS ||
    jsonBytes(patch) > PLUGIN_SURFACE_MAX_BYTES
  ) {
    return failure('invalid-patch', 'revision, operation count, or patch size');
  }

  let root = cloneNode(current.root);
  for (const operation of patch.operations) {
    const updated = updateNode(root, operation);
    if (!updated.matched) return failure('invalid-patch', `unknown node ${operation.nodeId}`);
    root = updated.node;
  }
  const candidate: PluginSurfaceSnapshot = {
    ...current,
    runtime: { ...current.runtime },
    revision: patch.nextRevision,
    root,
  };
  const validated = validatePluginSurface(candidate);
  if (!validated.ok) return validated;
  return { ok: true, surface: freezeSurface(candidate) };
}

export function createPluginSurfaceEvent(
  surface: PluginSurfaceSnapshot,
  nodeId: string,
  event: PluginSurfaceEventKind,
  value?: string,
): PluginSurfaceEventV2 | null {
  if (!surface.editable || !validId(nodeId) || !safeEventValue(value)) return null;
  const node = findNode(surface.root, nodeId);
  if (!node || !eventAllowed(node, event, value)) return null;
  return {
    runtime: { ...surface.runtime },
    surfaceId: surface.surfaceId,
    revision: surface.revision,
    nodeId,
    event,
    ...(value === undefined ? {} : { value }),
  };
}

export function freezeSurface(surface: PluginSurfaceSnapshot): PluginSurfaceSnapshot {
  return Object.freeze({
    ...surface,
    runtime: Object.freeze({ ...surface.runtime }),
    root: freezeNode(cloneNode(surface.root)),
  });
}

function validateNode(
  node: PluginUiNode,
  ids: Set<string>,
  state: { nodes: number },
  depth: number,
): void {
  if (depth > PLUGIN_SURFACE_MAX_DEPTH) abort('limit-exceeded', 'tree depth');
  state.nodes += 1;
  if (state.nodes > PLUGIN_SURFACE_MAX_NODES) abort('limit-exceeded', 'node count');
  if (!validId(node.id)) abort('invalid-tree', 'node id');
  if (ids.has(node.id)) abort('duplicate-node', node.id);
  ids.add(node.id);

  switch (node.kind) {
    case 'column':
    case 'row':
      validateChildren(node.children, ids, state, depth);
      return;
    case 'group':
      requireSafe(node.label, MAX_SHORT_TEXT_BYTES, false);
      validateChildren(node.children, ids, state, depth);
      return;
    case 'tabs': {
      if (node.tabs.length === 0 || node.tabs.length > MAX_TABS) {
        abort('limit-exceeded', 'tab count');
      }
      const tabIds = new Set<string>();
      for (const tab of node.tabs) {
        if (!validId(tab.id) || tabIds.has(tab.id)) abort('invalid-tree', 'tab identity');
        tabIds.add(tab.id);
        requireSafe(tab.label, MAX_SHORT_TEXT_BYTES, false);
        validateChildren(tab.children, ids, state, depth);
      }
      if (!tabIds.has(node.selectedId)) abort('invalid-tree', 'selected tab');
      return;
    }
    case 'text':
    case 'badge':
      requireSafe(node.text, MAX_SHORT_TEXT_BYTES, true);
      return;
    case 'key-value-list':
      if (node.entries.length > MAX_CHILDREN) abort('limit-exceeded', 'key/value count');
      for (const entry of node.entries) {
        requireSafe(entry.key, MAX_SHORT_TEXT_BYTES, false);
        requireSafe(entry.value, MAX_SHORT_TEXT_BYTES, true);
      }
      return;
    case 'progress':
      requireSafe(node.label, MAX_SHORT_TEXT_BYTES, false);
      if (
        !nonNegativeSafeInteger(node.completed) ||
        !nonNegativeSafeInteger(node.total) ||
        node.completed > node.total
      ) {
        abort('invalid-tree', 'progress value');
      }
      return;
    case 'log':
      requireSafe(node.text, MAX_LONG_TEXT_BYTES, true, true);
      if (!positiveSafeInteger(node.maxLines) || node.maxLines > 10_000) {
        abort('invalid-tree', 'log line limit');
      }
      return;
    case 'code':
      requireSafe(node.text, MAX_LONG_TEXT_BYTES, true, true);
      if (!LANGUAGE.test(node.language)) abort('invalid-tree', 'code language');
      return;
    case 'table':
      validateTable(node);
      return;
    case 'text-input':
      requireSafe(node.label, MAX_SHORT_TEXT_BYTES, false);
      requireSafe(node.value, MAX_SHORT_TEXT_BYTES, true);
      return;
    case 'number-input':
      requireSafe(node.label, MAX_SHORT_TEXT_BYTES, false);
      requireFiniteNumber(node.value, 'number value');
      if (node.min !== undefined) requireFiniteNumber(node.min, 'number minimum');
      if (node.max !== undefined) requireFiniteNumber(node.max, 'number maximum');
      if (node.step !== undefined) {
        requireFiniteNumber(node.step, 'number step');
        if (Number(node.step) <= 0) abort('invalid-tree', 'number step');
      }
      if (node.min !== undefined && node.max !== undefined && Number(node.min) > Number(node.max)) {
        abort('invalid-tree', 'number range');
      }
      return;
    case 'select': {
      requireSafe(node.label, MAX_SHORT_TEXT_BYTES, false);
      if (node.options.length === 0 || node.options.length > MAX_OPTIONS) {
        abort('limit-exceeded', 'select option count');
      }
      const values = new Set<string>();
      for (const option of node.options) {
        requireSafe(option.value, MAX_SHORT_TEXT_BYTES, false);
        requireSafe(option.label, MAX_SHORT_TEXT_BYTES, false);
        if (values.has(option.value)) abort('invalid-tree', 'duplicate select option');
        values.add(option.value);
      }
      if (!values.has(node.value)) abort('invalid-tree', 'select value');
      return;
    }
    case 'toggle':
      requireSafe(node.label, MAX_SHORT_TEXT_BYTES, false);
      return;
    case 'button':
      requireSafe(node.label, MAX_SHORT_TEXT_BYTES, false);
      if (node.dangerous !== (node.confirmation !== undefined)) {
        abort('invalid-tree', 'dangerous confirmation');
      }
      if (node.confirmation !== undefined) {
        requireSafe(node.confirmation, MAX_SHORT_TEXT_BYTES, false);
      }
  }
}

function validateChildren(
  children: readonly PluginUiNode[],
  ids: Set<string>,
  state: { nodes: number },
  parentDepth: number,
): void {
  if (children.length > MAX_CHILDREN) abort('limit-exceeded', 'child count');
  for (const child of children) validateNode(child, ids, state, parentDepth + 1);
}

function validateTable(node: Extract<PluginUiNode, { kind: 'table' }>): void {
  if (
    node.columns.length === 0 ||
    node.columns.length > PLUGIN_SURFACE_MAX_TABLE_COLUMNS ||
    node.rows.length > PLUGIN_SURFACE_MAX_TABLE_ROWS ||
    !nonNegativeSafeInteger(node.page) ||
    !positiveSafeInteger(node.pageCount) ||
    node.page >= node.pageCount
  ) {
    abort('limit-exceeded', 'table dimensions or page');
  }
  const columns = new Set<string>();
  for (const column of node.columns) {
    if (!validId(column.id) || columns.has(column.id)) abort('invalid-tree', 'table column');
    columns.add(column.id);
    requireSafe(column.label, MAX_SHORT_TEXT_BYTES, false);
  }
  for (const row of node.rows) {
    if (row.length !== node.columns.length) abort('invalid-tree', 'table row width');
    for (const cell of row) requireSafe(cell, MAX_SHORT_TEXT_BYTES, true);
  }
}

function updateNode(
  node: PluginUiNode,
  operation: PluginUiPatchOperation,
): { node: PluginUiNode; matched: boolean } {
  if (node.id === operation.nodeId) {
    const updated = updateMatchedNode(node, operation);
    return updated ? { node: updated, matched: true } : { node, matched: false };
  }
  if ('children' in node) {
    const result = updateChildren(node.children, operation);
    if (result.matched) return { node: { ...node, children: result.children }, matched: true };
  } else if (node.kind === 'tabs') {
    for (let index = 0; index < node.tabs.length; index += 1) {
      const tab = node.tabs[index];
      if (!tab) continue;
      const result = updateChildren(tab.children, operation);
      if (result.matched) {
        const tabs = node.tabs.map((candidate, candidateIndex) =>
          candidateIndex === index ? { ...candidate, children: result.children } : candidate,
        );
        return { node: { ...node, tabs }, matched: true };
      }
    }
  }
  return { node, matched: false };
}

function updateChildren(
  children: readonly PluginUiNode[],
  operation: PluginUiPatchOperation,
): { children: PluginUiNode[]; matched: boolean } {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) continue;
    const result = updateNode(child, operation);
    if (result.matched) {
      const next = children.slice();
      next[index] = result.node;
      return { children: next, matched: true };
    }
  }
  return { children: children.slice(), matched: false };
}

function updateMatchedNode(
  node: PluginUiNode,
  operation: PluginUiPatchOperation,
): PluginUiNode | null {
  switch (operation.kind) {
    case 'replace-node':
      return operation.node.id === operation.nodeId ? cloneNode(operation.node) : null;
    case 'set-text':
      return node.kind === 'text' ||
        node.kind === 'badge' ||
        node.kind === 'log' ||
        node.kind === 'code'
        ? { ...node, text: operation.text }
        : null;
    case 'set-value':
      if (node.kind === 'text-input' || node.kind === 'number-input' || node.kind === 'select') {
        return { ...node, value: operation.value };
      }
      if (node.kind === 'toggle' && (operation.value === 'true' || operation.value === 'false')) {
        return { ...node, value: operation.value === 'true' };
      }
      return null;
    case 'set-disabled':
      return isControl(node) ? { ...node, disabled: operation.disabled } : null;
    case 'select-tab':
      return node.kind === 'tabs' && node.tabs.some((tab) => tab.id === operation.selectedId)
        ? { ...node, selectedId: operation.selectedId }
        : null;
  }
}

function eventAllowed(
  node: PluginUiNode,
  event: PluginSurfaceEventKind,
  value: string | undefined,
): boolean {
  if (isControl(node) && node.disabled) return false;
  switch (node.kind) {
    case 'button':
      return event === 'activate' && value === undefined;
    case 'text-input':
      return (event === 'input' || event === 'change') && value !== undefined;
    case 'number-input':
      return (
        (event === 'input' || event === 'change') &&
        value !== undefined &&
        value.trim() !== '' &&
        Number.isFinite(Number(value))
      );
    case 'select':
      return (
        event === 'change' && value !== undefined && node.options.some((o) => o.value === value)
      );
    case 'toggle':
      return event === 'change' && (value === 'true' || value === 'false');
    case 'tabs':
      return (
        event === 'select-tab' && value !== undefined && node.tabs.some((tab) => tab.id === value)
      );
    case 'table':
      return (
        event === 'request-page' &&
        value !== undefined &&
        nonNegativeSafeInteger(Number(value)) &&
        Number(value) < node.pageCount
      );
    case 'text':
    case 'code':
    case 'progress':
    case 'column':
    case 'row':
    case 'group':
    case 'badge':
    case 'key-value-list':
    case 'log':
      return false;
  }
}

function isControl(
  node: PluginUiNode,
): node is Extract<
  PluginUiNode,
  { kind: 'text-input' | 'number-input' | 'select' | 'toggle' | 'button' }
> {
  return ['text-input', 'number-input', 'select', 'toggle', 'button'].includes(node.kind);
}

function findNode(node: PluginUiNode, id: string): PluginUiNode | null {
  if (node.id === id) return node;
  if ('children' in node) {
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  } else if (node.kind === 'tabs') {
    for (const tab of node.tabs) {
      for (const child of tab.children) {
        const found = findNode(child, id);
        if (found) return found;
      }
    }
  }
  return null;
}

function cloneNode(node: PluginUiNode): PluginUiNode {
  if ('children' in node) return { ...node, children: node.children.map(cloneNode) };
  switch (node.kind) {
    case 'tabs':
      return {
        ...node,
        tabs: node.tabs.map((tab) => ({ ...tab, children: tab.children.map(cloneNode) })),
      };
    case 'key-value-list':
      return { ...node, entries: node.entries.map((entry) => ({ ...entry })) };
    case 'table':
      return {
        ...node,
        columns: node.columns.map((column) => ({ ...column })),
        rows: node.rows.map((row) => [...row]),
      };
    case 'select':
      return { ...node, options: node.options.map((option) => ({ ...option })) };
    case 'text':
    case 'button':
    case 'code':
    case 'progress':
    case 'toggle':
    case 'badge':
    case 'log':
    case 'text-input':
    case 'number-input':
      return { ...node };
  }
}

function freezeNode(node: PluginUiNode): PluginUiNode {
  if ('children' in node) {
    return Object.freeze({ ...node, children: freezeArray(node.children.map(freezeNode)) });
  }
  if (node.kind === 'tabs') {
    return Object.freeze({
      ...node,
      tabs: freezeArray(
        node.tabs.map((tab) =>
          Object.freeze({ ...tab, children: freezeArray(tab.children.map(freezeNode)) }),
        ),
      ),
    });
  }
  if (node.kind === 'key-value-list') {
    return Object.freeze({
      ...node,
      entries: freezeArray(node.entries.map((entry) => Object.freeze({ ...entry }))),
    });
  }
  if (node.kind === 'table') {
    return Object.freeze({
      ...node,
      columns: freezeArray(node.columns.map((column) => Object.freeze({ ...column }))),
      rows: freezeArray(node.rows.map((row) => freezeArray([...row]))),
    });
  }
  if (node.kind === 'select') {
    return Object.freeze({
      ...node,
      options: freezeArray(node.options.map((option) => Object.freeze({ ...option }))),
    });
  }
  return Object.freeze({ ...node });
}

function validRuntime(runtime: RuntimeInstanceKey): boolean {
  return (
    IDENTITY.test(runtime.workspaceId) &&
    IDENTITY.test(runtime.pluginId) &&
    positiveSafeInteger(runtime.instanceId) &&
    positiveSafeInteger(runtime.generation)
  );
}

function sameRuntime(left: RuntimeInstanceKey, right: RuntimeInstanceKey): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.pluginId === right.pluginId &&
    left.instanceId === right.instanceId &&
    left.generation === right.generation
  );
}

function validId(value: string): boolean {
  return NODE_ID.test(value) && utf8Bytes(value) <= MAX_ID_BYTES;
}

function requireSafe(
  value: string,
  maxBytes: number,
  allowEmpty: boolean,
  multiline = false,
): void {
  if (!safeText(value, maxBytes, allowEmpty, multiline)) abort('unsafe-text', 'display text');
}

function safeText(
  value: string,
  maxBytes: number,
  allowEmpty: boolean,
  multiline = false,
): boolean {
  if ((!allowEmpty && value.length === 0) || utf8Bytes(value) > maxBytes) return false;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined) return false;
    if (
      point === 0 ||
      point === 127 ||
      (point < 32 && !(multiline && [9, 10, 13].includes(point)))
    ) {
      return false;
    }
  }
  const lower = value.toLocaleLowerCase('en-US');
  return !(
    lower.includes('<script') ||
    lower.includes('javascript:') ||
    lower.includes('data:text/html') ||
    lower.includes('file://') ||
    /(?:^|\s)(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\Users\\|\\\\[^\\]+\\)/u.test(value)
  );
}

function safeEventValue(value: string | undefined): boolean {
  return value === undefined || safeText(value, MAX_SHORT_TEXT_BYTES, true);
}

function requireFiniteNumber(value: string, field: string): void {
  if (value.trim() === '' || utf8Bytes(value) > 64 || !Number.isFinite(Number(value))) {
    abort('invalid-tree', field);
  }
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function jsonBytes(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function freezeArray<T>(values: T[]): T[] {
  // Generated wire contracts use mutable arrays. Runtime snapshots are frozen
  // after ingress; retain the generated shape without weakening validation.
  return Object.freeze(values) as unknown as T[];
}

function failure(
  code: SurfaceValidationFailure['code'],
  detail: string,
): { ok: false; failure: SurfaceValidationFailure } {
  return { ok: false, failure: { code, detail } };
}

function abort(code: SurfaceValidationFailure['code'], detail: string): never {
  throw new ValidationAbort({ code, detail });
}
