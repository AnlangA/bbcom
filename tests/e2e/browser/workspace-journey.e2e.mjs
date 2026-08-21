/* global afterAll, beforeAll */

import axe from 'axe-core';
import { browser, expect, $, $$ } from '@wdio/globals';

const INITIAL_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const CREATED_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const INITIAL_WORKSPACE_NAME = 'Clean install workspace';
const CREATED_WORKSPACE_NAME = 'Browser journey workspace';

describe('project workspace browser journey', () => {
  let preload;

  beforeAll(async () => {
    await clearRendererState();
    preload = await installCleanInstallBackend();
    await browser.url('/');
  });

  afterAll(async () => {
    await browser.tauri.restoreAllMocks();
    await preload?.remove();
  });

  it('opens a clean install, creates and reopens projects, and passes the real axe gate', async () => {
    await expect($('.app-layout')).toExist();
    await expect($('.workspace-current')).toHaveText(
      expect.stringContaining(INITIAL_WORKSPACE_NAME),
    );
    await browser.waitUntil(async () => {
      const evidence = await readBootstrapEvidence();
      return evidence.commands.at(-1) === 'workspace_catalog';
    });

    const bootstrap = await readBootstrapEvidence();
    expect(bootstrap.commands).toEqual([
      'workspace_catalog',
      'open_workspace',
      'hydrate_workspace_sessions',
      'workspace_catalog',
    ]);

    const mocks = await installInteractiveWorkspaceMocks();
    await $('.workspace-actions button:first-child').click();

    const createDialog = $('.workspace-dialog');
    await expect(createDialog).toBeDisplayed();
    await createDialog.$('input').setValue(CREATED_WORKSPACE_NAME);
    const createActions = await createDialog.$$('button');
    await createActions.at(-1).click();

    await expect($('.workspace-current')).toHaveText(
      expect.stringContaining(CREATED_WORKSPACE_NAME),
    );
    await mocks.create.update();
    expect(mocks.create.mock.calls.length).toBe(1);
    expect(mocks.create.mock.calls[0][0].request.name).toBe(CREATED_WORKSPACE_NAME);
    expect(mocks.create.mock.results[0].value.workspace.workspaceId).toBe(CREATED_WORKSPACE_ID);

    const initialProjectOrder = await projectOrder();
    expect(initialProjectOrder).toEqual([INITIAL_WORKSPACE_NAME, CREATED_WORKSPACE_NAME]);

    const initialProjectButton = await findProject(INITIAL_WORKSPACE_NAME);
    await initialProjectButton.click();
    await expect($('.workspace-current')).toHaveText(
      expect.stringContaining(INITIAL_WORKSPACE_NAME),
    );
    expect(await projectOrder()).toEqual(initialProjectOrder);

    await mocks.open.update();
    expect(mocks.open.mock.calls.length).toBe(1);
    expect(mocks.open.mock.calls[0][0].request.workspaceId).toBe(INITIAL_WORKSPACE_ID);
    await mocks.flush.update();
    await mocks.hydrate.update();
    expect(mocks.flush.mock.calls.length).toBe(2);
    expect(mocks.hydrate.mock.calls.length).toBe(2);
    await mocks.serialOpen.update();
    await mocks.aiRequest.update();
    expect(mocks.serialOpen.mock.calls.length).toBe(0);
    expect(mocks.aiRequest.mock.calls.length).toBe(0);

    await assertNoSeriousOrCriticalAxeViolations('#app');
  });
});

async function clearRendererState() {
  await browser.execute(() => globalThis.localStorage.clear());
  const result = await browser.executeAsync((databaseName, done) => {
    const request = globalThis.indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => done({ ok: true });
    request.onerror = () => done({ ok: false, error: request.error?.message ?? 'delete failed' });
    request.onblocked = () => done({ ok: false, error: 'database deletion was blocked' });
  }, 'bbcom-session-state');
  if (!result.ok) throw new Error(`Unable to prepare clean-install fixture: ${result.error}`);
}

