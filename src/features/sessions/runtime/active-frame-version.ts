import { readonly, shallowRef, watchEffect, type Ref } from 'vue';

/**
 * Expose frame changes only while a resident session is visible.
 *
 * Session views remain mounted so their serial connection and background
 * runtime keep running. The dependency on `currentVersion` is deliberately
 * branch-tracked: once a view becomes inactive, Vue unsubscribes this effect
 * from that session's frame pulse and the last rendered version is frozen.
 * Reactivating the view reads the latest version and catches the UI up once.
 */
export function useActiveFrameVersion(
  active: Readonly<Ref<boolean>>,
  currentVersion: Readonly<Ref<number>>,
): Readonly<Ref<number>> {
  const visibleVersion = shallowRef(0);

  watchEffect(
    () => {
      if (!active.value) return;
      visibleVersion.value = currentVersion.value;
    },
    { flush: 'sync' },
  );

  return readonly(visibleVersion);
}
