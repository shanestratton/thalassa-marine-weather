/**
 * useGpsHealth — is the GPS actually able to produce a fix, and if not, why?
 *
 * Exists because a permission denial and a cold start looked IDENTICAL to the
 * skipper: both were an amber spinner saying "Acquiring GPS fix…". Shane sat in
 * front of one for hours. The OS knew the answer the whole time; nothing asked.
 *
 * Reads once on mount and then follows the OS live, so revoking permission or
 * switching Location Services off mid-passage changes what the app says instead
 * of leaving it spinning.
 */
import { useEffect, useState } from 'react';
import type { GpsHealth } from '../services/BgGeoManager';

/** Copy for each cause, written for someone at a helm, not a console. */
export function gpsHealthMessage(reason: GpsHealth['reason']): { title: string; detail: string } | null {
    switch (reason) {
        case 'denied':
            return {
                title: 'Location access is off',
                detail: 'Thalassa can’t see your position until you allow location access. Nothing is being recorded.',
            };
        case 'not-determined':
            return {
                title: 'Location access not granted yet',
                detail: 'Thalassa needs permission to use your position. Nothing is being recorded.',
            };
        case 'services-off':
            return {
                title: 'Location Services are switched off',
                detail: 'Turn Location Services back on for this device. Nothing is being recorded.',
            };
        case 'no-gps':
            return {
                title: 'No GPS available',
                detail: 'This device reports no GPS provider. An external receiver may need reconnecting.',
            };
        default:
            return null; // 'ok' and 'unknown' are not worth interrupting for
    }
}

/** Open the OS settings page for this app (iOS honours `app-settings:`). */
export function openDeviceSettings(): void {
    try {
        window.location.href = 'app-settings:';
    } catch {
        /* not a native host — the message alone still tells the skipper what to do */
    }
}

export function useGpsHealth(): GpsHealth | null {
    const [health, setHealth] = useState<GpsHealth | null>(null);

    useEffect(() => {
        let cancelled = false;
        let unsubscribe: (() => void) | null = null;

        void (async () => {
            const { BgGeoManager } = await import('../services/BgGeoManager');
            if (cancelled) return;
            // Paint whatever is already known before awaiting the OS, so the
            // cause appears immediately on a remount rather than flashing an
            // uninformed spinner first.
            const known = BgGeoManager.getLastGpsHealth();
            if (known) setHealth(known);

            unsubscribe = BgGeoManager.subscribeGpsHealth((h) => {
                if (!cancelled) setHealth(h);
            });

            const fresh = await BgGeoManager.getGpsHealth();
            if (!cancelled) setHealth(fresh);
        })();

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, []);

    return health;
}
