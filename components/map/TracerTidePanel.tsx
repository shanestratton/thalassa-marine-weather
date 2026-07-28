/**
 * TracerTidePanel — high/low times, heights, and the water level at
 * departure, on the /plan tracer card.
 *
 * The crossing maths (computeTidalWindows → "clears 08:45–14:30") already
 * ran on this surface; what was missing was the raw tide itself. The two
 * UIs that show heights — TideGraph and ChartDepthControls — mount only in
 * Dashboard and are explicitly suppressed on the planning surface, so a
 * skipper planning a bar crossing could see a verdict but never the tide
 * behind it.
 *
 * Nothing is relayed from the phone. `proxy-tides` holds the paid
 * WorldTides key server-side and answers plain browser `fetch` with
 * wildcard CORS, so the web planner reaches the same source the app does.
 *
 * HONESTY: WorldTides returns HIGH/LOW EXTREMES only. Every value between
 * them is half-cosine interpolation (provenance 'EXTREMES_INTERP'), good to
 * roughly ±0.3 m in semidiurnal regimes. Against the 0.5 m safety margin in
 * computeTidalWindows that is a real fraction of the buffer, so the panel
 * says "approx" and names the station rather than implying a measurement.
 */

import React, { useEffect, useState } from 'react';
import { fetchRealTides } from '../../services/weather/api/tides';
import { fetchTideCurve } from '../../services/TideHeightService';
import type { Tide } from '../../types/weather';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('TracerTidePanel');

/** How many upcoming extremes to list. Four ≈ one full day either side. */
const EXTREMES_SHOWN = 6;
const HOUR_MS = 3_600_000;

interface TracerTidePanelProps {
    /** Where to read the tide — the route's shallowest point, else its last pin. */
    anchor: { lat: number; lon: number } | null;
    /** Planned departure; null means "leave now". */
    departureMs: number | null;
}

interface TideState {
    extremes: Tide[];
    stationName?: string;
    atDeparture: number | null;
    /** Height an hour later, to say whether it is making or taking off. */
    trend: 'rising' | 'falling' | null;
    approximate: boolean;
}

function formatClock(iso: string): string | null {
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export const TracerTidePanel: React.FC<TracerTidePanelProps> = ({ anchor, departureMs }) => {
    const [state, setState] = useState<TideState | null>(null);
    const [loading, setLoading] = useState(false);

    const lat = anchor?.lat ?? null;
    const lon = anchor?.lon ?? null;

    useEffect(() => {
        if (lat === null || lon === null) {
            setState(null);
            return;
        }
        let stale = false;
        setLoading(true);

        void (async () => {
            try {
                const start = departureMs ?? Date.now();
                // The curve window is anchored on the DEPARTURE, not on now:
                // readTideCurveWindow() is hard-wired to now−3h/now+27h and
                // would miss a passage planned three days out entirely.
                const [real, curve] = await Promise.all([
                    fetchRealTides(lat, lon),
                    fetchTideCurve(lat, lon, start - 3 * HOUR_MS, start + 27 * HOUR_MS),
                ]);
                if (stale) return;

                const now = Date.now();
                const extremes = (real.tides ?? [])
                    .filter((t) => {
                        const ms = new Date(t.time).getTime();
                        return Number.isFinite(ms) && ms >= Math.min(start, now);
                    })
                    .slice(0, EXTREMES_SHOWN);

                const atDeparture = curve?.heightAt(start) ?? null;
                const nextHour = curve?.heightAt(start + HOUR_MS) ?? null;
                const trend =
                    atDeparture !== null && nextHour !== null ? (nextHour >= atDeparture ? 'rising' : 'falling') : null;

                setState({
                    extremes,
                    stationName: curve?.stationName ?? real.guiDetails?.stationName,
                    atDeparture,
                    trend,
                    // Anything not built from dense station heights is interpolated.
                    approximate: curve ? curve.provenance !== 'STATION_HEIGHTS' : true,
                });
            } catch (error) {
                if (!stale) {
                    setState(null);
                    log.warn('tide lookup failed', error);
                }
            } finally {
                if (!stale) setLoading(false);
            }
        })();

        return () => {
            stale = true;
        };
    }, [lat, lon, departureMs]);

    if (lat === null || lon === null) return null;

    return (
        <div className="space-y-1.5 border-t border-white/10 px-3 py-2" data-testid="tracer-tide-panel">
            <div className="flex items-baseline justify-between">
                <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">🌊 Tide</span>
                {state?.atDeparture !== null && state?.atDeparture !== undefined && (
                    <span className="text-[10px] font-bold text-sky-300">
                        {state.atDeparture.toFixed(1)} m{state.trend ? ` · ${state.trend}` : ''}
                    </span>
                )}
            </div>

            {loading && !state && <p className="text-[10px] text-gray-500">Reading the tide…</p>}

            {state && state.extremes.length === 0 && !loading && (
                <p className="text-[10px] text-gray-500">No tide station near this route.</p>
            )}

            {state && state.extremes.length > 0 && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                    {state.extremes.map((t) => {
                        const clock = formatClock(t.time);
                        if (!clock) return null;
                        const high = t.type === 'High';
                        return (
                            <div key={`${t.time}-${t.type}`} className="flex items-baseline justify-between gap-2">
                                <span
                                    className={`text-[10px] font-black uppercase tracking-wide ${
                                        high ? 'text-sky-300' : 'text-amber-300/80'
                                    }`}
                                >
                                    {high ? 'HW' : 'LW'} {clock}
                                </span>
                                <span className="text-[10px] font-mono text-gray-300">{t.height.toFixed(1)} m</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {state && state.extremes.length > 0 && (
                <p className="text-[9px] leading-snug text-gray-500">
                    {state.approximate ? 'Approx — interpolated between high and low' : 'Station heights'}
                    {state.stationName ? ` · ${state.stationName}` : ''}
                </p>
            )}
        </div>
    );
};
