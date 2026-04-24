/**
 * EssentialAnchorView — Essential-mode dashboard slide for the anchor-down state.
 *
 * When the user has deployed the anchor via AnchorWatchService, this view
 * replaces the EssentialMapSlide at the bottom of the Glass page. The
 * nav station page (AnchorWatchPage) remains the comprehensive setup /
 * management surface — this is the *glanceable* version: a quick look
 * at the phone on the chart table at 0300 to confirm the boat is still
 * holding.
 *
 * Reuses the existing anchor-watch machinery:
 *   - AnchorWatchService      — snapshot subscription (state/distance/history)
 *   - AisStreamService        — nearby vessels for radar overlay
 *   - SwingCircleCanvas       — the radar render (compass/zones/trail/AIS)
 *   - anchorUtils             — formatters kept identical to nav station
 *
 * v1 scope (matches the "critical v1" list agreed with the user):
 *   1. Swing circle (via SwingCircleCanvas — already does this)
 *   2. Boat position colour-coded by state (Canvas handles)
 *   3. Distance-from-anchor readout (compact strip below)
 *   4. Wind direction arrow (compact strip)
 *   5. Alarm chrome (red border + pulsing glow when state === 'alarm')
 *   6. Position-history trail (Canvas handles)
 *   7. Nearby AIS vessels within 2nm (polled every 30s, identical to
 *      AnchorWatchPage)
 *
 * Deferred to v1.1:
 *   - Depth-under-keel from NMEA
 *   - 12h wind forecast sparkline
 *   - Tide direction arrow
 *   - Swing-radius auto-suggest
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../../services/AnchorWatchService';
import { AisStreamService } from '../../../services/AisStreamService';
import { NmeaStore, type NmeaStoreState } from '../../../services/NmeaStore';
import { SwingCircleCanvas, type AisTargetDot } from '../../anchor-watch/SwingCircleCanvas';
import { formatDistance, bearingToCardinal, formatElapsed, navStatusColorSimple } from '../../anchor-watch/anchorUtils';
import { suggestSwingRadius } from '../../anchor-watch/swingRadiusSuggest';
import { CompassIcon, WindIcon } from '../../Icons';
import { CoachMark } from '../../ui/CoachMark';
import { triggerHaptic } from '../../../utils/system';
import type { HourlyForecast } from '../../../types';

interface EssentialAnchorViewProps {
    /** Optional wind speed in kts for the status strip. */
    windSpeed?: number | null;
    /** Wind direction — either cardinal string ("NNE") or degrees. */
    windDirection?: string | number | null;
    /** Optional wind gust in kts. */
    windGust?: number | null;
    /** Speed unit label for display ("kts" | "mph" | "km/h"). */
    speedUnit?: string;
    /**
     * Full hourly forecast for the day — used for the 12-hour wind sparkline.
     * Passed from HeroSlide, which already has it for other purposes.
     * Only the next 12 hours from "now" are used.
     */
    hourlyForecast?: HourlyForecast[];
}

/** Convert cardinal string or number → degrees (for the wind-arrow rotation). */
const windDirToDeg = (dir: string | number | null | undefined): number | null => {
    if (dir === null || dir === undefined) return null;
    if (typeof dir === 'number') return dir;
    const map: Record<string, number> = {
        N: 0,
        NNE: 22.5,
        NE: 45,
        ENE: 67.5,
        E: 90,
        ESE: 112.5,
        SE: 135,
        SSE: 157.5,
        S: 180,
        SSW: 202.5,
        SW: 225,
        WSW: 247.5,
        W: 270,
        WNW: 292.5,
        NW: 315,
        NNW: 337.5,
    };
    return map[dir.toUpperCase()] ?? null;
};

