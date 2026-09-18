/**
 * RouteTimeScrubber — the look-ahead slider along the bottom of the chart.
 *
 * Shane, 2026-09-17: "we need to have a scrubber along the bottom … it needs to
 * show the vessel going along the route as its normal cruising speed … and all
 * of the wind and rain etc should alter as the yacht progresses along the
 * route." 2026-09-18: "lets get it out to 7 days".
 *
 * WHERE IT STANDS WAS MEASURED, NOT REASONED. The first cut reused the weather
 * scrubber's slot on the theory that everything down there already cleared
 * it. Run on the real chart page in WebKit, that slot sat its right end on the
 * Locate button, clipped Mapbox's (i) — a licence-required control — and put
 * its Play button over the Mapbox wordmark. index.css now carries the measured
 * numbers: lifted clear of the wordmark, and ended left of the whole
 * right-hand column. The chart's own time controls stand down while this is
 * up (MapWeatherControls), so there is never more than one slider moving the
 * wind.
 *
 * NO "LIVE" BUTTON HERE. The strip is always on screen beside this and carries
 * the way back; the width is better spent on a track a thumb can hit. For the
 * same reason the pill shows the CLOCK time only — the offset is in the
 * strip's header and on the ghost itself.
 *
 * The axis is "hours from now", zero to whichever comes first: she arrives at
 * her cruising speed, or seven days. It does not pretend past either.
 *
 * Presentational. The strip owns the numbers; this only moves the offset.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { triggerHaptic } from '../../utils/system';

const HOUR_MS = 3_600_000;
/** A drag lands on five-minute marks: finer than the forecast, steady under a thumb. */
const SNAP_MS = 5 * 60_000;
/** A full sweep under Play takes about this long, however long the passage. */
const PLAY_SWEEP_MS = 24_000;
const PLAY_TICK_MS = 100;

export function fmtAhead(aheadMs: number): string {
    if (aheadMs < 60_000) return 'NOW';
    const hours = aheadMs / HOUR_MS;
    if (hours < 1) return `+${Math.round(aheadMs / 60_000)} min`;
    if (hours < 48) return `+${Math.round(hours * 10) / 10} h`.replace('.0 h', ' h');
    const days = Math.floor(hours / 24);
    const rest = Math.round(hours - days * 24);
    return rest === 24 ? `+${days + 1} d` : rest === 0 ? `+${days} d` : `+${days} d ${rest} h`;
}

