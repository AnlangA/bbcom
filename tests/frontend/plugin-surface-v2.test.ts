import { describe, expect, test } from 'vitest';
import type {
  PluginSurfacePatch,
  PluginSurfaceSnapshot,
  PluginUiNode,
} from '../../src/generated/ipc-contracts';
import {
  PLUGIN_SURFACE_MAX_PATCH_OPERATIONS,
  applyPluginSurfacePatch,
  createPluginSurfaceEvent,
  freezeSurface,
  validatePluginSurface,
} from '../../src/features/plugins';

const runtime = {
  workspaceId: 'workspace-1',
  pluginId: 'dev.bbcom.mcumgr',
  instanceId: 7,
  generation: 3,
};

function surface(root: PluginUiNode = richTree()): PluginSurfaceSnapshot {
  return {
    runtime,
    surfaceId: 'mcumgr-main',
    revision: 1,
    title: 'MCUmgr',
    placement: 'workspace',
    detachedAllowed: true,
    editable: true,
    root,
  };
}

function richTree(): PluginUiNode {
  return {
    kind: 'column',
    id: 'root',
    children: [
      {
        kind: 'tabs',
        id: 'pages',
        selectedId: 'overview',
        tabs: [
          {
            id: 'overview',
            label: 'Overview',
            children: [
              { kind: 'badge', id: 'connection', text: 'Connected', tone: 'success' },
              { kind: 'progress', id: 'progress', label: 'Upload', completed: 2, total: 10 },
            ],
          },
          {
            id: 'raw',
            label: 'Groups / Raw',
            children: [
              {
                kind: 'table',
                id: 'groups',
                columns: [
                  { id: 'group', label: 'Group' },
                  { id: 'version', label: 'Version' },
                ],
                rows: [['image', '1']],
                page: 0,
                pageCount: 1,
              },
              {
                kind: 'select',
                id: 'transport',
                label: 'Transport',
                value: 'console',
                options: [
                  { value: 'console', label: 'SMP over console' },
                  { value: 'raw', label: 'Raw UART' },
                ],
                disabled: false,
              },
              {
                kind: 'button',
                id: 'erase',
                label: 'Erase storage',
                disabled: false,
                dangerous: true,
                confirmation: 'Erase device storage?',
              },
            ],
          },
        ],
      },
    ],
  };
}

function completeTree(): PluginUiNode {
  return {
    kind: 'column',
    id: 'complete-root',
    children: [
      {
        kind: 'row',
        id: 'complete-row',
        children: [{ kind: 'text', id: 'complete-text', text: 'Text', tone: 'default' }],
      },
      {
        kind: 'group',
        id: 'complete-group',
        label: 'Group',
        children: [
          { kind: 'badge', id: 'complete-badge', text: 'Badge', tone: 'success' },
          {
            kind: 'key-value-list',
            id: 'complete-kv',
            entries: [{ key: 'Key', value: 'Value' }],
          },
          { kind: 'progress', id: 'complete-progress', label: 'Progress', completed: 1, total: 2 },
          { kind: 'log', id: 'complete-log', text: 'line\nnext', maxLines: 10 },
          { kind: 'code', id: 'complete-code', text: 'let x = 1;\n', language: 'rust' },
          {
            kind: 'table',
            id: 'complete-table',
            columns: [{ id: 'column', label: 'Column' }],
            rows: [['Cell']],
            page: 0,
            pageCount: 2,
          },
          {
            kind: 'text-input',
            id: 'complete-text-input',
            label: 'Text input',
            value: 'value',
            disabled: false,
          },
          {
            kind: 'number-input',
            id: 'complete-number-input',
            label: 'Number input',
            value: '2',
            min: '1',
            max: '3',
            step: '0.5',
            disabled: false,
          },
          {
            kind: 'select',
            id: 'complete-select',
            label: 'Select',
            value: 'one',
            options: [{ value: 'one', label: 'One' }],
            disabled: false,
          },
          { kind: 'toggle', id: 'complete-toggle', label: 'Toggle', value: false, disabled: false },
          {
            kind: 'button',
            id: 'complete-button',
            label: 'Button',
            disabled: false,
            dangerous: false,
          },
        ],
      },
      {
        kind: 'tabs',
        id: 'complete-tabs',
        selectedId: 'complete-tab',
        tabs: [{ id: 'complete-tab', label: 'Tab', children: [] }],
      },
    ],
  };
}

