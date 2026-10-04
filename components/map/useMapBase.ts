import { useCallback, useState } from 'react';
import type { MapBaseKind } from './MapBaseSelector';
import { RELIEF_TILE_BASE } from './reliefBase';

/**
 * Relief replaced Satellite as the default on 2026-10-04 (Shane: "the
 * stitching"), once its tiles are served. With no tile address (the R2 upload
 * not done yet) Relief is a flat blue sea, so a build made before then keeps
 * Satellite as its default (review 2026-10-05); Relief stays a pick.
 */
export const defaultMapBase = (tileBase: string): MapBaseKind => (tileBase ? 'relief' : 'satellite');
export const DEFAULT_MAP_BASE = defaultMapBase(RELIEF_TILE_BASE);
const KINDS: readonly unknown[] = ['relief', 'reliefSat', 'ocean', 'satellite', 'hybrid'];

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
    const chosen = picked ?? (KINDS.includes(saved) ? (saved as MapBaseKind) : undefined);
    const setMapBase = useCallback(
        (value: MapBaseKind) => {
            setPicked(value);
            save?.(value);
        },
        [save],
    );

    return { mapBase: chosen ?? DEFAULT_MAP_BASE, setMapBase, explicit: chosen !== undefined };
}