/** "Sat 14:05" in the phone's own time zone — the clock the skipper is wearing. */
export function fmtMoment(ms: number): string {
    const d = new Date(ms);
    const day = d.toLocaleDateString(undefined, { weekday: 'short' });
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${hh}:${mm}`;
}

export interface RouteTimeScrubberProps {
    aheadMs: number;
    /** End of the axis: arrival at cruising speed, or seven days. */
    maxMs: number;
    /** True when `maxMs` is her arrival, false when it is the seven-day cap. */
    endsAtArrival: boolean;
    playing: boolean;
    nowMs: number;
    /** Hours of wind FIELD the chart holds ahead of now; null when that layer is off. */
    windCoverageHours: number | null;
    /**
     * Chart layers that are up but do NOT follow this scrubber (rain, currents,
     * sea temp …), by the name a skipper calls them. Their own time pills are
     * stood down while this is on screen, so this is the only place that can say
     * the radar under the ghost is this minute's and not Saturday's.
     */
    unsyncedLayers?: readonly string[];
    modelLabel: string;
    modelProvider: string;
    cruiseKts: number;
    onAhead: (ms: number) => void;
    onPlaying: (playing: boolean) => void;
    onOpenModel: () => void;
}

export const RouteTimeScrubber: React.FC<RouteTimeScrubberProps> = ({
    aheadMs,
    maxMs,
    endsAtArrival,
    playing,
    nowMs,
    windCoverageHours,
    unsyncedLayers = [],
    modelLabel,
    modelProvider,
    cruiseKts,
    onAhead,
    onPlaying,
    onOpenModel,
}) => {
    const trackRef = useRef<HTMLDivElement | null>(null);
    const dragging = useRef(false);
    const usable = maxMs >= SNAP_MS;
    const pct = usable ? Math.max(0, Math.min(100, (aheadMs / maxMs) * 100)) : 0;

    const fromPointer = useCallback(
        (clientX: number) => {
            const track = trackRef.current;
            // A pointer event with no position must not become a NaN offset
            // for the ghost, the wind timeline and the forecast to follow.
            if (!track || !usable || !Number.isFinite(clientX)) return;
            const rect = track.getBoundingClientRect();
            if (rect.width <= 0) return;
            const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const raw = f * maxMs;
            // Both ends are reachable exactly; in between, five-minute marks.
            onAhead(f >= 1 ? maxMs : Math.min(maxMs, Math.round(raw / SNAP_MS) * SNAP_MS));
        },
        [maxMs, onAhead, usable],
    );

    // Play: the offset walks itself to the end and stops there. It does not
    // loop — a ghost that jumps back to the boat reads as the boat moving.
    const aheadRef = useRef(aheadMs);
    aheadRef.current = aheadMs;
    useEffect(() => {
        if (!playing || !usable) return;
        const step = Math.max(3 * 60_000, (maxMs / PLAY_SWEEP_MS) * PLAY_TICK_MS);
        const id = setInterval(() => {
            const next = Math.min(maxMs, aheadRef.current + step);
            onAhead(next);
            if (next >= maxMs) onPlaying(false);
        }, PLAY_TICK_MS);
        return () => clearInterval(id);
    }, [playing, usable, maxMs, onAhead, onPlaying]);

    const onKey = (e: React.KeyboardEvent) => {
        if (!usable) return;
        const big = e.shiftKey ? 6 : 1;
        let next: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = aheadMs + big * HOUR_MS;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = aheadMs - big * HOUR_MS;
        else if (e.key === 'PageUp') next = aheadMs + 6 * HOUR_MS;
        else if (e.key === 'PageDown') next = aheadMs - 6 * HOUR_MS;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = maxMs;
        if (next === null) return;
        e.preventDefault();
        onPlaying(false);
        onAhead(Math.max(0, Math.min(maxMs, next)));
    };

    const aheadHours = aheadMs / HOUR_MS;
    const coveragePct =
        windCoverageHours !== null && usable && windCoverageHours * HOUR_MS < maxMs
            ? Math.max(0, (windCoverageHours * HOUR_MS * 100) / maxMs)
            : null;
    const pastField = windCoverageHours !== null && aheadHours > windCoverageHours;
    const atEnd = usable && aheadMs >= maxMs;
    const clock = fmtMoment(nowMs + aheadMs);
    const moment = `${clock} · ${fmtAhead(aheadMs)}`;

    // Day marks, so seven days of track is not a featureless bar.
    const ticks: number[] = [];
    if (usable) {
        const every = maxMs > 48 * HOUR_MS ? 24 : maxMs > 12 * HOUR_MS ? 6 : 1;
        for (let h = every; h * HOUR_MS < maxMs; h += every) ticks.push((h * HOUR_MS * 100) / maxMs);
    }

    // Only when there is something to say: the row costs height the chart's
    // bottom rail does not have to spare.
    const note = pastField
        ? `Chart wind ends +${Math.round(windCoverageHours ?? 0)} h — numbers continue`
        : atEnd
          ? endsAtArrival
              ? `Arrives, at ${cruiseKts.toFixed(1)} kn cruising`
              : 'Seven days — the forecast stops here'
          : null;

    return (
        <div
            data-testid="route-time-scrubber"
            aria-label="Look ahead along the route"
            role="group"
            className="thalassa-route-scrubber absolute z-510 flex items-stretch gap-2"
        >
            <button
                type="button"
                data-testid="route-scrub-play"
                disabled={!usable}
                aria-label={playing ? 'Pause' : atEnd ? 'Play again from now' : 'Play the passage forward'}
                onClick={() => {
                    void triggerHaptic('light');
                    if (playing) {
                        onPlaying(false);
                        return;
                    }
                    if (atEnd) onAhead(0);
                    onPlaying(true);
                }}
                className="flex w-12 shrink-0 items-center justify-center self-stretch rounded-2xl border border-white/10 bg-slate-950/90 text-amber-300 shadow-lg backdrop-blur-xl active:scale-95 disabled:text-white/30"
            >
                {playing ? (
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6" y="5" width="4" height="14" rx="1" />
                        <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                ) : (
                    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M8 5.5v13a1 1 0 001.5.86l10.5-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z" />
                    </svg>
                )}
            </button>

            <div className="flex min-w-0 flex-1 flex-col justify-center rounded-2xl border border-amber-300/25 bg-slate-950/90 px-3 py-1.5 shadow-lg backdrop-blur-xl">
                <div className="flex items-center justify-between gap-2">
                    <p
                        className="min-w-0 truncate font-mono text-[13px] font-black leading-tight text-amber-200 tabular-nums"
                        data-testid="route-scrub-moment"
                    >
                        {clock}
                    </p>
                    <button
                        type="button"
                        data-testid="route-scrub-model"
                        onClick={() => {
                            void triggerHaptic('light');
                            onOpenModel();
                        }}
                        aria-label={`Forecast model ${modelLabel}. Change model`}
                        className="hit-target-44 shrink-0 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[12px] font-black leading-tight text-white active:scale-95"
                    >
                        {modelLabel} ▾
                    </button>
                </div>

                <div
                    ref={trackRef}
                    role="slider"
                    tabIndex={usable ? 0 : -1}
                    aria-label="Hours ahead along the route"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(maxMs / 60_000)}
                    aria-valuenow={Math.round(aheadMs / 60_000)}
                    aria-valuetext={moment}
                    aria-disabled={!usable}
                    data-testid="route-scrub-track"
                    className="relative h-7 cursor-pointer select-none"
                    style={{ touchAction: 'none' }}
                    onKeyDown={onKey}
                    onPointerDown={(e) => {
                        if (!usable) return;
                        dragging.current = true;
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                        onPlaying(false);
                        fromPointer(e.clientX);
                    }}
                    onPointerMove={(e) => {
                        if (dragging.current) fromPointer(e.clientX);
                    }}
                    onPointerUp={() => {
                        dragging.current = false;
                    }}
                    onPointerCancel={() => {
                        dragging.current = false;
                    }}
                >
                    <div className="absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/12">
                        {/* The stretch of the axis the chart's wind FIELD covers. */}
                        {coveragePct !== null && (
                            <div
                                className="absolute inset-y-0 left-0 bg-sky-400/30"
                                style={{ width: `${coveragePct}%` }}
                                data-testid="route-scrub-coverage"
                            />
                        )}
                        <div className="absolute inset-y-0 left-0 bg-amber-300/80" style={{ width: `${pct}%` }} />
                    </div>
                    {ticks.map((left) => (
                        <span
                            key={left}
                            className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/35"
                            style={{ left: `${left}%` }}
                            aria-hidden="true"
                        />
                    ))}
                    <span
                        className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/70 bg-amber-300 shadow-lg"
                        style={{ left: `${pct}%` }}
                        aria-hidden="true"
                    />
                </div>

                {unsyncedLayers.length > 0 && aheadMs >= 60_000 && (
                    <p
                        className="text-[12px] font-semibold leading-tight text-amber-300"
                        data-testid="route-scrub-unsynced"
                        role="status"
                    >
                        Chart {unsyncedLayers.join(', ')}: still at {unsyncedLayers.length > 1 ? 'their' : 'its'} own
                        time
                    </p>
                )}
                {note && (
                    <p
                        className={`truncate text-[12px] font-semibold leading-tight ${
                            pastField ? 'text-amber-300' : 'text-gray-300'
                        }`}
                        data-testid="route-scrub-note"
                        role="status"
                    >
                        {note}
                    </p>
                )}
                {/* Crediting the source is a licence condition (CC-BY-4.0), not
                    a courtesy: whoever made the numbers is named beside them.
                    NEVER truncated — it wraps on a narrow phone instead. The
                    full attribution line is in the change-model dialog. */}
                <p className="text-[12px] font-semibold leading-tight text-gray-400" data-testid="route-scrub-credit">
                    Forecast data: {modelProvider}
                </p>
            </div>
        </div>
    );
};
