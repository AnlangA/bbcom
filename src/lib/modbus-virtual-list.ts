/** Fixed register-row geometry used by the Modbus editor virtual window. */
export const MODBUS_REGISTER_ROW_HEIGHT = 32;

/** Ten rows on each side absorb normal wheel/trackpad bursts without blanking. */
export const MODBUS_REGISTER_OVERSCAN = 10;

/** Hard DOM ceiling for editor rows, independent of register-table length. */
export const MODBUS_REGISTER_MAX_DOM_ROWS = 40;

/**
 * Bound the virtualizer output before Vue creates row component instances.
 * TanStack orders items from the leading overscan edge, so the retained prefix
 * covers the visible application viewport and its scroll buffer.
 */
export function boundModbusVirtualItems<T>(items: readonly T[]): readonly T[] {
  return items.length <= MODBUS_REGISTER_MAX_DOM_ROWS
    ? items
    : items.slice(0, MODBUS_REGISTER_MAX_DOM_ROWS);
}
