/**
 * useDeviceMode — Detects tablet vs phone layout mode.
 *
 * Returns 'helm' (tablet/iPad, ≥768px) or 'deck' (phone, <768px).
 * Updates on resize. Used by MapHub to toggle split-screen vs action mode.
 */

import { useState, useEffect } from 'react';

export type DeviceMode = 'helm' | 'deck';

const TABLET_BREAKPOINT = 768;

export function useDeviceMode(): DeviceMode {
    const [mode, setMode] = useState<DeviceMode>(
        () => window.innerWidth >= TABLET_BREAKPOINT ? 'helm' : 'deck'
    );

    useEffect(() => {
        const mq = window.matchMedia(`(min-width: ${TABLET_BREAKPOINT}px)`);
        const handler = (e: MediaQueryListEvent) => setMode(e.matches ? 'helm' : 'deck');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    return mode;
}
