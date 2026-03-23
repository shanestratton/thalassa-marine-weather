/**
 * ThemeContext — Bridge layer (delegates to Zustand themeStore).
 *
 * Keeps the Provider + useTheme() API so existing consumers work unchanged.
 * New code should import `useThemeStore` from `stores/themeStore` directly.
 */

import React from 'react';
import { useThemeStore } from '../stores/themeStore';
import type { ThemeTokens } from '../theme';
import type { Environment } from '../services/EnvironmentService';

/** @deprecated Use `useThemeStore(s => s.theme)` instead */
export function useTheme(): ThemeTokens {
    return useThemeStore((s) => s.theme);
}

/** @deprecated Use `useThemeStore(s => s.environment)` instead */
export function useEnvironment(): Environment {
    return useThemeStore((s) => s.environment);
}

/**
 * ThemeProvider — Thin wrapper. Adds the root CSS class for theme-level styling.
 * Still needed for the `theme-${environment}` class on the DOM node.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const environment = useThemeStore((s) => s.environment);

    return React.createElement(
        'div',
        { className: `theme-${environment} contents`, 'data-theme': environment },
        children,
    );
}
