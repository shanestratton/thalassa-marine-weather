import { useCallback, useState } from 'react';
import type { MapBaseKind } from './MapBaseSelector';
import { RELIEF_TILE_BASE } from './reliefBase';

/**
 * Relief replaced Satellite as the default on 2026-10-04 (Shane: "the
 * stitching"), once its tiles are served; Relief + Sat (the relief sea with
 * satellite land) has been the default since 2026-10-06 (Shane: "it looks
 * fucken awesome"). A saved pick still wins. With no tile address (the R2 upload
 * not done yet) Relief is a flat blue sea, so such a build opens on imagery
 * (review 2026-10-05): Hybrid since the old Satellite base went (2026-10-09).
 */
export const defaultMapBase = (tileBase: string): MapBaseKind => (tileBase ? 'reliefSat' : 'hybrid');
export const DEFAULT_MAP_BASE = defaultMapBase(RELIEF_TILE_BASE);
const KINDS: readonly unknown[] = ['relief', 'reliefSat', 'ocean', 'hybrid'];

/**
 * The old Satellite base, removed from the picker (Shane 2026-10-09: "remove
 * the old satellite map"), opens on Relief + Sat: still the skipper's own
 * pick, so the planning surface follows it as it followed Satellite.
 * settingsStore's mergeSettings migrates the stored value the same way.
 */
export const migrateObsChartBase = (saved: unknown): unknown => (saved === 'satellite' ? 'reliefSat' : saved);

/**
 * The Obs chart's base. One choice for day and night alike (night recolours
 * the sea instead), kept with the account through settings.obsChartBase. A
 * pick shows at once and wins over a late account sync for this session;
 * an unknown saved value falls back to the default. `explicit` says the skipper
 * has chosen something, which the planning surface needs: it keeps its own
 * Hybrid until then.
 */
export function useMapBase(saved: unknown, save?: (value: MapBaseKind) => void) {
    const [picked, setPicked] = useState<MapBaseKind>();
    const stored = migrateObsChartBase(saved);
    const chosen = picked ?? (KINDS.includes(stored) ? (stored as MapBaseKind) : undefined);
    const setMapBase = useCallback(
        (value: MapBaseKind) => {
            setPicked(value);
            save?.(value);
        },
        [save],
    );

    return { mapBase: chosen ?? DEFAULT_MAP_BASE, setMapBase, explicit: chosen !== undefined };
}
