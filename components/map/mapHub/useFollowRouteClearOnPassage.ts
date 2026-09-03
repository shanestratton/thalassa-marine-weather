/**
 * Clear the Follow Route layers on the edge into passage mode — moved out of
 * MapHub.tsx verbatim.
 *
 * `passage.showPassage` arrives as the `showPassage` argument; the previous-
 * value ref lives here with the effect that owns it, exactly as it did in the
 * body.
 */
import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

export function useFollowRouteClearOnPassage(mapRef: React.RefObject<mapboxgl.Map | null>, showPassage: boolean): void {
    // ── Clear Follow Route when passage mode activates ──
    const prevShowPassageRef = useRef(showPassage);
    useEffect(() => {
        if (showPassage && !prevShowPassageRef.current) {
            // The 2026-07-05 owner-ask ("show the route on the clean
            // satellite base, not the busy ENC chart") force-switched to
            // imagery on EVERY passage — the ghost behind "the old sat map
            // keeps coming back" all day (2026-07-11). SUPERSEDED by the
            // purge: the white chart IS the route surface now, on every
            // platform. Satellite remains a manual peek where allowed.
            // Force-remove Follow Route layers — the hook's useEffect cleanup
            // has a timing gap when mapReady transitions while routeCoords changes
            const map = mapRef.current;
            if (map) {
                const FR_LAYERS = [
                    'follow-route-markers-labels',
                    'follow-route-markers-circle',
                    'follow-route-active-line',
                    'follow-route-previous-line',
                ];
                const FR_SOURCES = ['follow-route-active', 'follow-route-previous', 'follow-route-markers'];
                for (const id of FR_LAYERS) {
                    if (map.getLayer(id)) map.removeLayer(id);
                }
                for (const id of FR_SOURCES) {
                    if (map.getSource(id)) map.removeSource(id);
                }
            }
        }
        prevShowPassageRef.current = showPassage;
    }, [showPassage, mapRef]);
}