async function installCleanInstallBackend() {
  return browser.addInitScript(
    (fixture) => {
      const state = {
        calls: [],
      };
      globalThis.__bbcomBrowserJourney = state;
      const mocks = (globalThis.__wdio_mocks__ ??= {});

      const summary = (workspaceId, name) => ({
        workspaceId,
        name,
        revision: 0,
        updatedAtMs: 1,
        saveHealth: 'clean',
      });
      const header = (workspaceId, name) => ({
        workspaceId,
        name,
        revision: 0,
        sessionIds: [],
        layout: {},
      });
      const record = (command, args) => {
        state.calls.push({ command, args });
      };

      mocks.open_workspace = (args) => {
        record('open_workspace', args);
        return {
          requestId: args.request.requestId,
          workspace: summary(fixture.workspaceId, fixture.workspaceName),
          header: header(fixture.workspaceId, fixture.workspaceName),
        };
      };
      mocks.hydrate_workspace_sessions = (args) => {
        record('hydrate_workspace_sessions', args);
        return {
          requestId: args.request.requestId,
          workspaceId: args.request.workspaceId,
          revision: 0,
          sessions: [],
        };
      };
      mocks.workspace_catalog = (args) => {
        record('workspace_catalog', args);
        return {
          requestId: args.request.requestId,
          workspaces: [summary(fixture.workspaceId, fixture.workspaceName)],
          activeWorkspaceId: fixture.workspaceId,
        };
      };
      mocks.get_ai_window_state = () => ({ visible: false });
      mocks['plugin:serialplugin|available_ports'] = () => ({});
    },
    {
      workspaceId: INITIAL_WORKSPACE_ID,
      workspaceName: INITIAL_WORKSPACE_NAME,
    },
  );
}

async function readBootstrapEvidence() {
  return browser.execute(() => {
    const state = globalThis.__bbcomBrowserJourney;
    const bootstrapCommands = new Set([
      'workspace_catalog',
      'open_workspace',
      'hydrate_workspace_sessions',
    ]);
    const calls = state.calls.filter(({ command }) => bootstrapCommands.has(command));
    return {
      commands: calls.map(({ command }) => command),
    };
  });
}

async function installInteractiveWorkspaceMocks() {
  const flush = await browser.tauri.mock('flush_workspace');
  await flush.mockImplementation(({ request }) => ({
    committedRevision: request.targetRevision,
    saveHealth: 'clean',
  }));

  const hydrate = await browser.tauri.mock('hydrate_workspace_sessions');
  await hydrate.mockImplementation(({ request }) => ({
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    revision: 0,
    sessions: [],
  }));

  const create = await browser.tauri.mock('create_workspace');
  await create.mockImplementation(({ request }) => ({
    requestId: request.requestId,
    workspace: {
      workspaceId: '00000000-0000-4000-8000-000000000002',
      name: request.name,
      revision: 0,
      updatedAtMs: 2,
      saveHealth: 'clean',
    },
    header: {
      workspaceId: '00000000-0000-4000-8000-000000000002',
      name: request.name,
      revision: 0,
      sessionIds: [],
      layout: {},
    },
  }));

  const open = await browser.tauri.mock('open_workspace');
  await open.mockImplementation(({ request }) => ({
    requestId: request.requestId,
    workspace: {
      workspaceId: request.workspaceId,
      name: 'Clean install workspace',
      revision: 0,
      updatedAtMs: 1,
      saveHealth: 'clean',
    },
    header: {
      workspaceId: request.workspaceId,
      name: 'Clean install workspace',
      revision: 0,
      sessionIds: [],
      layout: {},
    },
  }));

  const serialOpen = await browser.tauri.mock('plugin:serialplugin|open');
  const aiRequest = await browser.tauri.mock('run_ai_request');
  return { create, open, flush, hydrate, serialOpen, aiRequest };
}

async function findProject(name) {
  const projects = await $$('.workspace-project-item');
  for (const project of projects) {
    if ((await project.getText()).includes(name)) return project;
  }
  throw new Error(`Project was not rendered: ${name}`);
}

async function projectOrder() {
  const projects = await $$('.workspace-project-item');
  const names = [];
  for (const project of projects) names.push(await project.$('span').getText());
  return names;
}

async function assertNoSeriousOrCriticalAxeViolations(selector) {
  await browser.execute(axe.source);
  const audit = await browser.executeAsync((scopeSelector, done) => {
    const scope = globalThis.document.querySelector(scopeSelector);
    if (!scope) {
      done({ ok: false, error: `axe scope does not exist: ${scopeSelector}` });
      return;
    }
    globalThis.axe
      .run(scope, { resultTypes: ['violations'] })
      .then((result) => {
        done({
          ok: true,
          engineVersion: result.testEngine.version,
          violations: result.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            targets: violation.nodes.flatMap((node) => node.target),
            elements: violation.nodes.map((node) => node.html),
          })),
        });
      })
      .catch((error) => done({ ok: false, error: String(error) }));
  }, selector);

  if (!audit.ok) throw new Error(`axe.run failed: ${audit.error}`);
  expect(audit.engineVersion).toBe('4.12.1');
  const blocking = audit.violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
  );
  if (blocking.length > 0) {
    throw new Error(`axe serious/critical violations:\n${JSON.stringify(blocking, null, 2)}`);
  }
}
