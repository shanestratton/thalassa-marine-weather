/**
 * useEncVectorLayer — React lifecycle wrapper around
 * EncVectorLayer.
 *
 * Auto-loads + mounts the user's imported S-57 cells as a real
 * vector chart overlay (depth-graduated water, tan land, white
 * coastline, magenta hazard symbols) whenever ANY cell is imported.
 *
 * Phase 8 v1: simple "all cells, all layers, all the time, zoom-
 * gated". Sufficient for the typical 1-10 cell user. Phase 9 can
 * add viewport-filtered loading for fleet users.
 *
 * Reactivity:
 *   - Mounts once when map ready and cells exist.
 *   - Subscribes to EncHazardService cell-list changes; on bump
 *     reloads merged data + setData on the existing sources
 *     (cheaper than tearing down layers).
 *   - Unmounts when the last cell is removed.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

import { createLogger } from '../../utils/createLogger';
import {
    attachEncFeatureClickHandlers,
    detachEncFeatureClickHandlers,
    mountEncVectorLayer,
    refreshEncVectorData,
    setEncChartDetail,
    setEncVectorVisibility,
    unmountEncVectorLayer,
} from './EncVectorLayer';
import { getMergedVectorData, hasAnyCells, subscribe as subscribeToEnc } from '../../services/enc/EncHazardService';

const log = createLogger('useEncVectorLayer');

export function useEncVectorLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    /**
     * Whether the user has toggled ENC vector display on in the layer FAB.
     * Defaults to `true` for backwards compat — older callers without a toggle
     * get the previous always-on behaviour.
     */
    visible: boolean = true,
    /**
     * Whether to show full chart detail (depth fills + coastlines) or just
     * land + markers. Defaults to `false` — clean view per user preference.
     */
    chartDetail: boolean = false,
): void {
    const mountedRef = useRef(false);
    const [bumpCounter, setBumpCounter] = useState(0);

    useEffect(() => {
        const unsub = subscribeToEnc(() => setBumpCounter((c) => c + 1));
        return unsub;
    }, []);

    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;

        let cancelled = false;

        const apply = async () => {
            if (!hasAnyCells()) {
                if (mountedRef.current) {
                    detachEncFeatureClickHandlers(map);
                    unmountEncVectorLayer(map);
                    mountedRef.current = false;
                }
                return;
            }

            try {
                const data = await getMergedVectorData();
                if (cancelled || !data) return;
                if (mountedRef.current) {
                    refreshEncVectorData(map, data);
                } else {
                    mountEncVectorLayer(map, data);
                    // Click handlers reference the layer IDs that
                    // mount() just registered. Attach is idempotent
                    // so repeat-mounts on cell-list bumps don't pile
                    // up listeners.
                    attachEncFeatureClickHandlers(map);
                    mountedRef.current = true;
                }
                // Always-on by default — explicit toggle from the FAB flips it.
                setEncVectorVisibility(map, visible);
                // Detail mode independently controls the busy fills + coastlines.
                // Apply AFTER visibility so the detail-hide stays effective.
                setEncChartDetail(map, chartDetail);
            } catch (err) {
                log.warn('failed to mount vector layer', err);
            }
        };

        void apply();

        return () => {
            cancelled = true;
        };
    }, [mapRef, mapReady, bumpCounter, visible, chartDetail]);
}
