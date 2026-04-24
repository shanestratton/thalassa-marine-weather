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
import React, { useEffect, useRef, useState } from 'react';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../../services/AnchorWatchService';
import { AisStreamService } from '../../../services/AisStreamService';
import { SwingCircleCanvas, type AisTargetDot } from '../../anchor-watch/SwingCircleCanvas';
import { formatDistance, bearingToCardinal, formatElapsed, navStatusColorSimple } from '../../anchor-watch/anchorUtils';
import { CompassIcon, WindIcon } from '../../Icons';

interface EssentialAnchorViewProps {
    /** Optional wind speed in kts for the status strip. */
    windSpeed?: number | null;
    /** Wind direction — either cardinal string ("NNE") or degrees. */
    windDirection?: string | number | null;
    /** Optional wind gust in kts. */
    windGust?: number | null;
    /** Speed unit label for display ("kts" | "mph" | "km/h"). */
    speedUnit?: string;
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
}) => {
    const [snapshot, setSnapshot] = useState<AnchorWatchSnapshot | null>(null);
    const [aisTargets, setAisTargets] = useState<AisTargetDot[]>([]);
    const snapshotRef = useRef<AnchorWatchSnapshot | null>(null);

    // Subscribe to anchor-watch snapshot updates.
    useEffect(() => {
        const unsub = AnchorWatchService.subscribe((snap) => {
            setSnapshot(snap);
            snapshotRef.current = snap;
        });
        return unsub;
    }, []);

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

            {/* Bottom status strip — distance + wind + gps quality */}
            <div className="shrink-0 grid grid-cols-3 divide-x divide-white/[0.08] border-t border-white/[0.06] bg-black/40">
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
