import type { GlobalThemeOverrides } from 'naive-ui';

export const darkThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#4caf50',
    primaryColorHover: '#66bb6a',
    primaryColorPressed: '#388e3c',
    primaryColorSuppl: '#4caf50',
    borderRadius: '5px',
    borderRadiusSmall: '3px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontFamilyMono: '"SF Mono", "Menlo", "Consolas", "Courier New", monospace',
    fontSize: '13px',
    fontSizeMini: '11px',
    fontSizeTiny: '11px',
    fontSizeSmall: '12px',
    fontSizeMedium: '13px',
    heightSmall: '28px',
    heightMedium: '32px',
    dividerColor: '#28282c',
    borderColor: '#36363a',
    inputColor: '#161618',
    inputColorDisabled: '#1f1f23',
    actionColor: '#1f1f23',
    modalColor: '#252529',
    cardColor: '#1f1f23',
    tableColor: '#1a1a1d',
    popoverColor: '#2a2a2f',
    bodyColor: '#1a1a1d',
    boxShadow1: '0 1px 3px rgba(0, 0, 0, 0.24)',
    boxShadow2: '0 2px 8px rgba(0, 0, 0, 0.35)',
    boxShadow3: '0 8px 24px rgba(0, 0, 0, 0.45)',
  },
  Button: {
    textColorPrimary: '#fff',
    textColorHoverPrimary: '#fff',
    textColorPressedPrimary: '#fff',
    fontWeight: '600',
  },
  Input: {
    color: '#161618',
    colorFocus: '#161618',
    border: '1px solid #36363a',
    borderHover: '#48484e',
    borderFocus: '#4caf50',
    boxShadowFocus: '0 0 0 2px rgba(76, 175, 80, 0.2)',
  },
  Select: {
    peers: {
      InternalSelection: {
        color: '#161618',
        border: '1px solid #36363a',
        borderHover: '#48484e',
        borderFocus: '#4caf50',
        boxShadowFocus: '0 0 0 2px rgba(76, 175, 80, 0.2)',
      },
    },
  },
  Tag: {
    border: '1px solid #36363a',
    borderRadiusSmall: '3px',
  },
  Modal: {
    color: '#252529',
    borderColor: '#36363a',
  },
  Card: {
    color: '#1f1f23',
    borderRadius: '8px',
  },
  Tabs: {
    tabFontWeightActive: '600',
  },
};
