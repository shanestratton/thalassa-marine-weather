/**
 * ZoomLevelFab — the top-left zoom pill, SELF-SUBSCRIBED.
 *
 * This used to be MapHub state: map 'zoom' → setZoomLevel per animation
 * frame → the whole ~5,000-line MapHub tree re-rendered EVERY FRAME of a
 * pinch. With a long trace open, each of those renders also paid a grid
 * read per pin and reconciled the full leg-row list — the core of "the
 * page becomes unresponsive the moment I have a lot of waypoints"
 * (Shane 2026-07-15, perf hunt). As its own memo component, a zoom frame
 * re-renders this pill and nothing else.
 *
 * Mapbox zoom is a float 0–22; one decimal so wheel/pinch increments are
 * visible. Throttled to display rate via rAF; zoomend catches coalesced
 * event tails on slow devices.
 */
import React, { useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

interface ZoomLevelFabProps {
    mapRef: React.RefObject<mapboxgl.Map | null>;
    mapReady: boolean;
}

export const ZoomLevelFab: React.FC<ZoomLevelFabProps> = React.memo(({ mapRef, mapReady }) => {
    const [zoomLevel, setZoomLevel] = useState<number | null>(null);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        setZoomLevel(map.getZoom());
        let frameQueued = false;
        const onZoom = () => {
            if (frameQueued) return;
            frameQueued = true;
            requestAnimationFrame(() => {
                frameQueued = false;
                if (mapRef.current) setZoomLevel(mapRef.current.getZoom());
            });
        };
        map.on('zoom', onZoom);
        map.on('zoomend', onZoom);
        return () => {
            map.off('zoom', onZoom);
            map.off('zoomend', onZoom);
        };
    }, [mapRef, mapReady]);

    if (zoomLevel === null) return null;
    return (
        <div
            className="absolute top-[104px] left-4 z-[700] h-11 px-2.5 min-w-[3rem] rounded-full bg-slate-900/85 border border-white/[0.10] flex items-center justify-center backdrop-blur-md shadow-lg pointer-events-none select-none"
            aria-label={`Map zoom level ${zoomLevel.toFixed(1)}`}
            title="Map zoom level"
        >
            <span className="text-[10px] font-bold text-sky-400/70 uppercase tracking-wider mr-1">Z</span>
            <span className="text-sm font-mono font-bold text-white tabular-nums">{zoomLevel.toFixed(1)}</span>
        </div>
    );
});
ZoomLevelFab.displayName = 'ZoomLevelFab';
