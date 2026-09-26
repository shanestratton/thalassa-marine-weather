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
    // "Zoom" in words, stacked over the number so the pill keeps its 48 px
    // footprint beside the offline chip: a lone "Z" only decoded for a
    // developer (UX scorecard run 5). Borderless and unshadowed: it is a
    // readout, and with the buttons' outline it looked tappable (run 6).
    return (
        <div
            className="absolute z-700 h-12 min-w-12 rounded-full bg-slate-900/85 px-2.5 backdrop-blur-md pointer-events-none flex flex-col items-center justify-center gap-0.5 select-none"
            style={{ top: 'calc(env(safe-area-inset-top) + 8px)', left: 'max(16px, env(safe-area-inset-left))' }}
            // role="img" so the name is not dropped (a bare div's aria-label
            // is ignored), and it leads with the visible word (run 6).
            role="img"
            aria-label={`Zoom ${zoomLevel.toFixed(1)}`}
            title="Map zoom level"
        >
            <span className="text-[12px] font-bold leading-none text-sky-400 uppercase tracking-wider">Zoom</span>
            <span className="text-sm font-mono font-bold leading-none text-white tabular-nums">
                {zoomLevel.toFixed(1)}
            </span>
        </div>
    );
});
ZoomLevelFab.displayName = 'ZoomLevelFab';
