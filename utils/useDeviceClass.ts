/**
 * useDeviceClass — coarse responsive hook for the chart screen's
 * floating chips and panels.
 *
 * Returns the running device's UI class:
 *   - 'phone'  — < 768 px shortest edge (iPhone-class)
 *   - 'tablet' — ≥ 768 px shortest edge (iPad-class)
 *
 * The shortest-edge check (not just width) handles iPad in landscape
 * AND portrait correctly — both axes are ≥ 768. iPhone landscape
 * stays in 'phone' because its shortest edge (the height) is < 768.
 *
 * Tablet receives:
 *   - Bigger chip text + padding + spacing
 *   - Wider picker sheets (480 px instead of 320)
 *   - More breathing room around the floating UI
 *   - Larger touch targets
 *
 * Phone keeps the current compact layout — the chart already works
 * well there and changing it would be a regression.
 *
 * Updates on resize / orientation change so a user rotating their
 * iPad lands on the correct class without remounting.
 */
import { useEffect, useState } from 'react';

export type DeviceClass = 'phone' | 'tablet';

const TABLET_THRESHOLD_PX = 768;

function detect(): DeviceClass {
    if (typeof window === 'undefined') return 'phone';
    const w = window.innerWidth;
    const h = window.innerHeight;
    const shortEdge = Math.min(w, h);
    return shortEdge >= TABLET_THRESHOLD_PX ? 'tablet' : 'phone';
}

export function useDeviceClass(): DeviceClass {
    const [cls, setCls] = useState<DeviceClass>(() => detect());

    useEffect(() => {
        const onResize = () => {
            const next = detect();
            setCls((prev) => (prev === next ? prev : next));
        };
        window.addEventListener('resize', onResize);
        // Some iOS Capacitor builds fire orientationchange but not resize
        // immediately — listen to both for belt-and-braces.
        window.addEventListener('orientationchange', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
        };
    }, []);

    return cls;
}

/** Tailwind-style merge helper — picks `tablet` when the class is
 *  tablet, otherwise `phone`. Useful for inline className composition. */
export function pickByDevice<T>(cls: DeviceClass, phone: T, tablet: T): T {
    return cls === 'tablet' ? tablet : phone;
}
