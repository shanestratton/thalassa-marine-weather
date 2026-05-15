import React, { createContext, useContext, useState } from 'react';

/**
 * Viewer-side bandwidth mode for the Voyage Log.
 *
 *   starlink — fast pipe, auto-load every photo (default).
 *   satlink  — preserve data (Iridium GO! and similar). The sidebar
 *              shows placeholders instead of thumbnails, and each photo
 *              in the lightbox is gated behind an explicit "Tap to load."
 *
 * Mode is per-viewer, persisted to localStorage so it sticks across
 * reloads.
 */

export type BandwidthMode = 'starlink' | 'satlink';

const STORAGE_KEY = 'voyage-log-bandwidth-mode';

interface BandwidthCtx {
    mode: BandwidthMode;
    setMode: (m: BandwidthMode) => void;
}

const Ctx = createContext<BandwidthCtx>({ mode: 'starlink', setMode: () => undefined });

export const useBandwidthMode = (): BandwidthCtx => useContext(Ctx);

export const BandwidthModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [mode, setModeState] = useState<BandwidthMode>(() => {
        try {
            if (typeof window === 'undefined') return 'starlink';
            const stored = window.localStorage.getItem(STORAGE_KEY);
            return stored === 'satlink' ? 'satlink' : 'starlink';
        } catch {
            return 'starlink';
        }
    });

    const setMode = (m: BandwidthMode): void => {
        setModeState(m);
        try {
            window.localStorage.setItem(STORAGE_KEY, m);
        } catch {
            /* private mode / quota / SSR — fine, state still updates */
        }
    };

    return <Ctx.Provider value={{ mode, setMode }}>{children}</Ctx.Provider>;
};
