/**
 * ThemeContext — Dynamic Theme Provider
 * ─────────────────────────────────────────────────────────────────
 * Provides the active theme tokens based on EnvironmentService state.
 * Components use `useTheme()` to get environment-aware theme tokens.
 *
 * Usage:
 *   import { useTheme } from '../context/ThemeContext';
 *   const t = useTheme();
 *   <div className={t.card.base}>...</div>
 *
 * The returned `t` has the SAME shape as the static `t` from theme.ts,
 * so migration is just changing the import.
 */

import React, { createContext, useContext, useState, useEffect } from 'react';
import { EnvironmentService } from '../services/EnvironmentService';
import { getThemeForEnvironment, offshoreTheme } from '../theme';
import type { ThemeTokens } from '../theme';
import type { Environment } from '../services/EnvironmentService';

// ── Context ─────────────────────────────────────────────────────

const ThemeContext = createContext<ThemeTokens>(offshoreTheme);

// ── Provider ────────────────────────────────────────────────────

interface ThemeProviderProps {
    children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
    const [theme, setTheme] = useState<ThemeTokens>(() => {
        // Initialize from EnvironmentService's restored state
        const state = EnvironmentService.getState();
        return getThemeForEnvironment(state.current);
    });

    const [environment, setEnvironment] = useState<Environment>(() =>
        EnvironmentService.getState().current
    );

    useEffect(() => {
        const unsub = EnvironmentService.onStateChange((state) => {
            setEnvironment(state.current);
            setTheme(getThemeForEnvironment(state.current));
        });
        return unsub;
    }, []);

    return (
        <ThemeContext.Provider value={theme}>
            {/* Root CSS class for CSS-level theming */}
            <div
                className={`theme-${environment} contents`}
                data-theme={environment}
            >
                {children}
            </div>
        </ThemeContext.Provider>
    );
}

// ── Hook ────────────────────────────────────────────────────────

/**
 * Get the current theme tokens (environment-aware).
 * Returns the same shape as the static `t` export from theme.ts.
 */
export function useTheme(): ThemeTokens {
    return useContext(ThemeContext);
}

/**
 * Get the current environment ('onshore' | 'offshore').
 * Convenience hook for components that need to branch on environment.
 */
export function useEnvironment(): Environment {
    const theme = useContext(ThemeContext);
    return theme.environment;
}