function expectNodeFailure(root: PluginUiNode, code: string): void {
  expect(validatePluginSurface(surface(root))).toMatchObject({ ok: false, failure: { code } });
}

describe('plugin surface v2 boundary', () => {
  test('accepts the complete host-rendered component vocabulary fixture', () => {
    const result = validatePluginSurface(surface());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nodeCount).toBe(7);
      expect(result.encodedBytes).toBeGreaterThan(100);
    }
  });

  test('rejects duplicate node ids, native paths, and unpaged tables', () => {
    const duplicated: PluginUiNode = {
      kind: 'row',
      id: 'root',
      children: [
        { kind: 'text', id: 'same', text: 'one', tone: 'default' },
        { kind: 'text', id: 'same', text: 'two', tone: 'default' },
      ],
    };
    expect(validatePluginSurface(surface(duplicated))).toMatchObject({
      ok: false,
      failure: { code: 'duplicate-node' },
    });

    expect(
      validatePluginSurface(
        surface({ kind: 'text', id: 'leak', text: '/Users/alice/private.bin', tone: 'danger' }),
      ),
    ).toMatchObject({ ok: false, failure: { code: 'unsafe-text' } });

    expect(
      validatePluginSurface(
        surface({
          kind: 'table',
          id: 'bad-table',
          columns: [{ id: 'value', label: 'Value' }],
          rows: [['one']],
          page: 1,
          pageCount: 1,
        }),
      ),
    ).toMatchObject({ ok: false, failure: { code: 'limit-exceeded' } });
  });

  test('applies a multi-operation patch atomically at the next revision', () => {
    const current = surface();
    const patch: PluginSurfacePatch = {
      runtime,
      surfaceId: current.surfaceId,
      baseRevision: 1,
      nextRevision: 2,
      operations: [
        { kind: 'set-text', nodeId: 'connection', text: 'Reconnecting' },
        { kind: 'set-value', nodeId: 'transport', value: 'raw' },
        { kind: 'select-tab', nodeId: 'pages', selectedId: 'raw' },
      ],
    };
    const result = applyPluginSurfacePatch(current, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.surface.revision).toBe(2);
    expect(JSON.stringify(result.surface.root)).toContain('Reconnecting');
    expect(JSON.stringify(result.surface.root)).toContain('"value":"raw"');
    expect(JSON.stringify(result.surface.root)).toContain('"selectedId":"raw"');
    expect(JSON.stringify(current.root)).toContain('Connected');
    expect(JSON.stringify(current.root)).toContain('"value":"console"');
  });

  test('rejects stale or invalid operations without publishing partial changes', () => {
    const current = surface();
    const stale = applyPluginSurfacePatch(current, {
      runtime,
      surfaceId: current.surfaceId,
      baseRevision: 0,
      nextRevision: 1,
      operations: [{ kind: 'set-text', nodeId: 'connection', text: 'wrong' }],
    });
    expect(stale).toMatchObject({ ok: false, failure: { code: 'stale-revision' } });

    const invalid = applyPluginSurfacePatch(current, {
      runtime,
      surfaceId: current.surfaceId,
      baseRevision: 1,
      nextRevision: 2,
      operations: [
        { kind: 'set-text', nodeId: 'connection', text: 'would-have-applied' },
        { kind: 'set-disabled', nodeId: 'connection', disabled: true },
      ],
    });
    expect(invalid).toMatchObject({ ok: false, failure: { code: 'invalid-patch' } });
    expect(JSON.stringify(current.root)).not.toContain('would-have-applied');
  });

  test('only emits events accepted by the target node and current editor', () => {
    const current = surface();
    expect(createPluginSurfaceEvent(current, 'transport', 'change', 'raw')).toMatchObject({
      surfaceId: 'mcumgr-main',
      revision: 1,
      nodeId: 'transport',
      event: 'change',
      value: 'raw',
    });
    expect(createPluginSurfaceEvent(current, 'transport', 'change', 'udp')).toBeNull();
    expect(createPluginSurfaceEvent(current, 'connection', 'activate')).toBeNull();
    expect(
      createPluginSurfaceEvent({ ...current, editable: false }, 'erase', 'activate'),
    ).toBeNull();
  });

  test('rejects malformed surface metadata and serialization limits independently', () => {
    for (const runtimePatch of [
      { workspaceId: '' },
      { pluginId: '' },
      { instanceId: 0 },
      { generation: 0 },
    ]) {
      expect(
        validatePluginSurface({ ...surface(), runtime: { ...runtime, ...runtimePatch } }),
      ).toMatchObject({ ok: false, failure: { code: 'invalid-runtime' } });
    }
    expect(validatePluginSurface({ ...surface(), surfaceId: '' })).toMatchObject({
      ok: false,
      failure: { code: 'invalid-surface' },
    });
    expect(validatePluginSurface({ ...surface(), title: '' })).toMatchObject({
      ok: false,
      failure: { code: 'invalid-surface' },
    });
    expect(validatePluginSurface({ ...surface(), revision: 0 })).toMatchObject({
      ok: false,
      failure: { code: 'invalid-revision' },
    });
    expect(
      validatePluginSurface({ ...surface(), placement: 'unsupported' } as PluginSurfaceSnapshot),
    ).toMatchObject({ ok: false, failure: { code: 'invalid-surface' } });
    expect(
      validatePluginSurface({
        ...surface(),
        placement: 'detached-window',
        detachedAllowed: false,
      }),
    ).toMatchObject({ ok: false, failure: { code: 'invalid-surface' } });

    expect(
      validatePluginSurface({ ...surface(), padding: 'x'.repeat(513 * 1024) } as never),
    ).toMatchObject({ ok: false, failure: { code: 'limit-exceeded' } });
    const cyclic = surface() as PluginSurfaceSnapshot & { cyclic?: unknown };
    cyclic.cyclic = cyclic;
    expect(validatePluginSurface(cyclic)).toMatchObject({
      ok: false,
      failure: { code: 'limit-exceeded' },
    });
    expect(validatePluginSurface(surface(null as unknown as PluginUiNode))).toMatchObject({
      ok: false,
      failure: { code: 'invalid-tree' },
    });
  });

  test('enforces structural, count, identity, and text safety limits for every node family', () => {
    let deep: PluginUiNode = { kind: 'text', id: 'depth-leaf', text: 'leaf', tone: 'default' };
    for (let index = 0; index < 32; index += 1) {
      deep = { kind: 'column', id: `depth-${index}`, children: [deep] };
    }
    expectNodeFailure(deep, 'limit-exceeded');

    const manyNodes: PluginUiNode = {
      kind: 'column',
      id: 'many-root',
      children: Array.from({ length: 5 }, (_, group) => ({
        kind: 'column' as const,
        id: `many-group-${group}`,
        children: Array.from({ length: 256 }, (_, child) => ({
          kind: 'text' as const,
          id: `many-${group}-${child}`,
          text: '',
          tone: 'default' as const,
        })),
      })),
    };
    expectNodeFailure(manyNodes, 'limit-exceeded');
    expectNodeFailure({ kind: 'text', id: 'Bad ID', text: 'x', tone: 'default' }, 'invalid-tree');
    expectNodeFailure({ kind: 'group', id: 'group', label: '', children: [] }, 'unsafe-text');
    expectNodeFailure(
      {
        kind: 'row',
        id: 'too-many-children',
        children: Array.from({ length: 257 }, (_, index) => ({
          kind: 'text' as const,
          id: `child-${index}`,
          text: '',
          tone: 'default' as const,
        })),
      },
      'limit-exceeded',
    );

    expectNodeFailure(
      { kind: 'tabs', id: 'tabs-empty', selectedId: '', tabs: [] },
      'limit-exceeded',
    );
    expectNodeFailure(
      {
        kind: 'tabs',
        id: 'tabs-many',
        selectedId: 'tab-0',
        tabs: Array.from({ length: 33 }, (_, index) => ({
          id: `tab-${index}`,
          label: 'Tab',
          children: [],
        })),
      },
      'limit-exceeded',
    );
    expectNodeFailure(
      {
        kind: 'tabs',
        id: 'tabs-invalid',
        selectedId: 'bad',
        tabs: [{ id: 'Bad tab', label: 'Tab', children: [] }],
      },
      'invalid-tree',
    );
    expectNodeFailure(
      {
        kind: 'tabs',
        id: 'tabs-duplicate',
        selectedId: 'same',
        tabs: [
          { id: 'same', label: 'One', children: [] },
          { id: 'same', label: 'Two', children: [] },
        ],
      },
      'invalid-tree',
    );
    expectNodeFailure(
      {
        kind: 'tabs',
        id: 'tabs-label',
        selectedId: 'tab',
        tabs: [{ id: 'tab', label: '', children: [] }],
      },
      'unsafe-text',
    );
    expectNodeFailure(
      {
        kind: 'tabs',
        id: 'tabs-selected',
        selectedId: 'missing',
        tabs: [{ id: 'tab', label: 'Tab', children: [] }],
      },
      'invalid-tree',
    );

    expectNodeFailure(
      {
        kind: 'key-value-list',
        id: 'kv-many',
        entries: Array.from({ length: 257 }, () => ({ key: 'Key', value: 'Value' })),
      },
      'limit-exceeded',
    );
    expectNodeFailure(
      { kind: 'key-value-list', id: 'kv-key', entries: [{ key: '', value: 'Value' }] },
      'unsafe-text',
    );
    expectNodeFailure(
      { kind: 'key-value-list', id: 'kv-value', entries: [{ key: 'Key', value: 'file://x' }] },
      'unsafe-text',
    );

    for (const progress of [
      { completed: -1, total: 1 },
      { completed: 0, total: -1 },
      { completed: 2, total: 1 },
    ]) {
      expectNodeFailure(
        {
          kind: 'progress',
          id: `progress-${progress.completed}-${progress.total}`,
          label: 'P',
          ...progress,
        },
        'invalid-tree',
      );
    }
    expectNodeFailure({ kind: 'log', id: 'log-zero', text: 'log', maxLines: 0 }, 'invalid-tree');
    expectNodeFailure(
      { kind: 'log', id: 'log-many', text: 'log', maxLines: 10_001 },
      'invalid-tree',
    );
    expectNodeFailure(
      { kind: 'code', id: 'code-language', text: 'x', language: 'Bad Language' },
      'invalid-tree',
    );

    for (const unsafe of [
      '<script>alert(1)',
      'javascript:alert(1)',
      'data:text/html,test',
      'file://secret',
      '/home/user/secret',
      '/private/tmp/secret',
      'C:\\Users\\alice\\secret',
      '\\\\server\\share',
      '\u0000',
      '\u007f',
      '\n',
      'x'.repeat(1025),
    ]) {
      expectNodeFailure(
        { kind: 'text', id: `unsafe-${unsafe.length}`, text: unsafe, tone: 'default' },
        'unsafe-text',
      );
    }
    expect(validatePluginSurface(surface(completeTree())).ok).toBe(true);
  });

  test('validates tables, numeric controls, selects, and dangerous confirmations branch by branch', () => {
    const table = (overrides: Partial<Extract<PluginUiNode, { kind: 'table' }>>): PluginUiNode => ({
      kind: 'table',
      id: 'table',
      columns: [{ id: 'column', label: 'Column' }],
      rows: [['value']],
      page: 0,
      pageCount: 1,
      ...overrides,
    });
    for (const invalid of [
      table({ columns: [] }),
      table({
        columns: Array.from({ length: 33 }, (_, index) => ({ id: `c-${index}`, label: 'C' })),
      }),
      table({ rows: Array.from({ length: 257 }, () => ['value']) }),
      table({ page: -1 }),
      table({ pageCount: 0 }),
      table({ page: 1 }),
    ]) {
      expectNodeFailure(invalid, 'limit-exceeded');
    }
    for (const [invalid, code] of [
      [table({ columns: [{ id: 'Bad column', label: 'Column' }] }), 'invalid-tree'],
      [
        table({
          columns: [
            { id: 'same', label: 'One' },
            { id: 'same', label: 'Two' },
          ],
          rows: [['1', '2']],
        }),
        'invalid-tree',
      ],
      [table({ columns: [{ id: 'column', label: '' }] }), 'unsafe-text'],
      [table({ rows: [[]] }), 'invalid-tree'],
      [table({ rows: [['javascript:bad']] }), 'unsafe-text'],
    ] as const) {
      expectNodeFailure(invalid, code);
    }

    const number = (
      overrides: Partial<Extract<PluginUiNode, { kind: 'number-input' }>>,
    ): PluginUiNode => ({
      kind: 'number-input',
      id: 'number',
      label: 'Number',
      value: '1',
      disabled: false,
      ...overrides,
    });
    for (const invalid of [
      number({ value: '' }),
      number({ value: 'not-a-number' }),
      number({ value: '1'.repeat(65) }),
      number({ min: '' }),
      number({ max: 'NaN' }),
      number({ step: 'Infinity' }),
      number({ step: '0' }),
      number({ min: '3', max: '2' }),
    ]) {
      expectNodeFailure(invalid, 'invalid-tree');
    }

    const select = (
      overrides: Partial<Extract<PluginUiNode, { kind: 'select' }>>,
    ): PluginUiNode => ({
      kind: 'select',
      id: 'select',
      label: 'Select',
      value: 'one',
      options: [{ value: 'one', label: 'One' }],
      disabled: false,
      ...overrides,
    });
    expectNodeFailure(select({ options: [] }), 'limit-exceeded');
    expectNodeFailure(
      select({
        options: Array.from({ length: 257 }, (_, index) => ({ value: `v-${index}`, label: 'V' })),
      }),
      'limit-exceeded',
    );
    expectNodeFailure(select({ options: [{ value: '', label: 'One' }] }), 'unsafe-text');
    expectNodeFailure(select({ options: [{ value: 'one', label: '' }] }), 'unsafe-text');
    expectNodeFailure(
      select({
        options: [
          { value: 'one', label: 'One' },
          { value: 'one', label: 'Again' },
        ],
      }),
      'invalid-tree',
    );
    expectNodeFailure(select({ value: 'missing' }), 'invalid-tree');
    expectNodeFailure(
      { kind: 'toggle', id: 'toggle-label', label: '', value: false, disabled: false },
      'unsafe-text',
    );
    expectNodeFailure(
      {
        kind: 'button',
        id: 'danger-no-confirm',
        label: 'Danger',
        disabled: false,
        dangerous: true,
      },
      'invalid-tree',
    );
    expectNodeFailure(
      {
        kind: 'button',
        id: 'safe-with-confirm',
        label: 'Safe',
        disabled: false,
        dangerous: false,
        confirmation: 'Confirm',
      },
      'invalid-tree',
    );
    expectNodeFailure(
      {
        kind: 'button',
        id: 'danger-empty-confirm',
        label: 'Danger',
        disabled: false,
        dangerous: true,
        confirmation: '',
      },
      'unsafe-text',
    );
  });

  test('covers every patch operation, traversal shape, and atomic rejection branch', () => {
    const current = surface(completeTree());
    const applied = applyPluginSurfacePatch(current, {
      runtime,
      surfaceId: current.surfaceId,
      baseRevision: 1,
      nextRevision: 2,
      operations: [
        { kind: 'set-text', nodeId: 'complete-text', text: 'Updated text' },
        { kind: 'set-text', nodeId: 'complete-badge', text: 'Updated badge' },
        { kind: 'set-text', nodeId: 'complete-log', text: 'Updated log' },
        { kind: 'set-text', nodeId: 'complete-code', text: 'Updated code' },
        { kind: 'set-value', nodeId: 'complete-text-input', value: 'updated' },
        { kind: 'set-value', nodeId: 'complete-number-input', value: '2.5' },
        { kind: 'set-value', nodeId: 'complete-select', value: 'one' },
        { kind: 'set-value', nodeId: 'complete-toggle', value: 'true' },
        { kind: 'set-disabled', nodeId: 'complete-text-input', disabled: true },
        { kind: 'set-disabled', nodeId: 'complete-number-input', disabled: true },
        { kind: 'set-disabled', nodeId: 'complete-select', disabled: true },
        { kind: 'set-disabled', nodeId: 'complete-toggle', disabled: true },
        { kind: 'set-disabled', nodeId: 'complete-button', disabled: true },
        { kind: 'select-tab', nodeId: 'complete-tabs', selectedId: 'complete-tab' },
      ],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(Object.isFrozen(applied.surface.root)).toBe(true);
    expect(Object.isFrozen(freezeSurface(current).root)).toBe(true);

    const toggledBack = applyPluginSurfacePatch(applied.surface, {
      runtime,
      surfaceId: current.surfaceId,
      baseRevision: 2,
      nextRevision: 3,
      operations: [{ kind: 'set-value', nodeId: 'complete-toggle', value: 'false' }],
    });
    expect(toggledBack.ok).toBe(true);

    const replacement = applyPluginSurfacePatch(current, {
      runtime,
      surfaceId: current.surfaceId,
      baseRevision: 1,
      nextRevision: 2,
      operations: [
        {
          kind: 'replace-node',
          nodeId: 'complete-text',
          node: { kind: 'text', id: 'complete-text', text: 'Replacement', tone: 'default' },
        },
      ],
    });
    expect(replacement.ok).toBe(true);

    const invalidOperations: PluginSurfacePatch['operations'] = [
      {
        kind: 'replace-node',
        nodeId: 'complete-text',
        node: { kind: 'text', id: 'other', text: 'x', tone: 'default' },
      },
      { kind: 'set-text', nodeId: 'complete-button', text: 'x' },
      { kind: 'set-value', nodeId: 'complete-toggle', value: 'yes' },
      { kind: 'set-value', nodeId: 'complete-text', value: 'x' },
      { kind: 'set-disabled', nodeId: 'complete-progress', disabled: true },
      { kind: 'select-tab', nodeId: 'complete-tabs', selectedId: 'missing' },
      { kind: 'select-tab', nodeId: 'complete-text', selectedId: 'missing' },
    ];
    for (const operation of invalidOperations) {
      expect(
        applyPluginSurfacePatch(current, {
          runtime,
          surfaceId: current.surfaceId,
          baseRevision: 1,
          nextRevision: 2,
          operations: [operation],
        }),
      ).toMatchObject({ ok: false, failure: { code: 'invalid-patch' } });
    }

    for (const patch of [
      { ...runtime, workspaceId: 'other-workspace' },
      { ...runtime, pluginId: 'other.plugin' },
      { ...runtime, instanceId: 8 },
      { ...runtime, generation: 4 },
    ]) {
      expect(
        applyPluginSurfacePatch(current, {
          runtime: patch,
          surfaceId: current.surfaceId,
          baseRevision: 1,
          nextRevision: 2,
          operations: [{ kind: 'set-text', nodeId: 'complete-text', text: 'x' }],
        }),
      ).toMatchObject({ ok: false, failure: { code: 'stale-revision' } });
    }
    expect(
      applyPluginSurfacePatch(current, {
        runtime,
        surfaceId: 'other-surface',
        baseRevision: 1,
        nextRevision: 2,
        operations: [{ kind: 'set-text', nodeId: 'complete-text', text: 'x' }],
      }),
    ).toMatchObject({ ok: false, failure: { code: 'stale-revision' } });

    const invalidPatches: PluginSurfacePatch[] = [
      {
        runtime,
        surfaceId: current.surfaceId,
        baseRevision: 1,
        nextRevision: 0,
        operations: [{ kind: 'set-text', nodeId: 'complete-text', text: 'x' }],
      },
      {
        runtime,
        surfaceId: current.surfaceId,
        baseRevision: 1,
        nextRevision: 3,
        operations: [{ kind: 'set-text', nodeId: 'complete-text', text: 'x' }],
      },
      { runtime, surfaceId: current.surfaceId, baseRevision: 1, nextRevision: 2, operations: [] },
      {
        runtime,
        surfaceId: current.surfaceId,
        baseRevision: 1,
        nextRevision: 2,
        operations: Array.from({ length: PLUGIN_SURFACE_MAX_PATCH_OPERATIONS + 1 }, () => ({
          kind: 'set-text' as const,
          nodeId: 'complete-text',
          text: 'x',
        })),
      },
      {
        runtime,
        surfaceId: current.surfaceId,
        baseRevision: 1,
        nextRevision: 2,
        operations: [{ kind: 'set-text', nodeId: 'complete-text', text: 'x'.repeat(513 * 1024) }],
      },
    ];
    for (const patch of invalidPatches) {
      expect(applyPluginSurfacePatch(current, patch)).toMatchObject({
        ok: false,
        failure: { code: 'invalid-patch' },
      });
    }
    expect(
      applyPluginSurfacePatch(current, {
        runtime,
        surfaceId: current.surfaceId,
        baseRevision: 1,
        nextRevision: 2,
        operations: [{ kind: 'set-text', nodeId: 'unknown', text: 'x' }],
      }),
    ).toMatchObject({ ok: false, failure: { code: 'invalid-patch' } });
  });

  test('accepts and rejects events for every interactive and passive node kind', () => {
    const current = surface(completeTree());
    const accepted: Array<
      [string, Parameters<typeof createPluginSurfaceEvent>[2], string | undefined]
    > = [
      ['complete-button', 'activate', undefined],
      ['complete-text-input', 'input', 'input'],
      ['complete-text-input', 'change', 'change'],
      ['complete-number-input', 'input', '2.5'],
      ['complete-number-input', 'change', '3'],
      ['complete-select', 'change', 'one'],
      ['complete-toggle', 'change', 'true'],
      ['complete-toggle', 'change', 'false'],
      ['complete-tabs', 'select-tab', 'complete-tab'],
      ['complete-table', 'request-page', '1'],
    ];
    for (const [nodeId, event, value] of accepted) {
      expect(createPluginSurfaceEvent(current, nodeId, event, value)).not.toBeNull();
    }

    for (const [nodeId, event, value] of [
      ['complete-button', 'activate', 'unexpected'],
      ['complete-text-input', 'input', undefined],
      ['complete-number-input', 'input', ''],
      ['complete-number-input', 'input', 'NaN'],
      ['complete-select', 'change', 'missing'],
      ['complete-toggle', 'change', 'yes'],
      ['complete-tabs', 'select-tab', 'missing'],
      ['complete-table', 'request-page', '-1'],
      ['complete-table', 'request-page', '2'],
    ] as const) {
      expect(createPluginSurfaceEvent(current, nodeId, event, value)).toBeNull();
    }
    expect(createPluginSurfaceEvent(current, 'Bad ID', 'activate')).toBeNull();
    expect(
      createPluginSurfaceEvent(current, 'complete-text-input', 'input', 'file://secret'),
    ).toBeNull();
    expect(createPluginSurfaceEvent(current, 'missing', 'activate')).toBeNull();

    for (const node of completeTree().kind === 'column' ? completeTree().children : []) {
      if (node.kind === 'row') {
        expect(createPluginSurfaceEvent(current, node.id, 'activate')).toBeNull();
      }
    }
    for (const node of [
      { kind: 'text', id: 'passive-text', text: 'x', tone: 'default' },
      { kind: 'code', id: 'passive-code', text: 'x', language: 'text' },
      { kind: 'progress', id: 'passive-progress', label: 'P', completed: 0, total: 1 },
      { kind: 'column', id: 'passive-column', children: [] },
      { kind: 'row', id: 'passive-row', children: [] },
      { kind: 'group', id: 'passive-group', label: 'G', children: [] },
      { kind: 'badge', id: 'passive-badge', text: 'B', tone: 'default' },
      { kind: 'key-value-list', id: 'passive-kv', entries: [] },
      { kind: 'log', id: 'passive-log', text: 'L', maxLines: 1 },
    ] as PluginUiNode[]) {
      const passiveSurface = surface(node);
      expect(createPluginSurfaceEvent(passiveSurface, node.id, 'activate')).toBeNull();
    }
    const disabled = surface({
      kind: 'button',
      id: 'disabled-button',
      label: 'Disabled',
      disabled: true,
      dangerous: false,
    });
    expect(createPluginSurfaceEvent(disabled, 'disabled-button', 'activate')).toBeNull();
  });
});
