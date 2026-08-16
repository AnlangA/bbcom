import { describe, expect, test } from 'vitest';
import { validateDeclarativePanel, validPanelEventValue } from '../../src/features/plugins';

describe('plugin declarative panel contract', () => {
  test('accepts only the flat trusted-control whitelist', () => {
    expect(
      validateDeclarativePanel({
        runtime: {
          workspaceId: 'workspace-1',
          pluginId: 'example.plugin',
          instanceId: 1,
          generation: 1,
        },
        title: 'Example',
        fields: [
          {
            id: 'mode',
            label: 'Mode',
            kind: 'select',
            value: 'safe',
            options: ['safe', 'strict'],
            disabled: false,
          },
        ],
      }),
    ).toBe(true);
  });

  test('rejects markup, URLs and invalid event values', () => {
    expect(
      validateDeclarativePanel({
        runtime: {
          workspaceId: 'workspace-1',
          pluginId: 'example.plugin',
          instanceId: 1,
          generation: 1,
        },
        title: 'Unsafe',
        fields: [
          {
            id: 'content',
            label: 'Open https://example.test',
            kind: 'text',
            value: '<script>',
            options: [],
            disabled: false,
          },
        ],
      }),
    ).toBe(false);
    expect(
      validPanelEventValue(
        {
          id: 'enabled',
          label: 'Enabled',
          kind: 'toggle',
          value: 'false',
          options: [],
          disabled: false,
        },
        'yes',
      ),
    ).toBe(false);
  });
});
