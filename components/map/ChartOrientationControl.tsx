/**
 * The chart's orientation control (127-11b): the north arrow on Obs and its
 * chooser card; the planner's compass rose opens the same card.
 *
 * Shane 2026-10-10: "oh, um add in the course up and north up etc. that is
 * cool to see as well". The arrow sits with the zoom pair (MapActionFabs) and
 * inherits its placement. Its red needle points at true north on screen,
 * repainted through one animation frame on each 'rotate' (the ZoomLevelFab
 * pattern: per-frame work never re-renders MapHub). One tap on a turned chart
 * puts it North up at once; one tap North up opens "Chart orientation", a
 * centred card in the overlay modal band (z 1100, over MOB inside the
 * isolated chart), clear of the tab bar, each row saying what it uses and
 * whether it is ready now.
 *
 * At-hand chart control, not a Preferences row: changed with what she is doing
 * (a channel, a long beat, a night watch), like the base picker beside it.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type mapboxgl from 'mapbox-gl';
import { ModalSheet } from '../ui/ModalSheet';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { usePassageHudPreviewRoute } from '../../stores/passageHudStore';
import type { RoutePoint } from '../../services/routeProgress';
import { chartMapBeside, onChartMapsChanged } from './chartMapRegistry';
import {
    chartBearing,
    chartOrientationView,
    orientChart,
    pickChartMode,
    subscribeChartOrientation,
    type ChartMode,
    type ChartOrientationView,
    type ChartSurface,
    type OrientReason,
} from './chartOrientation';

export const MODE_WORDS: Record<ChartMode, string> = {
    north: 'North up',
    course: 'Course up',
    track: 'Track up',
    heading: 'Heading up',
};
export const REASON_WORDS: Record<OrientReason, string> = {
    noroute: 'Needs a route on the chart and her position',
    slow: 'Waits until she is making 1.5 kn',
    noheading: 'Needs a true heading from her compass',
    twocompass: 'Her compass is jumping between two headings',
    nolegs: 'Needs two pins on the chart',
};
const READY: Record<ChartMode, string> = {
    north: 'North at the top, like a paper chart',
    course: 'The route ahead at the top',
    track: 'Her course over the ground at the top',
    heading: 'Her bow at the top, from her compass',
};
/** A bearing in three figures: 047. */
export const threeFigures = (bearing: number): string =>
    String(Math.round(((bearing % 360) + 360) % 360) % 360).padStart(3, '0');

/**
 * Run the surface's controller while `active` (Obs on screen, or the planner
 * tracing), and read what it shows. Obs's Course up follows the route on the
 * chart: a previewed one, else the one she follows; the planner's, its leg.
 */
export function useChartOrientation(
    map: mapboxgl.Map | null,
    surface: ChartSurface,
    active: boolean,
    leg?: number | null,
    pivot?: RoutePoint | null,
): ChartOrientationView {
    const preview = usePassageHudPreviewRoute();
    const followed = useFollowRouteStore((s) => (s.isFollowing ? s.routeCoords : null));
    const route = surface === 'obs' ? (preview?.points ?? followed) : null;
    const inputs = useRef({ route, leg, pivot });
    inputs.current = { route, leg, pivot };
    const controller = useRef<ReturnType<typeof orientChart> | null>(null);
    useEffect(() => {
        if (!map || !active) return;
        const running = orientChart(map, surface, () => inputs.current);
        controller.current = running;
        return () => {
            controller.current = null;
            running.stop();
        };
    }, [map, active, surface]);
    useEffect(() => controller.current?.refresh(), [route, leg]);
    return useSyncExternalStore(subscribeChartOrientation, chartOrientationView, chartOrientationView);
}

