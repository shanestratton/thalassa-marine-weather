/**
 * useEncCoverageLayer — React lifecycle wrapper around
 * EncCoverageLayer.
 *
 * Auto-shows the ENC coverage overlay whenever the user has any
 * imported cells. No toggle in v1: coverage feedback is one of
 * the highest-value bits of feedback the app can give while
 * route-planning, and the visual is subtle (low fill, dashed
 * outline) so it doesn't compete with weather layers.
 *
 * Reactivity: subscribes to EncHazardService.subscribe() so newly
 * imported cells appear on the map immediately (no need for a
 * map remount or page navigation).
 */

import { useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

import { mountEncCoverageLayer, unmountEncCoverageLayer } from './EncCoverageLayer';
import { hasAnyCells, subscribe as subscribeToEnc } from '../../services/enc/EncHazardService';

export function useEncCoverageLayer(mapRef: React.MutableRefObject<mapboxgl.Map | null>, mapReady: boolean): void {
    // We track a counter that bumps on every cell list change. Used
    // as an effect dependency so the overlay rebuilds when the user
    // imports/removes a cell.
    const [bumpCounter, setBumpCounter] = useState(0);

    useEffect(() => {
        const unsub = subscribeToEnc(() => setBumpCounter((c) => c + 1));
        return unsub;
    }, []);

    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;

        if (hasAnyCells()) {
            mountEncCoverageLayer(map);
        } else {
            unmountEncCoverageLayer(map);
        }

        return () => {
            // Don't tear down on every re-render; only if the map itself
            // unmounts, which is handled by the parent route. The next
            // mountEncCoverageLayer call is idempotent.
        };
    }, [mapRef, mapReady, bumpCounter]);
}
