/**
 * useMapFitRequest — MapHub's consumer of pending fit-to-bbox requests from
 * the MapFitTargetStore.
 *
 * Extracted verbatim from MapHub.tsx as part of the MapHub decomposition.
 * Closure captures became parameters; no logic changes.
 */
import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { consumeMapFit, peekMapFit, subscribeMapFit } from '../../stores/MapFitTargetStore';
import { claimObsCamera } from './obsCameraClaims';
import { chartFitBearing } from './chartOrientation';

export function useMapFitRequest(mapRef: MutableRefObject<mapboxgl.Map | null>, mapReady: boolean): void {
    // ── Pending fit-to-bbox request ──
    // Used by EncCellManager (and any future "show me on the map"
    // entry point) to fit the viewport to a bbox after navigating
    // to the map. We consume on mount (if a request was staged
    // before navigation) and on subscription bumps (if one comes
    // in while the map is already mounted).
    useEffect(() => {
        if (!mapReady) return;
        const apply = () => {
            const map = mapRef.current;
            if (!map) return;
            const target = consumeMapFit();
            if (!target) return;
            // The skipper asked to see this: Obs's own centring stands down,
            // even when this map is hidden behind the page that asked (build
            // 124 review: after Plan or a location-box pick, Obs's next visit
            // put the chart back on the boat over the ENC cell).
            claimObsCamera(map);
            const [minLon, minLat, maxLon, maxLat] = target.bbox;
            try {
                map.fitBounds(
                    [
                        [minLon, minLat],
                        [maxLon, maxLat],
                    ],
                    {
                        padding: target.paddingPx ?? 60,
                        maxZoom: target.maxZoom ?? 11,
                        duration: 1200,
                        essential: true,
                        retainPadding: false,
                        bearing: chartFitBearing(map),
                    },
                );
            } catch (err) {
                // Mapbox throws on degenerate bboxes (single point).
                // Fall back to a simple flyTo at the centre.
                map.flyTo({
                    center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
                    zoom: target.maxZoom ?? 11,
                    essential: true,
                });
            }
        };
        // Apply any request staged before mount.
        if (peekMapFit()) apply();
        // Apply any future requests dispatched while we're mounted.
        return subscribeMapFit(apply);
    }, [mapReady, mapRef]);
}
