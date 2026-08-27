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
 *
 * The class ALSO goes on <html>, because this provider's div lives inside
 * #root while every overlay in the app portals to document.body — so ~74
 * portaled surfaces (ConfirmDialog, ModalSheet, every toast and sheet) were
 * rendering with no onshore theming at all. `display-light` already syncs to
 * the document element for exactly this reason (App.tsx); this is the same
 * fix for the environment theme. The inner div keeps its class so nothing
 * scoped to it changes.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const environment = useThemeStore((s) => s.environment);

    React.useEffect(() => {
        const root = document.documentElement;
        const className = `theme-${environment}`;
        root.classList.add(className);
        root.setAttribute('data-theme', environment);
        return () => root.classList.remove(className);
    }, [environment]);

    return React.createElement(
        'div',
        { className: `theme-${environment} contents`, 'data-theme': environment },
        children,
    );
}
