/**
 * Whether the ship's log is actively recording right now.
 */
import { useEffect, useState } from 'react';

// ── Trip-log state ──
// The hero band's "Underway" pill shouldn't fire just because a
// voyage row is marked status:active in the DB — that label means
// "actively logging right now". Subscribe to ShipLogService for
// live start/stop so a stale active voyage from a deleted route
// can't show "Underway" with the boat sitting at the dock.
export function useTripLogActive(): boolean {
    const [tripLogActive, setTripLogActive] = useState<boolean>(false);

    useEffect(() => {
        let cancelled = false;
        let unsub: (() => void) | null = null;
        (async () => {
            try {
                const { ShipLogService } = await import('../../services/ShipLogService');
                if (cancelled) return;
                unsub = ShipLogService.onTrackingStateChange((tracking, paused) => {
                    if (cancelled) return;
                    setTripLogActive(tracking && !paused);
                });
            } catch {
                /* ShipLogService unavailable — leave inactive */
            }
        })();
        return () => {
            cancelled = true;
            if (unsub) unsub();
        };
    }, []);

    return tripLogActive;
}
