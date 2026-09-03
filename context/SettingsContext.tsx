/**
 * SettingsContext — Bridge layer (delegates to Zustand settingsStore).
 *
 * Keeps the Provider + useSettings() API so existing consumers work.
 * New code should import from `stores/settingsStore` directly.
 */

import React, { useEffect } from 'react';
import { useSettingsStore, DEFAULT_SETTINGS, setSettingsDebugSink } from '../stores/settingsStore';
import { useAuthStore } from '../stores/authStore';
import { createLogger } from '../utils/createLogger';

const log = createLogger('SettingsStore');

// The settings store's diagnostics used to land in a write-only uiStore array
// that no screen rendered, waking every whole-store UI subscriber on each
// save. They go to the tagged logger now — same messages, no re-render.
setSettingsDebugSink((msg) => log.info(msg));

// Re-export DEFAULT_SETTINGS for consumers that import it from here
export { DEFAULT_SETTINGS };

/** @deprecated Use `useSettingsStore()` directly */
export const useSettings = () => {
    return useSettingsStore();
};

/**
 * SettingsProvider — Wires the auth user into the store.
 * Still needed because settingsStore depends on auth user ID for cloud sync.
 */
export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const userId = useAuthStore((s) => s.user?.id ?? null);

    useEffect(() => {
        useSettingsStore.getState()._setUserId(userId);
    }, [userId]);

    return React.createElement(React.Fragment, null, children);
};
