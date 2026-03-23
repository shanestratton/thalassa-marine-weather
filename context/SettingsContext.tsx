/**
 * SettingsContext — Bridge layer (delegates to Zustand settingsStore).
 *
 * Keeps the Provider + useSettings() API so existing consumers work.
 * New code should import from `stores/settingsStore` directly.
 */

import React, { useEffect } from 'react';
import { useSettingsStore, DEFAULT_SETTINGS, setSettingsDebugSink } from '../stores/settingsStore';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';

// Re-export DEFAULT_SETTINGS for consumers that import it from here
export { DEFAULT_SETTINGS };

/** @deprecated Use `useSettingsStore()` directly */
export const useSettings = () => {
    return useSettingsStore();
};

/**
 * SettingsProvider — Wires auth user + debug log sink into the store.
 * Still needed because settingsStore depends on auth user ID for cloud sync.
 */
export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const userId = useAuthStore((s) => s.user?.id ?? null);
    const addDebugLog = useUIStore((s) => s.addDebugLog);

    useEffect(() => {
        useSettingsStore.getState()._setUserId(userId);
    }, [userId]);

    useEffect(() => {
        setSettingsDebugSink(addDebugLog);
    }, [addDebugLog]);

    return React.createElement(React.Fragment, null, children);
};