export const EssentialAnchorView: React.FC<EssentialAnchorViewProps> = ({
    windSpeed,
    windDirection,
    windGust,
    speedUnit = 'kts',
    hourlyForecast,
}) => {
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot | null>(null);
    const [aisTargets, setAisTargets] = useState<AisTargetDot[]>([]);
    const [nmeaState, setNmeaState] = useState<NmeaStoreState | null>(null);
    const snapshotRef = useRef<AnchorWatchSnapshot | null>(null);

    // Subscribe to anchor-watch snapshot updates.
    useEffect(() => {
        const unsub = AnchorWatchService.subscribe((snap) => {
            setSnapshot(snap);
            snapshotRef.current = snap;
        });
        return unsub;
    }, []);

    // Subscribe to NMEA store so depth-under-keel updates in real time.
    // Silently no-ops if no NMEA connection — depth column simply won't
    // render.
    useEffect(() => {
        const unsub = NmeaStore.subscribe(setNmeaState);
        // Seed with current state so we don't wait for the first delta.
        setNmeaState(NmeaStore.getState());
        return unsub;
    }, []);

    // ── SWING-RADIUS AUTO-SUGGEST ─────────────────────────────────────
    // After ~30min on the hook with enough GPS samples, propose a radius
    // that actually matches the observed swing envelope. Dismissals are
    // remembered for the rest of the watching session via
    // sessionStorage (keyed on the anchor drop timestamp) so the banner
    // doesn't keep re-appearing every 30s of polling.
    const suggestion = useMemo(() => suggestSwingRadius(snapshot), [snapshot]);
    const [suggestionDismissedAt, setSuggestionDismissedAt] = useState<number | null>(null);
    // When the anchor is re-dropped, watchStartedAt changes — reset the
    // dismissal flag so the new session can surface its own suggestion.
    useEffect(() => {
        setSuggestionDismissedAt(null);
    }, [snapshot?.watchStartedAt]);
    const showSuggestion =
        !!suggestion && (suggestionDismissedAt === null || snapshot?.watchStartedAt !== suggestionDismissedAt);

    const handleAcceptSuggestion = useCallback(() => {
        if (!suggestion || !snapshot) return;
        // Compute the new safetyMargin so that calculateSwingRadius()
        // produces the proposed radius: delta = proposed - current, so
        // new safetyMargin = current safetyMargin + delta. Persists
        // through the usual config pipeline (geofence re-armed,
        // watchState persisted, listeners notified).
        const delta = suggestion.proposed - snapshot.swingRadius;
        const currentMargin = snapshot.config.safetyMargin;
        const newMargin = Math.max(0, currentMargin + delta);
        AnchorWatchService.updateConfig({ safetyMargin: newMargin });
        triggerHaptic('medium');
    }, [suggestion, snapshot]);

    const handleDismissSuggestion = useCallback(() => {
        // Remember the watchStartedAt at dismissal time — on re-drop
        // (new watchStartedAt) the banner comes back naturally.
        setSuggestionDismissedAt(snapshot?.watchStartedAt ?? null);
    }, [snapshot?.watchStartedAt]);

    // Compute the next 12 hours of wind speed from the forecast for the
    // sparkline. Memoised so the SVG path doesn't rebuild every render.
    const windSeries = useMemo<number[]>(() => {
        if (!hourlyForecast || hourlyForecast.length === 0) return [];
        const now = Date.now();
        const twelveHoursFromNow = now + 12 * 3600_000;
        return hourlyForecast
            .filter((h) => {
                const t = new Date(h.time).getTime();
                return t >= now - 30 * 60_000 && t <= twelveHoursFromNow;
            })
            .slice(0, 12)
            .map((h) => (typeof h.windSpeed === 'number' ? h.windSpeed : 0));
    }, [hourlyForecast]);

    // 12-hour wind sparkline — derive a smooth area path from windSeries.
    // Colour-coded by the PEAK wind in the window so a glance tells the
    // skipper what's coming, not just the average. Computed here (BEFORE
    // any conditional early return) so the hook order stays stable across
    // renders regardless of whether the snapshot has loaded yet.
    const sparkline = useMemo(() => {
        if (windSeries.length < 2) return null;
        const W = 100; // SVG viewBox width
        const H = 100; // SVG viewBox height
        const padY = 8; // top/bottom padding so peaks aren't clipped
        const maxWind = Math.max(...windSeries, 10); // baseline 10kt so flat calm doesn't fill the box
        const minWind = Math.min(...windSeries, 0);
        const range = Math.max(1, maxWind - minWind);

        // x positions evenly spaced across the viewport
        const points = windSeries.map((v, i) => {
            const x = (i / (windSeries.length - 1)) * W;
            const y = H - padY - ((v - minWind) / range) * (H - padY * 2);
            return { x, y };
        });

        // Smooth quadratic-bezier path for the line
        let linePath = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
        for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1];
            const curr = points[i];
            const cpx = (prev.x + curr.x) / 2;
            linePath += ` Q ${prev.x.toFixed(1)} ${prev.y.toFixed(1)}, ${cpx.toFixed(1)} ${(
                (prev.y + curr.y) /
                2
            ).toFixed(1)}`;
            linePath += ` T ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
        }
        // Area fill path — same line, closed down to bottom
        const areaPath = `${linePath} L ${W} ${H} L 0 ${H} Z`;

        // Colour by peak wind — matches the anchor-watch scope thresholds
        // from anchorUtils.getWeatherRecommendation so the sparkline and
        // the scope rec (if shown elsewhere) agree.
        const peak = maxWind;
        const strokeColor = peak >= 25 ? '#ef4444' : peak >= 18 ? '#f59e0b' : peak >= 12 ? '#fbbf24' : '#34d399';
        const fillGradientId = `wind-sparkline-fill-${strokeColor.slice(1)}`;
        return { linePath, areaPath, strokeColor, fillGradientId, peak, maxWind };
    }, [windSeries]);

    // Poll nearby AIS every 30s while anchored. Same radius + limit as
    // AnchorWatchPage so the radar overlay feels identical between the
    // two surfaces.
    useEffect(() => {
        if (!snapshot || snapshot.state === 'idle' || !snapshot.anchorPosition) {
            setAisTargets([]);
            return;
        }

        let cancelled = false;

        const fetchAisTargets = async () => {
            const snap = snapshotRef.current;
            if (!snap?.anchorPosition) return;

            try {
                const geojson = await AisStreamService.fetchNearby({
                    lat: snap.anchorPosition.latitude,
                    lon: snap.anchorPosition.longitude,
                    radiusNm: 2,
                    limit: 50,
                });

                if (cancelled) return;

                const dots: AisTargetDot[] = (geojson.features || [])
                    .filter((f) => {
                        const coords = (f.geometry as GeoJSON.Point)?.coordinates;
                        return coords && coords.length >= 2;
                    })
                    .map((f) => {
                        const p = f.properties || {};
                        const coords = (f.geometry as GeoJSON.Point).coordinates;
                        return {
                            mmsi: Number(p.mmsi),
                            name: p.name || `MMSI ${p.mmsi}`,
                            lat: coords[1],
                            lon: coords[0],
                            cog: Number(p.cog ?? 0),
                            sog: Number(p.sog ?? 0),
                            statusColor: navStatusColorSimple(p.navStatus ?? p.nav_status ?? 15),
                        };
                    });

                setAisTargets(dots);
            } catch (e) {
                // Silently fail — AIS is a nice-to-have overlay; the
                // radar still works without it.
                void e;
            }
        };

        fetchAisTargets();
        const id = setInterval(() => {
            if (document.hidden) return; // battery: skip when backgrounded
            fetchAisTargets();
        }, 30_000);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [snapshot?.state, snapshot?.anchorPosition]);

    // Guard: if anchor watch is idle the caller shouldn't have rendered
    // us, but belt-and-braces so we don't render an empty canvas.
    if (!snapshot || snapshot.state === 'idle' || !snapshot.anchorPosition) return null;

    const isAlarm = snapshot.state === 'alarm';
    const isHolding = snapshot.state === 'watching' && snapshot.distanceFromAnchor < snapshot.swingRadius;
    const isDrifting = snapshot.state === 'watching' && snapshot.distanceFromAnchor >= snapshot.swingRadius;

    // Status label + colour — mirrored in the outer border + header pill
    // so the glanceable read matches regardless of which element catches
    // the eye first.
    const statusLabel = isAlarm ? 'ALARM' : isDrifting ? 'DRIFTING' : isHolding ? 'HOLDING' : 'WATCHING';
    const statusColor = isAlarm
        ? 'text-red-300'
        : isDrifting
          ? 'text-amber-300'
          : isHolding
            ? 'text-emerald-300'
            : 'text-sky-300';
    const statusDot = isAlarm
        ? 'bg-red-400'
        : isDrifting
          ? 'bg-amber-400'
          : isHolding
            ? 'bg-emerald-400'
            : 'bg-sky-400';
    const outerBorder = isAlarm
        ? 'border-red-500/40 shadow-red-500/30'
        : isDrifting
          ? 'border-amber-500/30 shadow-amber-500/20'
          : 'border-white/10';

    const windDeg = windDirToDeg(windDirection);
    const windRounded = typeof windSpeed === 'number' ? Math.round(windSpeed) : '--';
    const gustRounded = typeof windGust === 'number' ? Math.round(windGust) : null;

    // Depth-under-keel — from NMEA if live, else hide the column.
    // `freshness === 'live'` means the depth reading is < 3s old, which is
    // the only state where we should trust the number enough to show it in
    // a safety-critical context.
    const depthLive = nmeaState?.depth?.freshness === 'live' && nmeaState.depth.value !== null;
    const depthValue = depthLive && nmeaState?.depth.value !== null ? nmeaState.depth.value : null;
    // Depth severity: < 2m in a rising tide over a rocky bottom is the
    // scenario this column protects against. Colour bands chosen to read
    // clearly at a glance from the chart table.
    const depthColor =
        depthValue === null
            ? 'text-white'
            : depthValue < 2
              ? 'text-red-300'
              : depthValue < 5
                ? 'text-amber-300'
                : 'text-emerald-300';

    return (
        <div
            className={`relative w-full h-full rounded-xl overflow-hidden border bg-slate-950/60 shadow-2xl flex flex-col ${outerBorder} ${
                isAlarm ? 'staleness-loud-glow' : ''
            }`}
            role="region"
            aria-label={`Anchor watch — ${statusLabel}. Distance from anchor ${formatDistance(
                snapshot.distanceFromAnchor,
            )} of ${formatDistance(snapshot.swingRadius)} swing radius.`}
        >
            {/* First-use coach mark — teaches the swap. Only fires the first
                time the anchor view appears on the Glass (a fresh drop after
                install). Suppressed during alarm so the red chrome + audio
                aren't competing with a coach tip. */}
            {!isAlarm && (
                <CoachMark
                    seenKey="thalassa_anchor_view_coach_v1"
                    visibleWhen={true}
                    anchor="center"
                    arrow="down"
                    message="Swing radar replaces the map while you're on the hook"
                    initialDelayMs={1200}
                    ttlMs={7000}
                    className="top-10"
                />
            )}
            {/* Top chrome — status pill + elapsed time */}
            <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-white/[0.06] bg-black/30">
                <div className="flex items-center gap-2">
                    <span className="relative flex w-2 h-2 shrink-0">
                        {(isAlarm || isDrifting) && (
                            <span className={`animate-ping absolute inset-0 rounded-full ${statusDot} opacity-60`} />
                        )}
                        <span className={`relative w-2 h-2 rounded-full ${statusDot}`} />
                    </span>
                    <span className={`text-[11px] font-bold uppercase tracking-widest ${statusColor}`}>
                        {statusLabel}
                    </span>
                </div>
                <span className="text-[10px] font-mono text-white/50 uppercase tracking-wider">
                    {snapshot.watchStartedAt ? `On hook ${formatElapsed(snapshot.watchStartedAt)}` : '—'}
                </span>
            </div>

            {/* Swing-radius auto-suggest banner — appears after ~30min on
                the hook if the observed swing differs materially from the
                configured radius. Suppressed during alarm (don't add decision
                fatigue to a crisis). */}
            {showSuggestion && suggestion && !isAlarm && (
                <div
                    className={`shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] ${
                        suggestion.direction === 'larger'
                            ? 'bg-amber-500/10 border-amber-500/25'
                            : 'bg-sky-500/10 border-sky-500/25'
                    }`}
                    role="status"
                    aria-live="polite"
                >
                    {/* Target icon — dashed circle = "suggested swing" */}
                    <svg
                        className={`w-4 h-4 shrink-0 ${
                            suggestion.direction === 'larger' ? 'text-amber-300' : 'text-sky-300'
                        }`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        aria-hidden="true"
                    >
                        <circle cx="12" cy="12" r="9" strokeDasharray="3 3" />
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                    </svg>
                    <div className="flex-1 min-w-0 leading-tight">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-white/80 leading-none mb-0.5">
                            {suggestion.direction === 'larger'
                                ? 'Observed swing exceeds your radius'
                                : 'Your swing radius is larger than needed'}
                        </p>
                        <p className="text-[11px] text-white/60 leading-tight truncate">
                            Propose{' '}
                            <span
                                className={`font-mono font-bold ${
                                    suggestion.direction === 'larger' ? 'text-amber-200' : 'text-sky-200'
                                }`}
                            >
                                {formatDistance(suggestion.proposed)}
                            </span>{' '}
                            vs current{' '}
                            <span className="font-mono font-bold text-white/80">
                                {formatDistance(suggestion.current)}
                            </span>{' '}
                            · {suggestion.samples} samples
                        </p>
                    </div>
                    <button
                        onClick={handleAcceptSuggestion}
                        aria-label={`Accept suggested swing radius of ${formatDistance(suggestion.proposed)}`}
                        className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all active:scale-[0.95] ${
                            suggestion.direction === 'larger'
                                ? 'bg-amber-500/25 border border-amber-400/50 text-amber-100 hover:bg-amber-500/35'
                                : 'bg-sky-500/25 border border-sky-400/50 text-sky-100 hover:bg-sky-500/35'
                        }`}
                    >
                        Accept
                    </button>
                    <button
                        onClick={handleDismissSuggestion}
                        aria-label="Dismiss swing radius suggestion"
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-white/40 hover:text-white/80 hover:bg-white/[0.08] transition-colors"
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <line x1="6" y1="6" x2="18" y2="18" />
                            <line x1="18" y1="6" x2="6" y2="18" />
                        </svg>
                    </button>
                </div>
            )}

            {/* 12-hour wind forecast sparkline — thin strip between the top
                chrome and the radar. Lets the skipper see at a glance whether
                the breeze is dying down (nap on) or building (chain out, set
                the alarm wider). Only renders when we have enough forecast
                data to draw a meaningful curve. */}
            {sparkline && (
                <div
                    className="shrink-0 relative h-[32px] border-b border-white/[0.06] bg-black/20 overflow-hidden"
                    aria-label={`12-hour wind forecast. Peak ${Math.round(sparkline.peak)} ${speedUnit}.`}
                    role="img"
                >
                    {/* Label + peak readout pinned to the top corners of the strip */}
                    <span className="absolute top-1 left-2 text-[8px] font-bold uppercase tracking-widest text-white/40 leading-none pointer-events-none">
                        12h Wind
                    </span>
                    <span className="absolute top-1 right-2 text-[8px] font-mono font-bold uppercase tracking-wider text-white/60 leading-none pointer-events-none">
                        peak {Math.round(sparkline.peak)} {speedUnit}
                    </span>
                    <svg
                        className="absolute inset-0 w-full h-full"
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                    >
                        <defs>
                            <linearGradient id={sparkline.fillGradientId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={sparkline.strokeColor} stopOpacity="0.35" />
                                <stop offset="100%" stopColor={sparkline.strokeColor} stopOpacity="0.02" />
                            </linearGradient>
                        </defs>
                        {/* Subtle gridlines at 3h / 6h / 9h so the strip reads
                            as time, not just "a curve" */}
                        {[25, 50, 75].map((x) => (
                            <line
                                key={x}
                                x1={x}
                                x2={x}
                                y1="0"
                                y2="100"
                                stroke="rgba(255,255,255,0.06)"
                                strokeWidth="0.4"
                                vectorEffect="non-scaling-stroke"
                            />
                        ))}
                        <path d={sparkline.areaPath} fill={`url(#${sparkline.fillGradientId})`} />
                        <path
                            d={sparkline.linePath}
                            fill="none"
                            stroke={sparkline.strokeColor}
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                        />
                    </svg>
                </div>
            )}

            {/* Main radar — SwingCircleCanvas takes most of the space */}
            <div className="relative flex-1 min-h-0">
                <SwingCircleCanvas
                    snapshot={snapshot}
                    aisTargets={aisTargets.length > 0 ? aisTargets : undefined}
                    className="absolute inset-0 w-full h-full"
                    ariaLabel={`Anchor watch radar. ${statusLabel}. Distance ${formatDistance(
                        snapshot.distanceFromAnchor,
                    )} of ${formatDistance(snapshot.swingRadius)} swing radius. ${aisTargets.length} nearby vessels.`}
                />
            </div>

            {/* Bottom status strip — distance + wind + (optional) depth + gps.
                Grid switches from 3-col to 4-col when NMEA depth is live so
                the column widths rebalance automatically. */}
            <div
                className={`shrink-0 grid ${depthLive ? 'grid-cols-4' : 'grid-cols-3'} divide-x divide-white/[0.08] border-t border-white/[0.06] bg-black/40`}
            >
                {/* Distance from anchor */}
                <div className="flex flex-col items-center justify-center py-2 px-2">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-white/50 leading-none mb-0.5">
                        Distance
                    </span>
                    <span className={`text-lg font-mono font-bold tracking-tight leading-none ${statusColor}`}>
                        {formatDistance(snapshot.distanceFromAnchor)}
                    </span>
                    <span className="text-[9px] text-white/40 leading-none mt-0.5">
                        of {formatDistance(snapshot.swingRadius)}
                    </span>
                </div>

                {/* Wind direction + speed */}
                <div className="flex flex-col items-center justify-center py-2 px-2">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-white/50 leading-none mb-0.5">
                        Wind
                    </span>
                    <div className="flex items-center gap-1.5">
                        {windDeg !== null && (
                            <CompassIcon rotation={windDeg} className="w-3 h-3 text-sky-300 shrink-0" />
                        )}
                        <span className="text-lg font-mono font-bold tracking-tight leading-none text-white">
                            {windRounded}
                        </span>
                    </div>
                    <span className="text-[9px] text-white/40 leading-none mt-0.5">
                        {speedUnit}
                        {gustRounded !== null ? ` · g ${gustRounded}` : ''}
                        {windDeg !== null ? ` · from ${bearingToCardinal(windDeg)}` : ''}
                    </span>
                </div>

                {/* Depth under keel — only when NMEA is live. Positioned here
                    (between Wind and GPS) so it sits next to the most
                    safety-relevant signals. */}
                {depthLive && (
                    <div className="flex flex-col items-center justify-center py-2 px-2">
                        <span className="text-[9px] font-bold uppercase tracking-widest text-white/50 leading-none mb-0.5">
                            Depth
                        </span>
                        <span className={`text-lg font-mono font-bold tracking-tight leading-none ${depthColor}`}>
                            {depthValue !== null ? depthValue.toFixed(1) : '--'}
                        </span>
                        <span className="text-[9px] text-white/40 leading-none mt-0.5">m under keel</span>
                    </div>
                )}

                {/* GPS quality */}
                <div className="flex flex-col items-center justify-center py-2 px-2">
                    <span className="text-[9px] font-bold uppercase tracking-widest text-white/50 leading-none mb-0.5">
                        GPS
                    </span>
                    <div className="flex items-center gap-1.5">
                        <WindIcon className="w-3 h-3 text-white/40 shrink-0" />
                        <span className="text-lg font-mono font-bold tracking-tight leading-none text-white">
                            ±{snapshot.gpsAccuracy > 0 ? Math.round(snapshot.gpsAccuracy) : '--'}
                        </span>
                    </div>
                    <span className="text-[9px] text-white/40 leading-none mt-0.5">m · {snapshot.gpsQualityLabel}</span>
                </div>
            </div>
        </div>
    );
};

EssentialAnchorView.displayName = 'EssentialAnchorView';
