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
import { mountEncVectorLayer, refreshEncVectorData, unmountEncVectorLayer } from './EncVectorLayer';
import { getMergedVectorData, hasAnyCells, subscribe as subscribeToEnc } from '../../services/enc/EncHazardService';

const log = createLogger('useEncVectorLayer');

export function useEncVectorLayer(mapRef: React.MutableRefObject<mapboxgl.Map | null>, mapReady: boolean): void {
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
                    mountedRef.current = true;
                }
            } catch (err) {
                log.warn('failed to mount vector layer', err);
            }
        };

        void apply();

        return () => {
            cancelled = true;
        };
    }, [mapRef, mapReady, bumpCounter]);
}
