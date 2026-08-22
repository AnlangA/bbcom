import { emit, listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type NativeEvent<T> = Event<T>;

export function emitNativeEvent(event: string, payload?: unknown): Promise<void> {
  return emit(event, payload);
}

export function listenNativeEvent<T>(
  event: string,
  handler: (event: NativeEvent<T>) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, handler);
}

export function getCurrentWindowAlwaysOnTop(): Promise<boolean> {
  return getCurrentWindow().isAlwaysOnTop();
}

export function setCurrentWindowAlwaysOnTop(value: boolean): Promise<void> {
  return getCurrentWindow().setAlwaysOnTop(value);
}
