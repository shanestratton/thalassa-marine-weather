/**
 * DepartureSweepSheet — the INSHORE departure optimiser (Masterplan
 * Phase 8, owner-approved as an explicit-button feature, §8.3).
 *
 * Mirrors DepartureWindowSheet's visual language (bottom sheet, best-pick
 * callout, tappable scenario rows) but runs the LOCAL Phase 8 engine
 * instead of the isochrone fleet: sweepDepartures() re-walks the SAME
 * locked inshore polyline at 25 candidate departures × 30 min, with the
 * destination tide curve (free extremes path) and CMEMS currents threaded
 * into the ETAs. Sub-second, fully on-device once the two fields load.
 *
 * Honesty rules surface directly in the UI:
 *   - tide unavailable → options say so rather than fake confidence;
 *   - EXTREMES_INTERP curves label the sheet "tide approx ±0.3 m";
 *   - currents refine ETAs only — never the open/blocked verdicts;
 *   - depth chokepoint gating (amber window chips) lights up when the
 *     engine's per-run charted depths arrive (masterplan Phase 4) — the
 *     sweep already supports it via shallowSpots.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { VoyagePlan, VesselProfile } from '../../types';
import { vesselDraftMetres } from '../../services/units';
import { motoringSpeedModel, tideFieldFromCurve, type TideField } from '../../services/routing/env/EnvFields';
import { getCurrentField } from '../../services/routing/env/CmemsCurrentField';
import {
    sweepDepartures,
    type DepartureOption,
    type DepartureSweep,
} from '../../services/routing/DepartureSweepInshore';
import type { LonLat } from '../../services/routing/TideAwareAnnotator';
import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';

const log = createLogger('DepartureSweepSheet');

const STATUS_STYLES: Record<DepartureOption['status'], { bg: string; border: string; text: string; label: string }> = {
    clear: { bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', text: 'text-emerald-400', label: 'CLEAR' },
    blocked: { bg: 'bg-red-500/10', border: 'border-red-500/25', text: 'text-red-400', label: 'BLOCKED' },
    unknown: { bg: 'bg-slate-500/10', border: 'border-slate-500/25', text: 'text-slate-400', label: 'NO TIDE' },
};

function fmtTime(ms: number): string {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDay(ms: number): string {
    return new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtPassage(ms: number): string {
    const mins = Math.round(ms / 60_000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** Inline sparkline of passage time across the sweep — the flood/ebb shape. */
