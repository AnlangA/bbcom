import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useSerialStore } from '@/features/serial/store/serial-store.ts';
import { usePortWatcher } from '@/features/serial/application/use-port-watcher.ts';

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

function setup(enumerator: () => Promise<Record<string, unknown>>) {
  setActivePinia(createPinia());
  const serial = useSerialStore();
  // usePortWatcher registers onMounted; calling it outside a component logs a
  // warn but still returns a usable API whose refresh() is the unit under test.
  const watcher = usePortWatcher(1500, { enumerate: enumerator });
  return { serial, watcher };
}

test('usePortWatcher: refresh detects real serial ports and syncs the store', async () => {
  await withLocalStorageMock(async () => {
    const { serial, watcher } = setup(async () => ({
      '/dev/ttyUSB0': {},
      '/dev/tty.usbserial-AB': {},
      // pseudo-devices filtered out by isRealSerialPort:
      '/dev/cu.Bluetooth-Incoming-Port': {},
    }));

    await watcher.refresh();

    assert.deepEqual(
      [...watcher.ports.value].sort(),
      ['/dev/tty.usbserial-AB', '/dev/ttyUSB0'].sort(),
      'real ports detected, pseudo-devices filtered',
    );
    assert.deepEqual(
      [...serial.availablePorts].sort(),
      [...watcher.ports.value].sort(),
      'store mirrors the detected list',
    );
  });
});

test('usePortWatcher: refresh preserves existing order and appends new ports', async () => {
  await withLocalStorageMock(async () => {
    let ports = { '/dev/ttyUSB0': {} };
    const { watcher } = setup(async () => ({ ...ports }));

    await watcher.refresh();
    assert.deepEqual(watcher.ports.value, ['/dev/ttyUSB0']);

    // A new port appears on the next poll — it should be appended, not reordered.
    ports = { '/dev/ttyUSB0': {}, '/dev/ttyUSB1': {} };
    await watcher.refresh();
    assert.deepEqual(
      watcher.ports.value,
      ['/dev/ttyUSB0', '/dev/ttyUSB1'],
      'existing order preserved, new port appended',
    );
  });
});

test('usePortWatcher: refresh drops ports that are no longer detected', async () => {
  await withLocalStorageMock(async () => {
    let ports: Record<string, unknown> = { '/dev/ttyUSB0': {}, '/dev/ttyUSB1': {} };
    const { watcher } = setup(async () => ({ ...ports }));

    await watcher.refresh();
    assert.equal(watcher.ports.value.length, 2);

    // ttyUSB1 disappears (unplugged) → it must be removed.
    ports = { '/dev/ttyUSB0': {} };
    await watcher.refresh();
    assert.deepEqual(watcher.ports.value, ['/dev/ttyUSB0'], 'unplugged port dropped');
  });
});

test('usePortWatcher: refresh is a no-op when the detected list is unchanged', async () => {
  await withLocalStorageMock(async () => {
    const snapshot = { '/dev/ttyUSB0': {} };
    const { serial, watcher } = setup(async () => ({ ...snapshot }));

    await watcher.refresh();
    const storeCountAfterFirst = serial.availablePorts.length;

    // Second refresh with identical input: ports.value reference must not change
    // (same array identity, no spurious store writes to assert on — just length stable).
    await watcher.refresh();
    assert.equal(
      serial.availablePorts.length,
      storeCountAfterFirst,
      'no churn on an unchanged list',
    );
  });
});

test('usePortWatcher: refresh swallows enumeration errors (transient failures retried later)', async () => {
  await withLocalStorageMock(async () => {
    let shouldFail = true;
    const { watcher } = setup(async () => {
      if (shouldFail) throw new Error('permission denied');
      return { '/dev/ttyUSB0': {} };
    });

    // A failing enumeration must not throw out of refresh().
    await watcher.refresh();
    assert.deepEqual(watcher.ports.value, [], 'failure leaves the list untouched');

    // Recovery: once enumeration succeeds, the list populates.
    shouldFail = false;
    await watcher.refresh();
    assert.deepEqual(watcher.ports.value, ['/dev/ttyUSB0'], 'recovers after the transient failure');
  });
});
