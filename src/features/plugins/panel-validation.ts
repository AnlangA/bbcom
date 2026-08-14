import type { PluginDeclarativePanel, PluginPanelField } from './types';

const MAX_PANEL_NODES = 256;
const MAX_PANEL_OPTIONS = 64;
const MAX_PANEL_TEXT_BYTES = 64 * 1024;
const MAX_TITLE_BYTES = 128;
const MAX_ID_BYTES = 64;
const MAX_LABEL_BYTES = 256;
const MAX_VALUE_BYTES = 4 * 1024;
const MAX_OPTION_BYTES = 256;

export function validateDeclarativePanel(panel: PluginDeclarativePanel): boolean {
  if (!validIdentity(panel.pluginId) || !safeText(panel.title, MAX_TITLE_BYTES, false))
    return false;
  if (panel.fields.length === 0 || panel.fields.length > MAX_PANEL_NODES) return false;

  const ids = new Set<string>();
  let optionCount = 0;
  let textBytes = utf8Length(panel.title);
  for (const field of panel.fields) {
    if (!validField(field, ids)) return false;
    optionCount += field.options.length;
    if (optionCount > MAX_PANEL_OPTIONS) return false;
    textBytes += utf8Length(field.id) + utf8Length(field.label) + utf8Length(field.value);
    for (const option of field.options) textBytes += utf8Length(option);
    if (textBytes > MAX_PANEL_TEXT_BYTES) return false;
  }
  return true;
}

export function validPanelEventValue(field: PluginPanelField, value: string): boolean {
  if (field.disabled || !safeText(value, MAX_VALUE_BYTES, true)) return false;
  switch (field.kind) {
    case 'text':
      return field.options.length === 0;
    case 'number':
      return field.options.length === 0 && value.trim() !== '' && Number.isFinite(Number(value));
    case 'toggle':
      return field.options.length === 0 && (value === 'true' || value === 'false');
    case 'select':
      return field.options.includes(value);
    case 'button':
      return field.options.length === 0 && value === '';
  }
}

export function safeDisplayText(value: string, maximum: number, allowEmpty = false): boolean {
  if (!safeText(value, maximum, allowEmpty)) return false;
  return !isSystemPath(value);
}

function validField(field: PluginPanelField, ids: Set<string>): boolean {
  if (!validPanelFieldId(field.id) || ids.has(field.id)) return false;
  ids.add(field.id);
  if (!safeText(field.label, MAX_LABEL_BYTES, false)) return false;
  if (!safeText(field.value, MAX_VALUE_BYTES, true)) return false;
  if (field.options.length > MAX_PANEL_OPTIONS) return false;
  const options = new Set<string>();
  for (const option of field.options) {
    if (!safeText(option, MAX_OPTION_BYTES, false) || options.has(option)) return false;
    options.add(option);
  }
  return validControl(field);
}

function validControl(field: PluginPanelField): boolean {
  switch (field.kind) {
    case 'text':
      return field.options.length === 0;
    case 'number':
      return (
        field.options.length === 0 &&
        field.value.trim() !== '' &&
        Number.isFinite(Number(field.value))
      );
    case 'toggle':
      return field.options.length === 0 && (field.value === 'true' || field.value === 'false');
    case 'select':
      return field.options.length > 0 && field.options.includes(field.value);
    case 'button':
      return field.options.length === 0 && field.value === '';
  }
}

function safeText(value: string, maximumBytes: number, allowEmpty: boolean): boolean {
  if ((!allowEmpty && value.length === 0) || utf8Length(value) > maximumBytes) return false;
  const lower = value.toLocaleLowerCase('en-US');
  return !(
    valueHasControlCharacter(value) ||
    value.includes('<') ||
    value.includes('>') ||
    lower.includes('://') ||
    lower.includes('javascript:') ||
    lower.includes('data:') ||
    lower.includes('file:') ||
    lower.includes('mailto:') ||
    lower.includes('tel:') ||
    lower.includes('ftp:') ||
    lower.includes('ws:') ||
    lower.includes('wss:') ||
    lower.includes('urn:') ||
    lower.split(/\s+/u).some((part) => part.startsWith('www.'))
  );
}

function valueHasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function validPanelFieldId(value: string): boolean {
  return value.length <= MAX_ID_BYTES && /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9]))*$/u.test(value);
}

function validIdentity(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isSystemPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/u.test(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