const PassageSparkline: React.FC<{ options: DepartureOption[]; bestIdx: number; selectedIdx: number | null }> = ({
    options,
    bestIdx,
    selectedIdx,
}) => {
    if (options.length < 2) return null;
    const W = 320;
    const H = 44;
    const times = options.map((o) => o.passageMs);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const span = Math.max(1, max - min);
    const x = (i: number): number => (i / (options.length - 1)) * (W - 8) + 4;
    const y = (t: number): number => H - 6 - ((t - min) / span) * (H - 14);
    const path = options
        .map((o, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(o.passageMs).toFixed(1)}`)
        .join(' ');
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-11" aria-hidden>
            <path d={path} fill="none" stroke="rgba(56,189,248,0.6)" strokeWidth="1.5" />
            {options.map((o, i) => (
                <circle
                    key={o.departMs}
                    cx={x(i)}
                    cy={y(o.passageMs)}
                    r={i === selectedIdx ? 4 : i === bestIdx ? 3 : 1.5}
                    fill={
                        o.status === 'blocked'
                            ? 'rgba(248,113,113,0.9)'
                            : i === bestIdx
                              ? 'rgba(52,211,153,0.95)'
                              : 'rgba(148,163,184,0.7)'
                    }
                />
            ))}
        </svg>
    );
};

interface DepartureSweepSheetProps {
    open: boolean;
    onClose: () => void;
    voyagePlan: VoyagePlan | null;
    vessel: VesselProfile | null | undefined;
    /** Accept a departure: caller sets the form date (date-level, mirroring
     *  the offshore sheet) — the precise time stays in the row the user saw. */
    onAccept: (departMs: number) => void;
}

export const DepartureSweepSheet: React.FC<DepartureSweepSheetProps> = ({
    open,
    onClose,
    voyagePlan,
    vessel,
    onAccept,
}) => {
    const [loading, setLoading] = useState(false);
    const [sweep, setSweep] = useState<DepartureSweep | null>(null);
    const [tideProvenance, setTideProvenance] = useState<TideField['provenance'] | 'NONE'>('NONE');
    const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(open, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });

    // The locked inshore polyline — the sweep NEVER re-routes, it re-times.
    const polyline = useMemo<LonLat[] | null>(() => {
        const geo = voyagePlan?.routeGeoJSON as
            | { geometry?: { type?: string; coordinates?: [number, number][] } }
            | undefined;
        const coords = geo?.geometry?.type === 'LineString' ? geo.geometry.coordinates : null;
        return coords && coords.length >= 2 ? (coords as LonLat[]) : null;
    }, [voyagePlan]);

    useEffect(() => {
        if (!open || !polyline) return;
        let cancelled = false;
        setLoading(true);
        setSweep(null);
        setSelectedIdx(null);

        (async () => {
            const startMs = Date.now();
            const horizonMs = startMs + 36 * 3_600_000;
            const dest = polyline[polyline.length - 1];

            // Tide curve at the destination (free extremes path, pi-cached).
            let tide: TideField | null = null;
            try {
                const { fetchTideCurve } = await import('../../services/TideHeightService');
                const curve = await fetchTideCurve(dest[1], dest[0], startMs, horizonMs + 24 * 3_600_000);
                if (curve) tide = tideFieldFromCurve(curve);
            } catch (e) {
                log.warn('tide curve unavailable for sweep:', e);
            }

            // CMEMS currents over the route bbox — ETA refinement only.
            let currents = null;
            try {
                const lats = polyline.map((p) => p[1]);
                const lons = polyline.map((p) => p[0]);
                currents = await getCurrentField(
                    {
                        north: Math.max(...lats),
                        south: Math.min(...lats),
                        east: Math.max(...lons),
                        west: Math.min(...lons),
                    },
                    { startMs, endMs: horizonMs },
                );
            } catch (e) {
                log.warn('current field unavailable for sweep:', e);
            }

            if (cancelled) return;

            const result = sweepDepartures({
                polyline,
                speed: motoringSpeedModel(vessel?.cruisingSpeed),
                tide,
                currents,
                // shallowSpots arrive with the engine's per-run charted depths
                // (masterplan Phase 4); until then nothing gates and the sweep
                // surfaces passage/ETA/current value honestly.
                draftM: vesselDraftMetres(vessel),
                startMs,
            });
            setSweep(result);
            setTideProvenance(tide?.provenance ?? 'NONE');
            setLoading(false);
        })().catch((e) => {
            log.warn('sweep failed:', e);
            if (!cancelled) setLoading(false);
        });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, polyline]);

    if (!open) return null;

    const options = sweep?.options ?? [];
    const best = sweep?.best ?? null;
    const bestIdx = best ? options.findIndex((o) => o.departMs === best.departMs) : -1;
    const fastest = options.length ? Math.min(...options.map((o) => o.passageMs)) : 0;
    const slowest = options.length ? Math.max(...options.map((o) => o.passageMs)) : 0;
    const spreadMin = Math.round((slowest - fastest) / 60_000);
    const haveCurrents = (sweep?.currentProvenance ?? 'NONE') !== 'NONE';

    return (
        <OverlayPortal className="flex items-end justify-center">
            <div
                role="presentation"
                onClick={onClose}
                className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
            />

            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="departure-sweep-title"
                className="relative w-full max-w-2xl max-h-[90vh] flex flex-col bg-slate-950 border-t border-x border-white/10 rounded-t-3xl shadow-2xl animate-in slide-in-from-bottom duration-300"
            >
                <div className="flex-shrink-0 pt-2 pb-1 flex justify-center">
                    <div className="w-12 h-1 rounded-full bg-white/20" />
                </div>

                {/* Header */}
                <div className="flex-shrink-0 px-5 pt-2 pb-4 border-b border-white/5">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                            <h2 id="departure-sweep-title" className="text-base font-bold text-white">
                                Inshore Departure Sweep
                            </h2>
                            <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                                {voyagePlan ? `${voyagePlan.origin} → ${voyagePlan.destination}` : 'Best time to leave'}
                            </p>
                        </div>
                        <button
                            ref={closeButtonRef}
                            onClick={onClose}
                            type="button"
                            aria-label="Close"
                            className="shrink-0 p-2 -mr-2 -mt-1 text-slate-400 hover:text-white"
                        >
                            <svg
                                className="w-5 h-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    {loading && (
                        <div className="mt-3 flex items-center gap-2 text-[11px] text-sky-400">
                            <div className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-pulse" />
                            <span className="font-mono tracking-wide">Loading tide + current fields…</span>
                        </div>
                    )}
                    {!loading && tideProvenance === 'EXTREMES_INTERP' && (
                        <p className="mt-2 text-[10px] text-amber-300/80">Tide approx ±0.3 m (interpolated extremes)</p>
                    )}
                    {!loading && tideProvenance === 'NONE' && (
                        <p className="mt-2 text-[10px] text-slate-500">
                            Tide data unavailable here — times shown without tidal gating.
                        </p>
                    )}
                </div>

                {/* Best pick + sparkline */}
                {!loading && best && (
                    <div className="flex-shrink-0 px-5 pt-3 pb-1">
                        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3">
                            <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                                    Best Departure
                                </span>
                                {haveCurrents && spreadMin > 0 && (
                                    <span className="text-[10px] text-emerald-300/70">
                                        tide stream swings passage ±{spreadMin} min
                                    </span>
                                )}
                            </div>
                            <div className="text-sm font-bold text-white">
                                Leave {fmtDay(best.departMs)} {fmtTime(best.departMs)}
                            </div>
                            <div className="text-xs text-slate-300 mt-0.5">
                                {fmtPassage(best.passageMs)} underway • arrive {fmtTime(best.arriveMs)}
                                {best.minUkcM !== null &&
                                    ` • ${best.minUkcM.toFixed(1)} m under the keel at the worst spot`}
                                {best.steeringWarnings > 0 &&
                                    ` • expect set on ${best.steeringWarnings} leg${best.steeringWarnings > 1 ? 's' : ''}`}
                            </div>
                        </div>
                        <div className="mt-2 px-1">
                            <PassageSparkline options={options} bestIdx={bestIdx} selectedIdx={selectedIdx} />
                            <div className="flex justify-between text-[9px] text-slate-500 -mt-1 px-1">
                                <span>{fmtTime(options[0].departMs)}</span>
                                <span>passage time by departure</span>
                                <span>{fmtTime(options[options.length - 1].departMs)}</span>
                            </div>
                        </div>
                    </div>
                )}

                {/* Options list */}
                <div
                    className="flex-1 min-h-0 overflow-y-auto px-3 pt-2"
                    style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
                >
                    {loading && (
                        <ul className="space-y-2">
                            {Array.from({ length: 5 }, (_, i) => (
                                <li key={i}>
                                    <div className="rounded-xl border border-white/10 bg-white/[0.04] h-[52px] animate-pulse" />
                                </li>
                            ))}
                        </ul>
                    )}
                    {!loading && options.length === 0 && (
                        <div className="px-3 py-12 text-center text-xs text-slate-500">
                            No inshore route to sweep — plan a route first.
                        </div>
                    )}
                    <ul className="space-y-2">
                        {options.map((o, idx) => {
                            const style = STATUS_STYLES[o.status];
                            const isBest = idx === bestIdx;
                            return (
                                <li key={o.departMs}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            triggerHaptic('medium');
                                            setSelectedIdx(idx);
                                            onAccept(o.departMs);
                                        }}
                                        aria-label={`Select departure ${fmtTime(o.departMs)}`}
                                        className={`w-full text-left rounded-xl border ${style.border} ${style.bg} px-3 py-2.5 transition-all hover:bg-white/5 active:scale-[0.98] ${
                                            idx === selectedIdx
                                                ? 'ring-1 ring-sky-400/60'
                                                : isBest
                                                  ? 'ring-1 ring-emerald-400/40'
                                                  : ''
                                        }`}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <span className="text-sm font-bold text-white">
                                                    {fmtTime(o.departMs)}
                                                </span>
                                                <span className="ml-2 text-[11px] text-slate-300">
                                                    {fmtPassage(o.passageMs)} • arrive {fmtTime(o.arriveMs)}
                                                    {o.minUkcM !== null && ` • UKC ${o.minUkcM.toFixed(1)} m`}
                                                </span>
                                            </div>
                                            <div
                                                className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold ${style.bg} ${style.text} border ${style.border}`}
                                            >
                                                {style.label}
                                            </div>
                                        </div>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </OverlayPortal>
    );
};
