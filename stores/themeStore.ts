/**
 * Theme Store — Zustand replacement for ThemeContext.
 *
 * Provides environment-aware theme tokens via `useThemeStore()`.
 * Syncs with EnvironmentService state changes.
 */

import { create } from 'zustand';
import { EnvironmentService } from '../services/EnvironmentService';
import { getThemeForEnvironment } from '../theme';
import type { ThemeTokens } from '../theme';
import type { Environment } from '../services/EnvironmentService';

interface ThemeState {
    theme: ThemeTokens;
    environment: Environment;
}

export const useThemeStore = create<ThemeState>()(() => {
    const state = EnvironmentService.getState();
    return {
        theme: getThemeForEnvironment(state.current),
        environment: state.current,
    };
});

// Subscribe to EnvironmentService changes (runs once at module load)
EnvironmentService.onStateChange((state) => {
    useThemeStore.setState({
        theme: getThemeForEnvironment(state.current),
        environment: state.current,
    });
});
