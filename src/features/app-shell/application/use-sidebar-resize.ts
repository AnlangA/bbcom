import { onUnmounted, ref, watch } from 'vue';
import {
  SIDEBAR_WIDTH_LARGE_STEP,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STEP,
} from '@/lib/sidebar-layout';

/** Own the drag lifecycle without coupling it to a workspace or store. */
export function useSidebarResize(options: {
  width: () => number;
  collapsed: () => boolean;
  onResize: (width: number) => void;
}) {
  const isDragging = ref(false);
  let startX = 0;
  let startWidth = 0;
  let previousCursor = '';
  let previousUserSelect = '';

  function stopResize() {
    if (!isDragging.value) return;
    isDragging.value = false;
    document.removeEventListener('mousemove', onResize);
    document.removeEventListener('mouseup', stopResize);
    window.removeEventListener('blur', stopResize);
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
  }

  function startResize(event: MouseEvent) {
    if (options.collapsed() || event.button !== 0 || isDragging.value) return;
    event.preventDefault();
    startX = event.clientX;
    startWidth = options.width();
    previousCursor = document.body.style.cursor;
    previousUserSelect = document.body.style.userSelect;
    isDragging.value = true;
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup', stopResize);
    window.addEventListener('blur', stopResize);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onResize(event: MouseEvent) {
    options.onResize(startWidth + event.clientX - startX);
  }

  function onResizeKeydown(event: KeyboardEvent) {
    if (options.collapsed()) return;
    const step = event.shiftKey ? SIDEBAR_WIDTH_LARGE_STEP : SIDEBAR_WIDTH_STEP;
    const widths: Record<string, number> = {
      ArrowLeft: options.width() - step,
      ArrowRight: options.width() + step,
      Home: SIDEBAR_WIDTH_MIN,
      End: SIDEBAR_WIDTH_MAX,
    };
    const width = widths[event.key];
    if (width === undefined) return;
    event.preventDefault();
    options.onResize(width);
  }

  watch(options.collapsed, (collapsed) => {
    if (collapsed) stopResize();
  });
  onUnmounted(stopResize);
  return { isDragging, startResize, onResizeKeydown };
}
