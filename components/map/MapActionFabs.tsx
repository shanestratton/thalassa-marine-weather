/**
 * Map Action FABs — extracted from MapHub.
 *
 * GPS locate and weather-location recenter floating action buttons, plus the
 * one-handed zoom pair on the right rail.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { triggerHaptic } from '../../utils/system';
import { chartMapBeside, onChartMapsChanged } from './chartMapRegistry';
import { isOrientationEvent } from './chartOrientation';
import { PHONE_GLYPH_PATHS } from './phoneMarker';

// PARKED (Shane 2026-07-17: "remove that bottom right fab, and replace it
// with the fab which is immediately to the left of it"): the recenter-on-
// weather-location pin rarely earned its corner, and it pushed the far more
// important GPS Locate Me under the detail scrubber. Locate Me now owns the
// bottom-right slot; flip this to bring the pin back (wiring intact).
const RECENTER_FAB_VISIBLE = false;

/**
 * Locate asks the boat or the phone (up to 10 s, the boat's network lookup
 * capped there). No camera flight by then means no fix; a flight that lands
 * later (a permission prompt answered slowly) still clears the notice and is
 * still announced.
 */
const LOCATE_NO_FIX_MS = 11_000;
const LOCATE_NOTICE_MS = 5_000;
const LOCATE_LISTEN_MS = 30_000;
/** How long the label saying where a tap went stays beside the button (126-18). */
const LOCATE_LABEL_MS = 3_000;

/** The map-pin outline (the parked recentre button's): Locate's glyph when the next tap goes to a chosen place. */
const PLACE_GLYPH_PATHS = [
    'M15 10.5a3 3 0 11-6 0 3 3 0 016 0z',
    'M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z',
];

type LocateState = 'idle' | 'finding' | 'no-fix';

/** What a locate did, when the handler can say (find-boat on Obs: obsCentre.locateVessel). */
export interface LocateResult {
    centred: boolean;
    /** Words for the status line; '' when the chart's own message speaks. */
    announcement: string;
    /** Nothing found, and the chart's own message is about something else: say it here, on screen too. */
    noFix?: boolean;
    /**
     * Where the tap went ("Port Kittiwake", "Kittiwake", "Your phone"), when
     * Locate has more than one stop (126-18): shown beside the button for 3 s.
     * The status line already speaks the announcement, so it is not spoken.
     */
    label?: string;
}

interface MapActionFabsProps {
    /**
     * May return a promise of what it did: the button then ends its search on
     * that answer and says those words, instead of waiting out its timer.
     */
    onLocateMe: () => void | Promise<LocateResult | null | void>;
    onRecenter: () => void;
    recenterDisabled: boolean;
    /**
     * Where Locate goes, when the chart knows (Obs follows the location box):
     * 'phone' draws the button as the phone it flies to, the same phone as
     * the chart's own mark, so Current Location is never a guess (Shane
     * 2026-10-08). 'place' (126-18) draws a map pin: the next tap goes to the
     * place chosen in the box, named by `placeName`. Omitted or 'boat': the
     * crosshair, as always.
     */
    target?: 'phone' | 'boat' | 'place';
    /** The chosen place's name, for 'place'. */
    placeName?: string;
}

/** Camera events carry originalEvent only when a person moved the map. */
function isGesture(event: unknown): boolean {
    return !!event && typeof event === 'object' && 'originalEvent' in event && !!event.originalEvent;
}

/** What the button says it goes to, for VoiceOver. */
function targetWords(target: 'phone' | 'boat' | 'place', placeName: string | undefined): string {
    if (target === 'phone') return 'Goes to your phone';
    if (target === 'boat') return 'Goes to the boat';
    return placeName?.trim() ? `Goes to ${placeName.trim()}` : 'Goes to the place you chose';
}

