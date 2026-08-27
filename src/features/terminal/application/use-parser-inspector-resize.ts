import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, type Ref } from 'vue';

export const PARSER_INSPECTOR_COMPACT_BREAKPOINT = 820;
export const PARSER_INSPECTOR_HANDLE_SIZE = 8;
export const PARSER_INSPECTOR_MIN_WIDTH = 300;
export const PARSER_INSPECTOR_MIN_HEIGHT = 160;
export const PARSER_RECORD_LIST_MIN_WIDTH = 260;
export const PARSER_RECORD_LIST_MIN_HEIGHT = 140;
export const PARSER_INSPECTOR_RESIZE_STEP = 16;
export const PARSER_INSPECTOR_RESIZE_LARGE_STEP = 48;

type InspectorAxis = 'inline' | 'block';

interface InspectorBounds {
  min: number;
  max: number;
}

/**
 * Runtime-only split-pane geometry for ParserPanel. The inspector keeps an
 * independent size for side-by-side and stacked layouts, but neither value is
 * persisted with the workspace.
 */
export function useParserInspectorResize(parserBodyRef: Ref<HTMLElement | null>) {
  const bodyInlineSize = ref(0);
  const bodyBlockSize = ref(0);
  const inspectorInlineSize = ref<number | null>(null);
  const inspectorBlockSize = ref<number | null>(null);
  const resizing = ref(false);
  const paneId = `parser-inspector-${useId()}`;

  const compact = computed(
    () => bodyInlineSize.value > 0 && bodyInlineSize.value <= PARSER_INSPECTOR_COMPACT_BREAKPOINT,
  );
  const axis = computed<InspectorAxis>(() => (compact.value ? 'block' : 'inline'));
  const bounds = computed(() => inspectorBounds(axis.value));
  const size = computed(() => inspectorSize(axis.value));
  const inlineSize = computed(() => inspectorSize('inline'));
  const blockSize = computed(() => inspectorSize('block'));
  const orientation = computed(() => (compact.value ? 'horizontal' : 'vertical'));

  let observer: ResizeObserver | null = null;
  let dragAxis: InspectorAxis = 'inline';
  let dragStartCoordinate = 0;
  let dragStartSize = 0;
  let captureTarget: HTMLElement | null = null;
  let capturePointerId: number | null = null;
  let previousCursor = '';
  let previousUserSelect = '';

  function inspectorBounds(targetAxis: InspectorAxis): InspectorBounds {
    const total = targetAxis === 'inline' ? bodyInlineSize.value : bodyBlockSize.value;
    const preferredMinimum =
      targetAxis === 'inline' ? PARSER_INSPECTOR_MIN_WIDTH : PARSER_INSPECTOR_MIN_HEIGHT;
    const preferredListMinimum =
      targetAxis === 'inline' ? PARSER_RECORD_LIST_MIN_WIDTH : PARSER_RECORD_LIST_MIN_HEIGHT;
    const fallbackMaximum = targetAxis === 'inline' ? 960 : 720;
    if (total <= 0) return { min: preferredMinimum, max: fallbackMaximum };

    // Under extremely small host windows both panes yield proportionally
    // instead of forcing their preferred minima past the available space.
    const listMinimum = Math.min(preferredListMinimum, Math.floor(total * 0.4));
    const available = Math.max(0, Math.floor(total - listMinimum - PARSER_INSPECTOR_HANDLE_SIZE));
    const minimum = Math.min(preferredMinimum, available);
    const maximum = Math.max(minimum, available);
    return { min: minimum, max: maximum };
  }

  function defaultInspectorSize(targetAxis: InspectorAxis): number {
    const total = targetAxis === 'inline' ? bodyInlineSize.value : bodyBlockSize.value;
    const desired =
      targetAxis === 'inline'
        ? total > 0
          ? Math.min(440, total * 0.42)
          : 440
        : total > 0
          ? total * 0.48
          : 240;
    return clampSize(desired, inspectorBounds(targetAxis));
  }

  function inspectorSize(targetAxis: InspectorAxis): number {
    const stored = targetAxis === 'inline' ? inspectorInlineSize.value : inspectorBlockSize.value;
    return clampSize(stored ?? defaultInspectorSize(targetAxis), inspectorBounds(targetAxis));
  }

  function setInspectorSize(targetAxis: InspectorAxis, value: number): void {
    const normalized = clampSize(value, inspectorBounds(targetAxis));
    if (targetAxis === 'inline') inspectorInlineSize.value = normalized;
    else inspectorBlockSize.value = normalized;
  }

  function resetInspectorSize(): void {
    if (axis.value === 'inline') inspectorInlineSize.value = null;
    else inspectorBlockSize.value = null;
  }

  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || resizing.value) return;
    event.preventDefault();
    dragAxis = axis.value;
    dragStartCoordinate = pointerCoordinate(event, dragAxis);
    dragStartSize = inspectorSize(dragAxis);
    resizing.value = true;
    captureTarget = event.currentTarget as HTMLElement;
    capturePointerId = Number.isInteger(event.pointerId) ? event.pointerId : null;
    if (capturePointerId !== null) captureTarget.setPointerCapture?.(capturePointerId);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', stopResize);
    document.addEventListener('pointercancel', stopResize);
    captureTarget.addEventListener('lostpointercapture', stopResize);
    window.addEventListener('blur', onWindowBlur);
    previousCursor = document.body.style.cursor;
    previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = dragAxis === 'inline' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }

  function onPointerMove(event: PointerEvent): void {
    if (!resizing.value || !matchesActivePointer(event)) return;
    const delta = pointerCoordinate(event, dragAxis) - dragStartCoordinate;
    setInspectorSize(dragAxis, dragStartSize - delta);
  }

  function stopResize(event?: PointerEvent): void {
    if (!resizing.value || (event && !matchesActivePointer(event))) return;
    resizing.value = false;
    const target = captureTarget;
    const pointerId = capturePointerId;
    target?.removeEventListener('lostpointercapture', stopResize);
    captureTarget = null;
    capturePointerId = null;
    if (target && pointerId !== null) {
      try {
        target.releasePointerCapture?.(pointerId);
      } catch {
        // The browser may release capture before pointercancel reaches us.
      }
    }
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', stopResize);
    document.removeEventListener('pointercancel', stopResize);
    window.removeEventListener('blur', onWindowBlur);
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
  }

  function matchesActivePointer(event: PointerEvent): boolean {
    return capturePointerId === null || event.pointerId === capturePointerId;
  }

  function onWindowBlur(): void {
    stopResize();
  }

  function onResizeKeydown(event: KeyboardEvent): void {
    const targetAxis = axis.value;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      resetInspectorSize();
      return;
    }
    const step = event.shiftKey ? PARSER_INSPECTOR_RESIZE_LARGE_STEP : PARSER_INSPECTOR_RESIZE_STEP;
    const current = inspectorSize(targetAxis);
    let next: number;

    if (event.key === 'Home') next = inspectorBounds(targetAxis).min;
    else if (event.key === 'End') next = inspectorBounds(targetAxis).max;
    else if (targetAxis === 'inline' && event.key === 'ArrowLeft') next = current + step;
    else if (targetAxis === 'inline' && event.key === 'ArrowRight') next = current - step;
    else if (targetAxis === 'block' && event.key === 'ArrowUp') next = current + step;
    else if (targetAxis === 'block' && event.key === 'ArrowDown') next = current - step;
    else return;

    event.preventDefault();
    setInspectorSize(targetAxis, next);
  }

  function measureBody(width?: number, height?: number): void {
    const body = parserBodyRef.value;
    const rect = body?.getBoundingClientRect();
    const nextInline = width ?? rect?.width ?? body?.clientWidth ?? 0;
    const nextBlock = height ?? rect?.height ?? body?.clientHeight ?? 0;
    const wasCompact = compact.value;
    if (Number.isFinite(nextInline) && nextInline > 0) bodyInlineSize.value = nextInline;
    if (Number.isFinite(nextBlock) && nextBlock > 0) bodyBlockSize.value = nextBlock;
    if (resizing.value && wasCompact !== compact.value) stopResize();
  }

  function onWindowResize(): void {
    measureBody();
  }

  onMounted(async () => {
    await nextTick();
    measureBody();
    const body = parserBodyRef.value;
    if (body && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(([entry]) => {
        if (!entry) return;
        measureBody(entry.contentRect.width, entry.contentRect.height);
      });
      observer.observe(body);
    }
    window.addEventListener('resize', onWindowResize);
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    window.removeEventListener('resize', onWindowResize);
    stopResize();
  });

  return {
    paneId,
    compact,
    resizing,
    orientation,
    size,
    inlineSize,
    blockSize,
    minSize: computed(() => bounds.value.min),
    maxSize: computed(() => bounds.value.max),
    startResize,
    stopResize,
    onResizeKeydown,
    resetInspectorSize,
  };
}

function clampSize(value: number, bounds: InspectorBounds): number {
  const normalized = Number.isFinite(value) ? value : bounds.min;
  return Math.round(Math.max(bounds.min, Math.min(bounds.max, normalized)));
}

function pointerCoordinate(event: Pick<PointerEvent, 'clientX' | 'clientY'>, axis: InspectorAxis) {
  return axis === 'inline' ? event.clientX : event.clientY;
}
