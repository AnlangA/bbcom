import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useAppStore } from '../../src/features/settings/store/app-store.ts';
import { useWorkspaceUiStore } from '../../src/features/workspace';

interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function withLocalStorageMock<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const previous = (globalThis as { localStorage?: LocalStorageLike }).localStorage;
  const data = new Map<string, string>();
  (globalThis as { localStorage: LocalStorageLike }).localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v));
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
  // For async fn, we must keep the mock installed until fn settles — otherwise
  // a finally block would restore the real localStorage while the awaited body
  // is still running (silently breaking any deferred read/write inside it).
  const restore = () => {
    (globalThis as { localStorage?: LocalStorageLike }).localStorage = previous;
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (v) => {
          restore();
          return v;
        },
        (e) => {
          restore();
          throw e;
        },
      );
    }
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
  }
}

test('setLoopIntervalMs clamps into the allowed range', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const app = useAppStore();

    app.setLoopIntervalMs(10);
    assert.equal(app.loopIntervalMs, 50, 'below minimum clamps to 50');

    app.setLoopIntervalMs(5_000_000);
    assert.equal(app.loopIntervalMs, 3_600_000, 'above maximum clamps to 1h');

    app.setLoopIntervalMs(250);
    assert.equal(app.loopIntervalMs, 250, 'in-range value passes through');

    app.setLoopIntervalMs(NaN);
    assert.equal(app.loopIntervalMs, 1000, 'NaN falls back to default 1000');
  });
});

test('applyAiCommand sets the draft and bumps the sequence', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const app = useAppStore();
    const before = app.aiCommandSeq;

    app.applyAiCommand('ls -la');

    assert.equal(app.aiCommandDraft, 'ls -la');
    assert.equal(app.aiCommandSeq, before + 1);
  });
});

test('pending AI command is consumed exactly once', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const app = useAppStore();

    app.setPendingAiCommand('pwd');
    assert.equal(app.pendingAiCommand, 'pwd');
    assert.equal(app.consumePendingAiCommand(), 'pwd');
    assert.equal(app.pendingAiCommand, '', 'consumed command is cleared');
    assert.equal(app.consumePendingAiCommand(), '', 'second consume returns empty');
  });
});

test('setters update each persisted setting through its validate/apply path', async () => {
  await withLocalStorageMock(async () => {
    setActivePinia(createPinia());
    const app = useAppStore();
    const workspaceUi = useWorkspaceUiStore();

    // Cover each validate/apply shape in the descriptor table: string-enum
    // (displayMode/packetViewMode/searchMode), boolean (sendAsHex), clamped number (sidebarWidth), and a number routed
    // through its own setter (maxBufferFrames). These assertions verify the
    // setters and apply() clamping that drive the persisted payload; the
    // freshly-loaded-store test below proves the full disk round-trip.
    app.setDisplayMode('UTF8');
    app.setSendAsHex(true);
    workspaceUi.setSidebarWidth(999); // above max → clamps to 340
    app.setMaxBufferFrames(50_000);
    app.setPacketViewMode('MERGED');
    app.setSearchMode('HEX');
    app.setTheme('light');
    app.toggleLogLineBreaks();

    assert.equal(app.displayMode, 'UTF8');
    assert.equal(app.sendAsHex, true);
    assert.equal(workspaceUi.sidebarWidth, 340, 'sidebarWidth clamped on set');
    assert.equal(app.maxBufferFrames, 50_000);
    assert.equal(app.packetViewMode, 'MERGED');
    assert.equal(app.searchMode, 'HEX');
    assert.equal(app.theme, 'light');
    assert.equal(app.preserveLogLineBreaks, false);

    // save() is debounced — flush it so the test does not leave a pending timer
    // that could leak across test boundaries.
    await new Promise((r) => setTimeout(r, 360));
  });
});

test('a freshly-loaded store re-reads the persisted blob', async () => {
  await withLocalStorageMock(async () => {
    // Seed the blob first, then instantiate — load() must honor every field.
    (globalThis as { localStorage: LocalStorageLike }).localStorage.setItem(
      'bbcom-v1:app-settings',
      JSON.stringify({
        displayMode: 'ANSI',
        sendAsHex: true,
        sidebarWidth: 300,
        maxBufferFrames: 42_000,
        packetViewMode: 'MERGED',
        searchMode: 'HEX',
        autoScroll: false,
        preserveLogLineBreaks: false,
        theme: 'dark',
      }),
    );

    setActivePinia(createPinia());
    const app = useAppStore();
    const workspaceUi = useWorkspaceUiStore();
    // load() is async (it kicks off the secret migration), but its synchronous
    // part — reading the JSON blob into the refs — runs before useAppStore()
    // returns, so the values are already applied here.
    assert.equal(app.displayMode, 'ANSI');
    assert.equal(app.sendAsHex, true);
    assert.equal(
      workspaceUi.sidebarWidth,
      292,
      'legacy global sidebar is read-only compatibility data and cannot override a workspace',
    );
    assert.equal(app.maxBufferFrames, 42_000);
    assert.equal(app.packetViewMode, 'MERGED');
    assert.equal(app.searchMode, 'HEX');
    assert.equal(app.autoScroll, false);
    assert.equal(app.preserveLogLineBreaks, false);
    assert.equal(app.theme, 'dark');
  });
});

test('garbage persisted values are ignored, not thrown', async () => {
  await withLocalStorageMock(async () => {
    // Seed a blob with wrong-typed values for several keys.
    (globalThis as { localStorage: LocalStorageLike }).localStorage.setItem(
      'bbcom-v1:app-settings',
      JSON.stringify({
        autoScroll: 'yes', // not a boolean
        sidebarWidth: 'wide', // not a number
        loopIntervalMs: null, // not a number
        theme: 'hot-pink', // not the 'light' literal
      }),
    );
    setActivePinia(createPinia());
    const app = useAppStore();
    const workspaceUi = useWorkspaceUiStore();

    // Wrong-typed values fall back to defaults instead of crashing.
    assert.equal(app.autoScroll, true);
    assert.equal(workspaceUi.sidebarWidth, 292);
    assert.equal(app.loopIntervalMs, 1000);
    assert.equal(app.theme, 'dark', 'unknown theme literal is ignored');
  });
});

test('workspace layout applies without echo and user changes publish one versioned snapshot', () => {
  withLocalStorageMock(() => {
    setActivePinia(createPinia());
    const workspaceUi = useWorkspaceUiStore();
    const published: unknown[] = [];
    const unsubscribe = workspaceUi.subscribe((layout) => published.push(layout));

    workspaceUi.apply({
      version: 1,
      sidebar: { width: 312, collapsed: true },
    });
    assert.equal(workspaceUi.sidebarWidth, 312);
    assert.equal(workspaceUi.sidebarCollapsed, true);
    assert.deepEqual(published, [], 'hydration must not enqueue a workspace mutation');

    workspaceUi.setSidebarWidth(320);
    workspaceUi.toggleSidebarCollapsed();
    assert.deepEqual(published, [
      { version: 1, sidebar: { width: 320, collapsed: true } },
      { version: 1, sidebar: { width: 320, collapsed: false } },
    ]);

    unsubscribe();
    workspaceUi.setSidebarWidth(300);
    assert.equal(published.length, 2);
  });
});
