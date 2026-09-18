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
 * PHASE 3 — THE BAND. Behind the track, the five models' wind along HER PLAN:
 * a band from the lowest to the highest of them, the pinned model's own line
 * through it, red where they are split. It costs no height — the bottom rail
 * has none to give — and it answers at a glance the two things a skipper scrubs
 * for: where does it blow, and where do the models stop agreeing. The credit
 * then names every provider whose numbers are in the band.
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

/** One point of the model-spread band, at fraction `f` (0…1) of the axis. */
export interface SpreadBandPoint {
    f: number;
    minKts: number | null;
    maxKts: number | null;
    /** The pinned model's own wind there — the line through the band. */
    pinnedKts: number | null;
    level: 'none' | 'agree' | 'some' | 'split';
}

/**
 * The band's vertical scale: a little over the strongest wind in it, and never
 * under this. Seen on the real chart on a 6–10 kn day, a fixed 25 kn top left
 * the whole band as a squiggle along the bottom of a 28 px track. The scale
 * carries no labels — what it has to show is SHAPE and WIDTH — but the floor
 * stops a five-knot drift being drawn as though it were a blow.
 */
const BAND_MIN_TOP_KTS = 15;
const BAND_HEADROOM = 1.15;

/** SVG paths for the band, in a 100 × 28 box. Exported for the tests. */
export function spreadBandPaths(points: readonly SpreadBandPoint[]): {
    band: string[];
    split: string[];
    /** A rule along the top for every split stretch — see below. */
    splitRule: string[];
    line: string;
    topKts: number;
} {
    const strongest = Math.max(0, ...points.flatMap((p) => [p.maxKts ?? 0, p.pinnedKts ?? 0]));
    const topKts = Math.max(BAND_MIN_TOP_KTS, strongest * BAND_HEADROOM);
    const x = (p: SpreadBandPoint) => (p.f * 100).toFixed(2);
    const y = (kts: number) => (28 - (Math.max(0, Math.min(kts, topKts)) / topKts) * 26 - 1).toFixed(2);
    // Runs of consecutive points that HAVE a range: a gap (models ran out, no
    // forecast) breaks the band rather than being drawn across.
    const runs = (keep: (p: SpreadBandPoint) => boolean): SpreadBandPoint[][] => {
        const out: SpreadBandPoint[][] = [];
        let run: SpreadBandPoint[] = [];
        for (const p of points) {
            if (p.minKts !== null && p.maxKts !== null && keep(p)) run.push(p);
            else {
                if (run.length > 1) out.push(run);
                run = [];
            }
        }
        if (run.length > 1) out.push(run);
        return out;
    };
    const area = (run: SpreadBandPoint[]) =>
        `M${run.map((p) => `${x(p)},${y(p.maxKts as number)}`).join(' L')} L${[...run]
            .reverse()
            .map((p) => `${x(p)},${y(p.minKts as number)}`)
            .join(' L')} Z`;
    const pinned = points.filter((p) => p.pinnedKts !== null);
    // THE RULE. The red envelope alone under-reported twice over (review,
    // 2026-09-19): a split that is all about DIRECTION has a range of nothing —
    // five models at 18 kn from 80° apart drew no red at all — and a split one
    // sample long was dropped as "not a band". So every split stretch, whatever
    // caused it and however short, gets a rule along the top of the box, half a
    // step either side of its samples. It sits clear of the band: the scale's
    // headroom keeps the strongest wind below it.
    const gaps = points
        .slice(1)
        .map((p, i) => p.f - points[i].f)
        .filter((d) => d > 0);
    const half = gaps.length > 0 ? (Math.min(...gaps) * 100) / 2 : 0;
    const splitRuns: SpreadBandPoint[][] = [];
    let current: SpreadBandPoint[] = [];
    for (const p of points) {
        if (p.level === 'split') current.push(p);
        else if (current.length > 0) {
            splitRuns.push(current);
            current = [];
        }
    }
    if (current.length > 0) splitRuns.push(current);
    const splitRule = splitRuns.map((run) => {
        const from = Math.max(0, run[0].f * 100 - half).toFixed(2);
        const to = Math.min(100, run[run.length - 1].f * 100 + half).toFixed(2);
        return `M${from},1.5 L${to},1.5`;
    });
    return {
        band: runs(() => true).map(area),
        split: runs((p) => p.level === 'split').map(area),
        splitRule,
        line: pinned.length > 1 ? `M${pinned.map((p) => `${x(p)},${y(p.pinnedKts as number)}`).join(' L')}` : '',
        topKts,
    };
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
    /** True when the arrival is worked from the wind (a polar) and not a flat speed. */
    arrivalEstimated?: boolean;
    /** Offset from which her speed is ASSUMED because the wind forecast has run out; null if never. */
    assumedFromMs?: number | null;
    /** The five models' wind along her plan; null when there is no spread to draw. */
    spreadBand?: readonly SpreadBandPoint[] | null;
    /** Every provider whose numbers are in the band — all of them are credited. */
    spreadProviders?: readonly string[] | null;
    /** Hours ahead the chart's RAIN imagery can follow to; null when it cannot or is off. */
    rainCoverageHours?: number | null;
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
    arrivalEstimated = false,
    assumedFromMs = null,
    spreadBand = null,
    spreadProviders = null,
    rainCoverageHours = null,
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
    // A second's grace: the plan is re-walked every 30 s and its end moves by
    // moments; the strip snaps a parked offset to the new end, and until it has,
    // she is still AT the end — Play must offer to start again, not do nothing.
    const atEnd = usable && aheadMs >= maxMs - 1000;
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
    const pastRain = rainCoverageHours !== null && aheadHours > rainCoverageHours;
    // Her speed is assumed from here on: the wind forecast has run out, and a
    // polar fed nothing is an invention. Said once she scrubs into that stretch.
    const assuming = assumedFromMs !== null && aheadMs >= assumedFromMs && arrivalEstimated;
    const note = pastField
        ? `Chart wind ends +${Math.round(windCoverageHours ?? 0)} h — numbers continue`
        : pastRain
          ? `Chart rain ends +${rainCoverageHours < 10 ? rainCoverageHours.toFixed(1) : Math.round(rainCoverageHours)} h`
          : assuming
            ? `No wind forecast here — ${cruiseKts.toFixed(1)} kn assumed`
            : atEnd
              ? endsAtArrival
                  ? arrivalEstimated
                      ? 'Arrives — by the wind, an estimate'
                      : `Arrives, at ${cruiseKts.toFixed(1)} kn cruising`
                  : 'Seven days — the forecast stops here'
              : null;
    // ONE note slot, and the wind's sentence wins it. Past BOTH reaches the rain
    // is back on its observed frame with nothing saying so — the swallowed note
    // was the only label it had (review, 2026-09-19). So there it goes back on
    // the row that says, truthfully, that it is at its own time.
    const ownTime: readonly string[] =
        pastRain && pastField && !unsyncedLayers.includes('rain') ? ['rain', ...unsyncedLayers] : unsyncedLayers;
    const band = spreadBand && spreadBand.length > 1 ? spreadBandPaths(spreadBand) : null;
    const credited =
        spreadProviders && spreadProviders.length > 0
            ? spreadProviders.includes(modelProvider)
                ? spreadProviders
                : [modelProvider, ...spreadProviders]
            : [modelProvider];

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
                    {band && (
                        <svg
                            className="pointer-events-none absolute inset-0 h-full w-full"
                            viewBox="0 0 100 28"
                            preserveAspectRatio="none"
                            aria-hidden="true"
                            data-testid="route-scrub-band"
                        >
                            {band.band.map((d) => (
                                <path key={`b${d}`} d={d} fill="rgba(125,211,252,0.42)" />
                            ))}
                            {band.split.map((d) => (
                                <path key={`s${d}`} d={d} fill="rgba(248,113,113,0.5)" />
                            ))}
                            {band.splitRule.map((d) => (
                                <path
                                    key={`r${d}`}
                                    d={d}
                                    fill="none"
                                    stroke="rgba(248,113,113,0.95)"
                                    strokeWidth="3"
                                    vectorEffect="non-scaling-stroke"
                                    data-testid="route-scrub-band-split"
                                />
                            ))}
                            {band.line && (
                                <path
                                    d={band.line}
                                    fill="none"
                                    stroke="rgba(252,211,77,0.95)"
                                    strokeWidth="1.6"
                                    vectorEffect="non-scaling-stroke"
                                />
                            )}
                        </svg>
                    )}
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

                {ownTime.length > 0 && aheadMs >= 60_000 && (
                    <p
                        className="text-[12px] font-semibold leading-tight text-amber-300"
                        data-testid="route-scrub-unsynced"
                        role="status"
                    >
                        Chart {ownTime.join(', ')}: still at {ownTime.length > 1 ? 'their' : 'its'} own time
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
                    Forecast data: {credited.join(', ')}
                </p>
            </div>
        </div>
    );
};
