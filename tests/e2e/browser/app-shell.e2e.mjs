import { browser, expect, $ } from '@wdio/globals';

describe('main window in browser mock mode', () => {
  it('boots the renderer without a native binary', async () => {
    const preload = await browser.addInitScript(() => {
      const workspaceId = '00000000-0000-4000-8000-000000000001';
      const summary = {
        workspaceId,
        name: 'Browser smoke workspace',
        revision: 0,
        updatedAtMs: 1,
        saveHealth: 'clean',
      };
      const journal = { phase: 'completed', workspaceId, expectedRevision: 0 };
      const mocks = (globalThis.__wdio_mocks__ ??= {});
      mocks.get_legacy_reset_journal = ({ request }) => ({
        requestId: request.requestId,
        journal,
      });
      mocks.open_workspace = ({ request }) => ({
        requestId: request.requestId,
        workspace: summary,
        header: { workspaceId, name: summary.name, revision: 0, sessionIds: [], layout: {} },
      });
      mocks.hydrate_workspace_sessions = ({ request }) => ({
        requestId: request.requestId,
        workspaceId,
        revision: 0,
        sessions: [],
      });
      mocks.workspace_catalog = ({ request }) => ({
        requestId: request.requestId,
        workspaces: [summary],
        activeWorkspaceId: workspaceId,
      });
      mocks.get_ai_window_state = () => ({ visible: false });
      mocks['plugin:serialplugin|available_ports'] = () => ({});
    });
    await browser.url('/');
    await expect($('body')).toBeDisplayed();
    // Chrome's headless compositor may report the full-viewport flex root as
    // non-displayed even after Vue has mounted it. Existence is the stable
    // renderer-bootstrap assertion; interactive visibility is covered by
    // native WebDriver smoke jobs.
    await expect($('.app-layout')).toExist();
    await preload.remove();
  });
});
