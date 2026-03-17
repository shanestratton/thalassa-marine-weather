/**
 * useAisLayer — React hook that renders AIS vessel targets on the Mapbox GL map.
 *
 * Creates a GeoJSON source ('ais-targets') and layers for rendering:
 *   - Circle markers colour-coded by navigational status
 *   - Vessel name labels at zoom ≥ 10
 *   - Heading arrows at zoom ≥ 9
 *
 * Subscribes to AisStore and updates the map at most once per 2 seconds.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { AisStore } from '../../services/AisStore';

const UPDATE_THROTTLE_MS = 2000;

export function useAisLayer(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
): void {
    const lastUpdateRef = useRef(0);
    const pendingUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Subscribe to AisStore and push GeoJSON updates to the map ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        // Ensure source exists (it's created in useMapInit, but guard anyway)
        if (!map.getSource('ais-targets')) return;

        const updateMap = () => {
            const src = map.getSource('ais-targets') as mapboxgl.GeoJSONSource | undefined;
            if (!src) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            src.setData(AisStore.toGeoJSON() as any);
        };

        const throttledUpdate = () => {
            const now = Date.now();
            const elapsed = now - lastUpdateRef.current;

            if (elapsed >= UPDATE_THROTTLE_MS) {
                lastUpdateRef.current = now;
                updateMap();
            } else if (!pendingUpdateRef.current) {
                pendingUpdateRef.current = setTimeout(() => {
                    pendingUpdateRef.current = null;
                    lastUpdateRef.current = Date.now();
                    updateMap();
                }, UPDATE_THROTTLE_MS - elapsed);
            }
        };

        const unsub = AisStore.subscribe(throttledUpdate);

        // Initial sync
        updateMap();

        return () => {
            unsub();
            if (pendingUpdateRef.current) {
                clearTimeout(pendingUpdateRef.current);
                pendingUpdateRef.current = null;
            }
        };
    }, [mapRef, mapReady]);

    // ── Toggle layer visibility ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        const visibility = visible ? 'visible' : 'none';
        const layerIds = [
            'ais-targets-glow',
            'ais-targets-circle',
            'ais-targets-heading',
            'ais-targets-label',
        ];

        for (const id of layerIds) {
            if (map.getLayer(id)) {
                map.setLayoutProperty(id, 'visibility', visibility);
            }
        }
    }, [mapRef, mapReady, visible]);
}
