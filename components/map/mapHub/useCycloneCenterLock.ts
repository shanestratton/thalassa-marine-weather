/**
 * Cyclone zoom center-lock — moved out of MapHub.tsx verbatim.
 */
import { useEffect } from 'react';
import mapboxgl from 'mapbox-gl';
import type { ActiveCyclone } from '../../../services/weather/CycloneTrackingService';

export function useCycloneCenterLock(
    mapRef: React.RefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    browseCycloneVisible: boolean,
    closestStorm: ActiveCyclone | null,
): void {
    // ── Cyclone zoom center-lock — keep selected storm dead-center during zoom ──
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !browseCycloneVisible || !closestStorm) return;

        const onZoomEnd = () => {
            const storm = closestStorm;
            if (!storm) return;
            map.easeTo({
                center: [storm.currentPosition.lon, storm.currentPosition.lat],
                duration: 300,
            });
        };
        map.on('zoomend', onZoomEnd);
        return () => {
            map.off('zoomend', onZoomEnd);
        };
    }, [browseCycloneVisible, closestStorm, mapReady, mapRef]);
}
