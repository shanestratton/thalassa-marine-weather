/**
 * useRouteNudge — Long-press-to-drag route modification.
 *
 * Attaches listeners to the route-line-layer so that a long-press
 * on the route creates a draggable via-point marker. On release,
 * dispatches a 'thalassa:route-nudge' event with the new via-point
 * coordinates for recomputation.
 *
 * Architecture:
 *   - Long-press (500ms) on route line → spawns amber drag marker
 *   - Drag marker can be repositioned
 *   - Releasing marker → fires custom event → usePassagePlanner recomputes
 *   - Marker includes a "Cancel" button to remove without recomputing
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import mapboxgl from 'mapbox-gl';
import { triggerHaptic } from '../../utils/system';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('useRouteNudge');

export function useRouteNudge(
    mapRef: MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    showPassage: boolean,
) {
    const nudgeMarkerRef = useRef<mapboxgl.Marker | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !showPassage) {
            // Clean up marker when passage mode is exited
            if (nudgeMarkerRef.current) {
                nudgeMarkerRef.current.remove();
                nudgeMarkerRef.current = null;
            }
            return;
        }

        let longPressTimer: NodeJS.Timeout | null = null;
        let pressLngLat: mapboxgl.LngLat | null = null;

        // --- Long-press on route line ---
        const handleRouteMouseDown = (e: mapboxgl.MapLayerMouseEvent) => {
            pressLngLat = e.lngLat;
            longPressTimer = setTimeout(() => {
                if (!pressLngLat) return;
                triggerHaptic('heavy');
                createNudgeMarker(map, pressLngLat.lat, pressLngLat.lng);
                longPressTimer = null;
            }, 600);
        };

        const cancelRoutePress = () => {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            pressLngLat = null;
        };

        // Touch-specific handlers (for route-line-layer)
        const handleRouteTouchStart = (e: mapboxgl.MapLayerTouchEvent) => {
            if (e.originalEvent.touches.length > 1) return;
            pressLngLat = e.lngLat;
            longPressTimer = setTimeout(() => {
                if (!pressLngLat) return;
                triggerHaptic('heavy');
                createNudgeMarker(map, pressLngLat.lat, pressLngLat.lng);
                longPressTimer = null;
            }, 600);
        };

        // Create the draggable via-point marker
        const createNudgeMarker = (m: mapboxgl.Map, lat: number, lng: number) => {
            // Remove previous nudge marker if any
            if (nudgeMarkerRef.current) {
                nudgeMarkerRef.current.remove();
                nudgeMarkerRef.current = null;
            }

            // Store the original press point for penalty calculation
            const origLat = lat;
            const origLng = lng;

            const el = document.createElement('div');
            el.style.cssText = 'display: flex; flex-direction: column; align-items: center; cursor: grab;';
            el.innerHTML = `
                <div style="
                    width: 28px; height: 28px;
                    background: linear-gradient(135deg, #f59e0b, #ef4444);
                    border: 3px solid #fff;
                    border-radius: 50%;
                    box-shadow: 0 0 16px rgba(245,158,11,0.5), 0 4px 12px rgba(0,0,0,0.3);
                    animation: pinBounce 0.3s ease-out;
                    display: flex; align-items: center; justify-content: center;
                ">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round">
                        <path d="M12 6v12M6 12h12"/>
                    </svg>
                </div>
                <div class="nudge-penalty-tooltip" style="
                    margin-top: 4px; padding: 2px 8px;
                    background: rgba(15,23,42,0.9);
                    border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 8px;
                    font-size: 9px; font-weight: 800;
                    color: #fbbf24;
                    text-transform: uppercase;
                    letter-spacing: 0.1em;
                    white-space: nowrap;
                ">
                    Drag to nudge
                </div>
            `;

            const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: 'center' })
                .setLngLat([lng, lat])
                .addTo(m);

            // ── Live penalty tooltip during drag ──
            // Haversine for quick distance calc (NM)
            const R_NM = 3440.065;
            const toRad = (d: number) => d * Math.PI / 180;
            const haversineNm = (la1: number, lo1: number, la2: number, lo2: number) => {
                const dLat = toRad(la2 - la1), dLon = toRad(lo2 - lo1);
                const a = Math.sin(dLat / 2) ** 2 +
                    Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLon / 2) ** 2;
                return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            };

            const ASSUMED_SPEED_KTS = 6; // Cruiser average for penalty estimate
            const tooltip = el.querySelector('.nudge-penalty-tooltip') as HTMLDivElement;

            marker.on('drag', () => {
                const { lng: newLng, lat: newLat } = marker.getLngLat();
                // Detour = distance from orig → via + via → orig (round-trip offset)
                // vs the original straight line (0 NM since same point)
                // So penalty = 2 × haversine(orig, via) for a symmetric detour estimate
                const detourNM = haversineNm(origLat, origLng, newLat, newLng);
                // More realistic: penalty is the extra NM compared to cutting straight through
                // Since we're inserting a waypoint, the penalty is roughly 2× the perpendicular offset
                const penaltyNM = Math.round(detourNM);
                const penaltyHrs = detourNM / ASSUMED_SPEED_KTS;

                let timeStr: string;
                if (penaltyHrs < 1) {
                    timeStr = `${Math.round(penaltyHrs * 60)}m`;
                } else {
                    const hrs = Math.floor(penaltyHrs);
                    const mins = Math.round((penaltyHrs - hrs) * 60);
                    timeStr = mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
                }

                if (tooltip) {
                    tooltip.textContent = penaltyNM < 1 ? 'Drag to nudge' : `+${penaltyNM}nm / +${timeStr}`;
                }
            });

            // On drag end → fire event for recomputation
            marker.on('dragend', () => {
                const { lng: newLng, lat: newLat } = marker.getLngLat();
                triggerHaptic('medium');
                log.info(`[Nudge] Via-point set: ${newLat.toFixed(4)}, ${newLng.toFixed(4)}`);

                // Dispatch event for usePassagePlanner to handle
                window.dispatchEvent(new CustomEvent('thalassa:route-nudge', {
                    detail: { lat: newLat, lon: newLng },
                }));

                // Remove marker after brief delay (route will recompute)
                setTimeout(() => {
                    marker.remove();
                    nudgeMarkerRef.current = null;
                }, 500);
            });

            nudgeMarkerRef.current = marker;
        };

        // Attach listeners to route layers
        const routeLayers = ['route-line-layer', 'route-glow', 'route-core'];
        for (const layerId of routeLayers) {
            if (map.getLayer(layerId)) {
                map.on('mousedown', layerId, handleRouteMouseDown);
                map.on('mouseup', layerId, cancelRoutePress);
                map.on('mouseleave', layerId, cancelRoutePress);
                map.on('touchstart', layerId, handleRouteTouchStart as any);
                map.on('touchend', layerId, cancelRoutePress as any);
                map.on('touchmove', layerId, cancelRoutePress as any);
            }
        }

        // Change cursor on hover
        const handleRouteEnter = () => { map.getCanvas().style.cursor = 'grab'; };
        const handleRouteLeave = () => { map.getCanvas().style.cursor = ''; };
        if (map.getLayer('route-line-layer')) {
            map.on('mouseenter', 'route-line-layer', handleRouteEnter);
            map.on('mouseleave', 'route-line-layer', handleRouteLeave);
        }

        return () => {
            cancelRoutePress();
            if (nudgeMarkerRef.current) {
                nudgeMarkerRef.current.remove();
                nudgeMarkerRef.current = null;
            }
            for (const layerId of routeLayers) {
                try {
                    map.off('mousedown', layerId, handleRouteMouseDown);
                    map.off('mouseup', layerId, cancelRoutePress);
                    map.off('mouseleave', layerId, cancelRoutePress);
                    map.off('touchstart', layerId, handleRouteTouchStart as any);
                    map.off('touchend', layerId, cancelRoutePress as any);
                    map.off('touchmove', layerId, cancelRoutePress as any);
                } catch (_) { /* layer removed */ }
            }
            try {
                map.off('mouseenter', 'route-line-layer', handleRouteEnter);
                map.off('mouseleave', 'route-line-layer', handleRouteLeave);
            } catch (_) { }
        };
    }, [mapReady, showPassage]);
}
