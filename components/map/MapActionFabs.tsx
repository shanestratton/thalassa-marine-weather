/**
 * Map Action FABs — extracted from MapHub.
 *
 * GPS locate and weather-location recenter floating action buttons, plus the
 * one-handed zoom pair on the right rail.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { triggerHaptic } from '../../utils/system';
import { chartMapBeside, onChartMapsChanged } from './chartMapRegistry';

// PARKED (Shane 2026-07-17: "remove that bottom right fab, and replace it
// with the fab which is immediately to the left of it"): the recenter-on-
// weather-location pin rarely earned its corner, and it pushed the far more
// important GPS Locate Me under the detail scrubber. Locate Me now owns the
// bottom-right slot; flip this to bring the pin back (wiring intact).
const RECENTER_FAB_VISIBLE = false;

/**
 * Locate asks the boat first, then the phone (up to 10 s). No camera flight by
 * then means no fix; a flight that lands later (a permission prompt answered
 * slowly) still clears the notice and is still announced.
 */
const LOCATE_NO_FIX_MS = 11_000;
const LOCATE_NOTICE_MS = 5_000;
const LOCATE_LISTEN_MS = 30_000;

type LocateState = 'idle' | 'finding' | 'no-fix';

interface MapActionFabsProps {
    onLocateMe: () => void;
    onRecenter: () => void;
    recenterDisabled: boolean;
}

/** Camera events carry originalEvent only when a person moved the map. */
function isGesture(event: unknown): boolean {
    return !!event && typeof event === 'object' && 'originalEvent' in event && !!event.originalEvent;
}