export const MapActionFabs: React.FC<MapActionFabsProps> = ({
    onLocateMe,
    onRecenter,
    recenterDisabled,
    target,
    placeName,
}) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const [locate, setLocate] = useState<LocateState>('idle');
    const targetId = useId();
    const [announcement, setAnnouncement] = useState('');
    /** Where the last tap went, shown for LOCATE_LABEL_MS (126-18). */
    const [stopLabel, setStopLabel] = useState<string | null>(null);
    const stopWatchingLocate = useRef<(() => void) | null>(null);
    /** Ends a "No position fix" line the handler's own answer put up. */
    const noFixTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const labelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [zoomLimits, setZoomLimits] = useState({ atMin: false, atMax: false });

    useEffect(
        () => () => {
            stopWatchingLocate.current?.();
            if (noFixTimer.current) clearTimeout(noFixTimer.current);
            if (labelTimer.current) clearTimeout(labelTimer.current);
        },
        [],
    );

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
        if (noFixTimer.current) clearTimeout(noFixTimer.current);
        noFixTimer.current = null;
        if (labelTimer.current) clearTimeout(labelTimer.current);
        labelTimer.current = null;
        setStopLabel(null);
        const map = chartMapBeside(rootRef.current);
        // Set once the handler has returned a promise: its answer speaks.
        let answerComing = false;
        let watching: (() => void) | null = null;
        if (map) {
            const timers: Array<ReturnType<typeof setTimeout>> = [];
            const stop = () => {
                map.off('movestart', onMoveStart);
                timers.forEach(clearTimeout);
                if (stopWatchingLocate.current === stop) stopWatchingLocate.current = null;
            };
            watching = stop;
            function onMoveStart(event: unknown) {
                // The skipper panning meanwhile is not the answer, nor the
                // chart turning to its orientation mode (127-11a).
                if (isGesture(event) || isOrientationEvent(event) || answerComing) return;
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
        const result = onLocateMe();
        if (result instanceof Promise) {
            answerComing = true;
            result.then(
                (answer) => {
                    // A newer tap owns the button now.
                    if (!answer || (watching && stopWatchingLocate.current !== watching)) return;
                    watching?.();
                    setAnnouncement(answer.announcement);
                    if (!answer.noFix) {
                        setLocate('idle');
                        if (answer.label) {
                            setStopLabel(answer.label);
                            labelTimer.current = setTimeout(() => {
                                labelTimer.current = null;
                                setStopLabel(null);
                            }, LOCATE_LABEL_MS);
                        }
                        return;
                    }
                    setLocate('no-fix');
                    noFixTimer.current = setTimeout(() => {
                        noFixTimer.current = null;
                        setLocate((state) => (state === 'no-fix' ? 'idle' : state));
                    }, LOCATE_NOTICE_MS);
                },
                () => {
                    if (watching && stopWatchingLocate.current === watching) {
                        watching();
                        setLocate('idle');
                    }
                },
            );
        }
    }, [onLocateMe]);

    return (
        <>
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

                {/* Grows leftwards from the right-anchored row: Locate never moves.
                    The search is said on screen too, in the same slot the
                    failure takes (UX scorecard run 8): it was a pulsing ring
                    and a VoiceOver-only status, while the failure got words. */}
                {locate === 'finding' && (
                    <span
                        aria-hidden="true"
                        className="flex h-12 items-center whitespace-nowrap rounded-2xl border border-sky-400/40 bg-slate-900/90 px-3 text-[13px] font-bold text-sky-300 shadow-2xl backdrop-blur-xl"
                    >
                        Finding position…
                    </span>
                )}
                {locate === 'no-fix' && (
                    <span
                        aria-hidden="true"
                        className="flex h-12 items-center whitespace-nowrap rounded-2xl border border-amber-400/40 bg-slate-900/90 px-3 text-[13px] font-bold text-amber-300 shadow-2xl backdrop-blur-xl"
                    >
                        No position fix
                    </span>
                )}
                {/* Where the last tap went, when Locate has more than one stop
                    (126-18): one line, cut short with an ellipsis, never a
                    wrap. The status line speaks the answer itself. */}
                {locate === 'idle' && stopLabel && (
                    <span
                        aria-hidden="true"
                        data-locate-label=""
                        className="block h-12 max-w-[min(14rem,calc(100vw-7rem))] truncate rounded-2xl border border-sky-400/40 bg-slate-900/90 px-3 text-[13px] font-bold leading-[3rem] text-sky-300 shadow-2xl backdrop-blur-xl"
                    >
                        {stopLabel}
                    </span>
                )}

                {/* Where it goes, for VoiceOver: the name stays "Locate me". */}
                {target && (
                    <span id={targetId} className="sr-only">
                        {targetWords(target, placeName)}
                    </span>
                )}

                {/* GPS Locate Me — fly to device position */}
                <button
                    type="button"
                    aria-label="Locate me"
                    aria-describedby={target ? targetId : undefined}
                    data-target={target}
                    aria-busy={locate === 'finding'}
                    onClick={handleLocate}
                    className="relative w-[max(44px,3rem)] h-[max(44px,3rem)] bg-slate-900/90 border border-white/8 rounded-2xl flex items-center justify-center shadow-2xl hover:bg-slate-800/90 transition-all active:scale-95"
                >
                    {/* Acquiring: the tap is answered at once, not after the fix. */}
                    {locate === 'finding' && (
                        <span
                            aria-hidden="true"
                            className="absolute inset-0 rounded-2xl border-2 border-sky-400/80 animate-pulse motion-reduce:animate-none"
                        />
                    )}
                    {/* White like the layers glyph beside it: one glyph colour on the rail. */}
                    {target === 'place' ? (
                        <svg
                            className="w-5 h-5 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            data-glyph="place"
                        >
                            {PLACE_GLYPH_PATHS.map((d) => (
                                <path key={d} d={d} />
                            ))}
                        </svg>
                    ) : target === 'phone' ? (
                        <svg
                            className="w-5 h-5 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            data-glyph="phone"
                        >
                            {PHONE_GLYPH_PATHS.map((d) => (
                                <path key={d} d={d} />
                            ))}
                        </svg>
                    ) : (
                        <svg
                            className="w-5 h-5 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                            data-glyph="crosshair"
                        >
                            <circle cx="12" cy="12" r="3" />
                            <path strokeLinecap="round" d="M12 2v3m0 14v3M2 12h3m14 0h3" />
                        </svg>
                    )}
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
                            {PLACE_GLYPH_PATHS.map((d) => (
                                <path key={d} strokeLinecap="round" strokeLinejoin="round" d={d} />
                            ))}
                        </svg>
                    </button>
                )}
            </div>
            {/* One-handed zoom (UX scorecard run 7): pinching takes two hands,
                and on a moving boat one is holding on. A sibling of the Locate
                row, not a child, so each can be placed on its own.
                Portrait: up the right rail, in thumb reach — its foot at
                242 px + inset, clear of the scale and credits (4rem + 73 px +
                inset, ~74 px tall) and the ENC credit chip (inset + 204 px,
                ~26 px tall). Short landscape (up to 600 px tall, the same line the
                ENC notice uses, so a 1024x520 split pane counts): the
                middle-left rail, where the
                chart's Back chevron sat until Release 118 and which the ENC
                notice still reserves — beside the Locate row it ran into the
                notice, and above it into the scale and credits. */}
            <div
                role="group"
                aria-label="Map zoom"
                className="thalassa-map-zoom absolute right-[max(16px,env(safe-area-inset-right))] bottom-[calc(242px+env(safe-area-inset-bottom))] z-500 flex flex-col overflow-hidden rounded-2xl border border-white/8 bg-slate-900/90 shadow-2xl backdrop-blur-xl [@media(orientation:landscape)_and_(max-height:600px)]:right-auto [@media(orientation:landscape)_and_(max-height:600px)]:bottom-auto [@media(orientation:landscape)_and_(max-height:600px)]:left-[max(16px,env(safe-area-inset-left))] [@media(orientation:landscape)_and_(max-height:600px)]:top-1/2 [@media(orientation:landscape)_and_(max-height:600px)]:-translate-y-1/2"
            >
                <button
                    type="button"
                    aria-label="Zoom in"
                    disabled={zoomLimits.atMax}
                    onClick={(event) => zoom('in', event)}
                    className="flex h-[max(44px,3rem)] w-[max(44px,3rem)] items-center justify-center text-white transition-colors hover:bg-slate-800/90 active:bg-slate-800/90 disabled:opacity-40"
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
                <span aria-hidden="true" className="mx-2 h-px bg-white/10" />
                <button
                    type="button"
                    aria-label="Zoom out"
                    disabled={zoomLimits.atMin}
                    onClick={(event) => zoom('out', event)}
                    className="flex h-[max(44px,3rem)] w-[max(44px,3rem)] items-center justify-center text-white transition-colors hover:bg-slate-800/90 active:bg-slate-800/90 disabled:opacity-40"
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
        </>
    );
};
