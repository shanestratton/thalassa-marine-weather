/**
 * Live Guardian armed-state and nearby-vessel count for the Watch Status tile.
 */
import { useEffect, useState } from 'react';
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';

export function useGuardianTileState(): { guardianArmed: boolean; guardianNearby: number } {
    const [guardianArmed, setGuardianArmed] = useState<boolean>(false);
    const [guardianNearby, setGuardianNearby] = useState<number>(0);

    useEffect(() => {
        if (!FEATURE_VISIBILITY.guardian) {
            setGuardianArmed(false);
            setGuardianNearby(0);
            return;
        }
        // Subscribe to Guardian for live armed-state + nearby-count.
        let cancelled = false;
        let unsub: (() => void) | null = null;
        (async () => {
            try {
                const { GuardianService } = await import('../../services/GuardianService');
                unsub = GuardianService.subscribe((state) => {
                    if (cancelled) return;
                    setGuardianArmed(!!state.armed);
                    setGuardianNearby(state.nearbyCount || 0);
                });
            } catch {
                /* Guardian not available */
            }
        })();
        return () => {
            cancelled = true;
            if (unsub) unsub();
        };
    }, []);

    return { guardianArmed, guardianNearby };
}
