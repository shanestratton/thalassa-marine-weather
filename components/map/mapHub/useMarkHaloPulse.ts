/**
 * The amber mark halo — a temporary pulsing ring on a chart mark.
 *
 * Moved out of MapHub.tsx verbatim during the MapHub break-up: it closes over
 * nothing but the map handle and its own marker ref, so it is a self-contained
 * pair (one ref, one callback) and the hook keeps that internal order.
 */
import { useCallback, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

export function useMarkHaloPulse(
    mapRef: React.RefObject<mapboxgl.Map | null>,
): (p: { lat: number; lon: number }) => void {
    /** Pulse a temporary amber halo on a chart mark — the answer to "WHICH
     *  marker am I too close to?" (Shane 2026-07-11). Tapping a mark caution
     *  flies there and rings the mark itself; WebAnimations, self-removing,
     *  one halo at a time. */
    const markHaloRef = useRef<mapboxgl.Marker | null>(null);
    const pulseMarkHalo = useCallback(
        (p: { lat: number; lon: number }) => {
            const map = mapRef.current;
            if (!map) return;
            markHaloRef.current?.remove();
            const el = document.createElement('div');
            el.style.cssText =
                'width:44px;height:44px;border-radius:50%;border:3px solid #fbbf24;box-shadow:0 0 14px rgba(251,191,36,0.9);pointer-events:none;';
            el.animate(
                [
                    { transform: 'scale(0.5)', opacity: 1 },
                    { transform: 'scale(1.6)', opacity: 0 },
                ],
                { duration: 1100, iterations: 5, easing: 'ease-out' },
            );
            const marker = new mapboxgl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
            markHaloRef.current = marker;
            window.setTimeout(() => {
                marker.remove();
                if (markHaloRef.current === marker) markHaloRef.current = null;
            }, 5600);
        },
        [mapRef],
    );
    return pulseMarkHalo;
}
