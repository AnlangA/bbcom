import { effectScope, reactive, type EffectScope } from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import { MAX_INPUT_SIZE } from '@/types';
import { useSendComposer, type SendComposerState } from '../application/use-send-composer';

const scopes: EffectScope[] = [];
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<SendComposerState> = {}) {
  const state = reactive<SendComposerState>({
    input: 'AA BB',
    isHex: true,
    lineEnding: 'none',
    checksum: 'none',
    disabled: false,
    looping: false,
    sessionId: 'session-1',
    ...overrides,
  });
  const deps = {
    // Match the component's reactive snapshot getter, including unrelated fields.
    getState: () => ({ ...state }),
    calculateChecksum: vi
      .fn<(data: Uint8Array, algorithm: string) => Promise<{ result: string }>>()
      .mockResolvedValue({ result: '01 02' }),
    send: vi.fn<(data: string, isHex: boolean) => Promise<boolean>>().mockResolvedValue(true),
    startLoop: vi.fn<(data: string, isHex: boolean) => boolean>().mockReturnValue(true),
    stopLoop: vi.fn(),
    updateInput: vi.fn(),
    onSent: vi.fn(),
    onError: vi.fn(),
    onWarning: vi.fn(),
  };
  const scope = effectScope();
  scopes.push(scope);
  const composer = scope.run(() => useSendComposer(deps))!;
  return { state, deps, composer, scope };
}

test('captures HEX mode with the payload and keeps a newly edited draft while preventing duplicate sends', async () => {
  const { state, deps, composer } = fixture({ checksum: 'CRC16' });
  const checksum = deferred<{ result: string }>();
  deps.calculateChecksum.mockReturnValue(checksum.promise);

  const sending = composer.send();
  expect(composer.pending.value).toBe('send');
  await composer.send();
  await composer.toggleLoop();
  state.isHex = false;
  state.input = 'next command';
  checksum.resolve({ result: '01 02' });
  await sending;

  expect(deps.calculateChecksum).toHaveBeenCalledTimes(1);
  expect(deps.send).toHaveBeenCalledExactlyOnceWith('AA BB 01 02', true);
  expect(deps.startLoop).not.toHaveBeenCalled();
  expect(deps.updateInput).not.toHaveBeenCalled();
  expect(composer.pending.value).toBeNull();
});

test('preserves text edited during a slow transport write', async () => {
  const { state, deps, composer } = fixture({ input: 'first', isHex: false });
  const write = deferred<boolean>();
  deps.send.mockReturnValue(write.promise);
  const sending = composer.send();
  await Promise.resolve();
  expect(deps.send).toHaveBeenCalledExactlyOnceWith('first', false);
  state.input = 'second';
  write.resolve(true);
  await sending;
  expect(deps.updateInput).not.toHaveBeenCalled();
  expect(deps.onSent).toHaveBeenCalledOnce();
});

test('adds the captured line ending and clears an unchanged draft after success', async () => {
  const { deps, composer } = fixture({ input: 'AT', isHex: false, lineEnding: 'CRLF' });
  await composer.send();
  expect(deps.send).toHaveBeenCalledExactlyOnceWith('AT\r\n', false);
  expect(deps.updateInput).toHaveBeenCalledExactlyOnceWith('');
});

test('reports rejected transport writes and releases pending state for retry', async () => {
  const { deps, composer } = fixture();
  deps.send.mockRejectedValueOnce(new Error('port closed'));
  await composer.send();
  expect(deps.onError).toHaveBeenCalledExactlyOnceWith('send.error.failed');
  expect(deps.updateInput).not.toHaveBeenCalled();
  expect(composer.pending.value).toBeNull();
  await composer.send();
  expect(deps.send).toHaveBeenCalledTimes(2);
  expect(deps.updateInput).toHaveBeenCalledExactlyOnceWith('');
});

test('does not start a prepared loop after the connection has disconnected and reconnected', async () => {
  const { state, deps, composer } = fixture({ checksum: 'CRC16' });
  const checksum = deferred<{ result: string }>();
  deps.calculateChecksum.mockReturnValue(checksum.promise);
  const starting = composer.toggleLoop();
  state.disabled = true;
  state.disabled = false;
  checksum.resolve({ result: '01 02' });
  await starting;
  expect(deps.startLoop).not.toHaveBeenCalled();
  expect(composer.pending.value).toBeNull();
});

test('does not send a prepared payload after the composer scope is disposed', async () => {
  const { deps, composer, scope } = fixture({ checksum: 'CRC16' });
  const checksum = deferred<{ result: string }>();
  deps.calculateChecksum.mockReturnValue(checksum.promise);
  const sending = composer.send();
  scope.stop();
  checksum.resolve({ result: '01 02' });
  await sending;
  expect(deps.send).not.toHaveBeenCalled();
  expect(deps.updateInput).not.toHaveBeenCalled();
});

test('includes the selected checksum in byte count and validates payloads before sending', async () => {
  const { state, deps, composer } = fixture({ checksum: 'CRC32' });
  expect(composer.byteCount.value).toBe(6);
  state.input = 'AA B';
  expect(composer.validHex.value).toBe(false);
  await composer.send();
  expect(deps.send).not.toHaveBeenCalled();
  state.isHex = false;
  state.input = 'a'.repeat(MAX_INPUT_SIZE + 1);
  await composer.send();
  expect(deps.onError).toHaveBeenCalledExactlyOnceWith('send.error.tooLarge');
  expect(deps.send).not.toHaveBeenCalled();
});