/** "Chart orientation": the modes the surface offers, each saying what it uses and whether it is ready now. */
export const ChartOrientationChooser: React.FC<{ open: boolean; onClose: () => void; view: ChartOrientationView }> = ({
    open,
    onClose,
    view,
}) => {
    const plan = view.surface === 'plan';
    return (
        <ModalSheet isOpen={open} onClose={onClose} title="Chart orientation" maxWidth="max-w-sm" zIndex="z-1100">
            <div
                role="radiogroup"
                aria-label="Chart orientation"
                className="thalassa-orient-rows"
                // Arrow keys move between the rows; Escape is the sheet's.
                onKeyDown={(event) => {
                    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
                    if (!step) return;
                    event.preventDefault();
                    const rows = [...event.currentTarget.querySelectorAll('button')];
                    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
                    rows[(at + step + rows.length) % rows.length].focus();
                }}
            >
                {(['north', 'course', 'track', 'heading'] as const).slice(0, plan ? 2 : 4).map((mode) => {
                    const status = mode === 'north' ? null : view.modes[mode];
                    return (
                        <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={view.mode === mode}
                            onClick={() => {
                                pickChartMode(mode);
                                onClose();
                            }}
                            className={`thalassa-orient-row border text-slate-300 ${view.mode === mode ? 'border-sky-400/70 bg-sky-500/15' : 'border-white/10 bg-white/5'}`}
                        >
                            <span className="text-white">
                                {plan && status ? 'Course up on this leg' : MODE_WORDS[mode]}
                            </span>
                            {status?.reason
                                ? REASON_WORDS[status.reason]
                                : `${plan && status ? 'This leg at the top' : READY[mode]}${status ? ` · ${threeFigures(status.target!)}°${mode === 'heading' ? 'T' : ''}` : ''}`}
                        </button>
                    );
                })}
            </div>
        </ModalSheet>
    );
};

/** The north arrow on Obs, with the zoom pair. `active`: Obs is on screen, so its controller runs. */
export const ChartOrientationArrow: React.FC<{ active: boolean }> = ({ active }) => {
    const ref = useRef<HTMLButtonElement>(null);
    const needle = useRef<SVGGElement>(null);
    const [map, setMap] = useState<mapboxgl.Map | null>(null);
    const [open, setOpen] = useState(false);

    // The map beside it, which may only exist after this control mounts.
    useEffect(() => {
        const attach = () => setMap(chartMapBeside(ref.current));
        attach();
        return onChartMapsChanged(attach);
    }, []);
    const view = useChartOrientation(map, 'obs', active);

    // The needle at true north on screen, painted at most once a frame; no
    // listener while Obs is hidden.
    useEffect(() => {
        if (!map) return;
        let frame = 0;
        const paint = () => {
            frame = 0;
            needle.current?.setAttribute('transform', `rotate(${-chartBearing(map)} 12 12)`);
        };
        const onRotate = () => {
            frame ||= requestAnimationFrame(paint);
        };
        paint();
        if (!active) return;
        map.on('rotate', onRotate);
        return () => {
            cancelAnimationFrame(frame);
            map.off('rotate', onRotate);
        };
    }, [map, active]);

    const turned = view.mode !== 'north' && view.target !== null;
    return (
        <>
            <button
                ref={ref}
                type="button"
                aria-label={`Chart orientation: ${MODE_WORDS[view.mode]}${
                    turned
                        ? `, turned to ${threeFigures(view.target!)} degrees. Tap for North up`
                        : view.reason
                          ? `, holding North up: ${REASON_WORDS[view.reason]}. Tap to choose`
                          : '. Tap to choose'
                }`}
                onClick={() => (turned ? pickChartMode('north') : setOpen(true))}
                className="border border-white/8 bg-slate-900/90 text-white shadow-2xl backdrop-blur-xl"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <g ref={needle} transform="rotate(0 12 12)">
                        <path d="M12 2l4.5 10h-9z" fill="#ef4444" />
                        <path d="M12 22l-4.5-10h9z" fill="#e2e8f0" />
                    </g>
                </svg>
                <span aria-hidden="true">{view.mode[0].toUpperCase()} UP</span>
                {view.reason && <i aria-hidden="true" className="bg-amber-400" />}
            </button>
            <ChartOrientationChooser open={open} onClose={() => setOpen(false)} view={view} />
        </>
    );
};