export const MapActionFabs: React.FC<MapActionFabsProps> = ({ onLocateMe, onRecenter, recenterDisabled }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const [locate, setLocate] = useState<LocateState>('idle');
    const [announcement, setAnnouncement] = useState('');
    const stopWatchingLocate = useRef<(() => void) | null>(null);
    const [zoomLimits, setZoomLimits] = useState({ atMin: false, atMax: false });

    useEffect(() => () => stopWatchingLocate.current?.(), []);

    // Grey out a zoom button at the map's limit. The map is found through the
    // registry, and may only exist after this control mounts.
    useEffect(() => {
        let map: mapboxgl.Map | null = null;
        const read = () => {
            if (!map) return;
            const zoom = map.getZoom();
            const atMin = zoom <= map.getMinZoom() + 0.01;
            const atMax = zoom >= map.getMaxZoom() - 0.01;
            setZoomLimits((prev) => (prev.atMin === atMin && prev.atMax === atMax ? prev : { atMin, atMax }));
        };
        const attach = () => {
            const next = chartMapBeside(rootRef.current);
            if (next === map) return;
            map?.off('zoomend', read);
            map = next;
            map?.on('zoomend', read);
            read();
        };
        attach();
        const unsubscribe = onChartMapsChanged(attach);
        return () => {
            unsubscribe();
            map?.off('zoomend', read);
        };
    }, []);

    const zoom = useCallback((direction: 'in' | 'out', event: React.MouseEvent<HTMLButtonElement>) => {
        const map = chartMapBeside(rootRef.current);
        if (!map) return;
        triggerHaptic('light');
        // Passed as the skipper's own move, so a late startup fix or the route
        // framing does not take the camera back.
        const eventData = { originalEvent: event.nativeEvent };
        if (direction === 'in') map.zoomIn({ duration: 250 }, eventData);
        else map.zoomOut({ duration: 250 }, eventData);
    }, []);

    const handleLocate = useCallback(() => {
        stopWatchingLocate.current?.();
        stopWatchingLocate.current = null;
        const map = chartMapBeside(rootRef.current);
        if (map) {
            const timers: Array<ReturnType<typeof setTimeout>> = [];
            const stop = () => {
                map.off('movestart', onMoveStart);
                timers.forEach(clearTimeout);
                if (stopWatchingLocate.current === stop) stopWatchingLocate.current = null;
            };
            function onMoveStart(event: unknown) {
                // The skipper panning meanwhile is not the answer.
                if (isGesture(event)) return;
                stop();
                setLocate('idle');
                setAnnouncement('Chart centred on your position.');
            }
            // Listening BEFORE the call: a live boat fix flies synchronously.
            map.on('movestart', onMoveStart);
            timers.push(
                setTimeout(() => {
                    setLocate('no-fix');
                    setAnnouncement('No position fix. The chart has not moved.');
                }, LOCATE_NO_FIX_MS),
                setTimeout(
                    () => setLocate((state) => (state === 'no-fix' ? 'idle' : state)),
                    LOCATE_NO_FIX_MS + LOCATE_NOTICE_MS,
                ),
                setTimeout(stop, LOCATE_LISTEN_MS),
            );
            stopWatchingLocate.current = stop;
            setLocate('finding');
            setAnnouncement('Finding your position…');
        }
        onLocateMe();
    }, [onLocateMe]);

    return (
        <div
            ref={rootRef}
            // 16px aligns with the right-rail FAB column and the
            // ConnectivityChip so every right-edge element on the chart screen
            // sits on the same vertical gridline. max() with the inset keeps it
            // clear of a landscape notch (~59 pt), where a flat 16px landed the
            // button inside the sensor housing (UX scorecard run 5).
            className="thalassa-map-action-fabs absolute z-500 flex flex-row items-center gap-2"
            style={{
                right: 'max(16px, env(safe-area-inset-right))',
                bottom: 'calc(80px + env(safe-area-inset-bottom))',
            }}
        >
            {/* Locate's outcome, for VoiceOver (UX scorecard run 7). */}
            <span role="status" aria-live="polite" className="sr-only">
                {announcement}
            </span>

            {/* Grows leftwards from the right-anchored row: Locate never moves. */}
            {locate === 'no-fix' && (
                <span
                    aria-hidden="true"
                    className="flex h-12 items-center whitespace-nowrap rounded-2xl border border-amber-400/40 bg-slate-900/90 px-3 text-[13px] font-bold text-amber-300 shadow-2xl backdrop-blur-xl"
                >
                    No position fix
                </span>
            )}

            {/* One-handed zoom (UX scorecard run 7): pinching takes two hands,
                and on a moving boat one is holding on. Portrait: up the right
                rail, in thumb reach — 162 px above this row puts its foot at
                242 px + inset, clear of the scale and credits (4rem + 73 px +
                inset, ~74 px tall) and the ENC credit chip (inset + 204 px,
                ~26 px tall). Short landscape has no rail to spare, so it joins
                this row beside Locate. */}
            <div
                role="group"
                aria-label="Map zoom"
                className="absolute bottom-[162px] right-0 flex flex-col overflow-hidden rounded-2xl border border-white/8 bg-slate-900/90 shadow-2xl backdrop-blur-xl [@media(orientation:landscape)_and_(max-height:500px)]:static [@media(orientation:landscape)_and_(max-height:500px)]:flex-row"
            >
                <button
                    type="button"
                    aria-label="Zoom in"
                    disabled={zoomLimits.atMax}
                    onClick={(event) => zoom('in', event)}
                    className="flex h-12 w-12 items-center justify-center text-white transition-colors hover:bg-slate-800/90 active:bg-slate-800/90 disabled:opacity-40"
                >
                    <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                    </svg>
                </button>
                <span
                    aria-hidden="true"
                    className="mx-2 h-px bg-white/10 [@media(orientation:landscape)_and_(max-height:500px)]:mx-0 [@media(orientation:landscape)_and_(max-height:500px)]:my-2 [@media(orientation:landscape)_and_(max-height:500px)]:h-auto [@media(orientation:landscape)_and_(max-height:500px)]:w-px"
                />
                <button
                    type="button"
                    aria-label="Zoom out"
                    disabled={zoomLimits.atMin}
                    onClick={(event) => zoom('out', event)}
                    className="flex h-12 w-12 items-center justify-center text-white transition-colors hover:bg-slate-800/90 active:bg-slate-800/90 disabled:opacity-40"
                >
                    <svg
                        className="h-5 w-5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                        aria-hidden="true"
                    >
                        <path strokeLinecap="round" d="M5 12h14" />
                    </svg>
                </button>
            </div>

            {/* GPS Locate Me — fly to device position */}
            <button
                type="button"
                aria-label="Locate me"
                aria-busy={locate === 'finding'}
                onClick={handleLocate}
                className="relative w-12 h-12 bg-slate-900/90 border border-white/8 rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
            >
                {/* Acquiring: the tap is answered at once, not after the fix. */}
                {locate === 'finding' && (
                    <span
                        aria-hidden="true"
                        className="absolute inset-0 rounded-2xl border-2 border-sky-400/80 animate-pulse motion-reduce:animate-none"
                    />
                )}
                {/* White like the layers glyph beside it: one glyph colour on the rail. */}
                <svg
                    className="w-5 h-5 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                >
                    <circle cx="12" cy="12" r="3" />
                    <path strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                </svg>
            </button>

            {/* Recenter on weather location — parked, see RECENTER_FAB_VISIBLE */}
            {RECENTER_FAB_VISIBLE && (
                <button
                    aria-label="Recenter on weather location"
                    onClick={onRecenter}
                    disabled={recenterDisabled}
                    className="w-12 h-12 bg-slate-900/90 border border-white/8 rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                >
                    <svg
                        className="w-5 h-5 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
                        />
                    </svg>
                </button>
            )}
        </div>
    );
};
