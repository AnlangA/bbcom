import type { GlobalThemeOverrides } from 'naive-ui';

/** Naive UI consumes the same theme-aware semantic tokens as application CSS. */
export const themeOverrides: GlobalThemeOverrides = {
  common: {
    // Naive UI derives alpha variants from these values in JavaScript, so
    // they must be concrete colors rather than CSS var() expressions.
    primaryColor: '#3ddc97',
    primaryColorHover: '#5ee6aa',
    primaryColorPressed: '#26b879',
    primaryColorSuppl: '#3ddc97',
    infoColor: '#60a5fa',
    successColor: '#3ddc97',
    warningColor: '#ffbf5f',
    errorColor: '#ff6b7a',
    borderRadius: 'var(--radius-md)',
    borderRadiusSmall: 'var(--radius-sm)',
    fontFamily: 'var(--font-family)',
    fontFamilyMono: 'var(--font-mono)',
    fontSize: 'var(--font-size-base)',
    fontSizeMini: 'var(--font-size-sm)',
    fontSizeTiny: 'var(--font-size-sm)',
    fontSizeSmall: 'var(--font-size-data)',
    fontSizeMedium: 'var(--font-size-base)',
    heightTiny: '28px',
    heightSmall: '30px',
    heightMedium: '34px',
    dividerColor: 'var(--border-subtle)',
    borderColor: 'var(--border-color)',
    inputColor: 'var(--bg-inset)',
    inputColorDisabled: 'var(--bg-secondary)',
    actionColor: 'var(--bg-tertiary)',
    modalColor: 'var(--bg-secondary)',
    cardColor: 'var(--bg-secondary)',
    tableColor: 'var(--bg-primary)',
    popoverColor: 'var(--bg-elevated)',
    bodyColor: 'var(--bg-app)',
    textColorBase: 'var(--text-primary)',
    textColor1: 'var(--text-primary)',
    textColor2: 'var(--text-secondary)',
    textColor3: 'var(--text-muted)',
    placeholderColor: 'var(--text-dim)',
  },
  Button: {
    textColorPrimary: 'var(--text-inverse)',
    textColorHoverPrimary: 'var(--text-inverse)',
    textColorPressedPrimary: 'var(--text-inverse)',
    textColorFocusPrimary: 'var(--text-inverse)',
    color: 'var(--bg-elevated)',
    colorHover: 'var(--bg-tertiary)',
    colorPressed: 'var(--bg-secondary)',
    colorFocus: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderHover: '1px solid var(--border-strong)',
    borderPressed: '1px solid var(--border-strong)',
    borderFocus: '1px solid var(--border-focus)',
    borderPrimary: '1px solid var(--color-primary)',
    borderHoverPrimary: '1px solid var(--color-primary-hover)',
    borderPressedPrimary: '1px solid var(--color-primary-pressed)',
    // Secondary/dashed/ghost buttons run these through changeColor() to derive
    // alpha variants, so var() strings would throw in seemly's rgba parser.
    // The primary palette is theme-invariant (light only overrides surfaces),
    // so these literals mirror variables.css for both palettes.
    colorPrimary: '#3ddc97',
    colorHoverPrimary: '#5ee6aa',
    colorPressedPrimary: '#26b879',
    colorFocusPrimary: '#5ee6aa',
  },
  Input: {
    color: 'var(--bg-inset)',
    colorFocus: 'var(--bg-inset)',
    colorDisabled: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderHover: '1px solid var(--border-strong)',
    borderFocus: '1px solid var(--border-focus)',
    boxShadowFocus: 'var(--shadow-focus)',
    placeholderColor: 'var(--text-dim)',
  },
  InputNumber: {
    peers: {
      Input: {
        color: 'var(--bg-inset)',
        colorFocus: 'var(--bg-inset)',
        border: '1px solid var(--border-color)',
        borderHover: '1px solid var(--border-strong)',
        borderFocus: '1px solid var(--border-focus)',
        boxShadowFocus: 'var(--shadow-focus)',
      },
    },
  },
  Select: {
    peers: {
      InternalSelection: {
        color: 'var(--bg-inset)',
        colorActive: 'var(--bg-inset)',
        border: '1px solid var(--border-color)',
        borderHover: '1px solid var(--border-strong)',
        borderFocus: '1px solid var(--border-focus)',
        boxShadowFocus: 'var(--shadow-focus)',
        placeholderColor: 'var(--text-dim)',
      },
      InternalSelectMenu: {
        color: 'var(--bg-elevated)',
        optionColorPending: 'var(--bg-hover)',
        optionColorActive: 'var(--bg-active)',
        optionTextColorActive: 'var(--text-primary)',
        borderRadius: 'var(--radius-md)',
      },
    },
  },
  Tag: {
    border: '1px solid var(--border-color)',
    borderRadiusSmall: 'var(--radius-full)',
  },
  Modal: {
    color: 'var(--bg-secondary)',
    borderColor: 'var(--border-color)',
    boxShadow: 'var(--shadow-lg)',
  },
  Dropdown: {
    color: 'var(--bg-elevated)',
    optionColorHover: 'var(--bg-hover)',
    optionColorActive: 'var(--bg-active)',
  },
  Tabs: {
    tabTextColorLine: 'var(--text-muted)',
    tabTextColorHoverLine: 'var(--text-primary)',
    tabTextColorActiveLine: 'var(--text-primary)',
    tabTextColorDisabledLine: 'var(--text-dim)',
    barColor: 'var(--color-primary)',
  },
  // Without darkTheme in the bundle (App.vue bundle-budget trade-off), any
  // component not listed here derives its palette from Naive's light base in
  // JavaScript — visible as washed-out rails/bubbles in dark mode. These
  // overrides pin the remaining in-use components to semantic tokens, which
  // re-resolve per data-theme for both palettes.
  Switch: {
    railColor: 'var(--bg-active)',
    railColorHover: 'var(--bg-hover)',
    railColorActive: 'var(--color-primary)',
    railColorActiveHover: 'var(--color-primary-hover)',
    railColorActivePressed: 'var(--color-primary-pressed)',
    loadingColor: 'var(--color-primary)',
  },
  Tooltip: {
    color: 'var(--bg-elevated)',
    textColor: 'var(--text-primary)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-lg)',
  },
  Progress: {
    fillColor: 'var(--color-primary)',
    railColor: 'var(--bg-inset)',
  },
};

// API alias retained while both window roots select overrides by theme.
export const lightThemeOverrides = themeOverrides;
