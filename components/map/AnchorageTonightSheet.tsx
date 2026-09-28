/**
 * AnchorageTonightSheet — "which anchorage tonight, and why", ranked.
 *
 * Mounted while the Anchorages overlay is on. A small pill offers the
 * question; the sheet answers it: every anchorage within 50 NM of the
 * centre (the location box / the boat), scored by its baked shelter tables
 * against tonight's hourly wind + swell, worst hour dominating. Marinas are
 * excluded — all-weather by construction, and ranking them against bays on
 * fetch would flatter concrete.
 *
 * Wording contract (chart safety): grades and reasons are ADVISORY reads of
 * open data + forecast. The sheet always carries the verify-yourself line
 * and the data attribution (OSM ODbL / GBRMPA CC BY / Open-Meteo) — the
 * licences require it and the skipper deserves it.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { AnchorageService } from '../../services/anchorages/AnchorageService';
import { cachedPlaceConditions, loadPlaceConditions } from '../../services/anchorages/PlaceConditionsService';
import {
    CONDITION_COLOURS,
    CONDITION_LABELS,
    distanceNM,
    type PlaceConditions,
} from '../../services/anchorages/placeConditions';
import { conditionsPlaceForAnchorage } from './useAnchorageLayer';
import { triggerHaptic } from '../../utils/system';

interface RankedRow extends PlaceConditions {
    id: string;
    name: string;
    distanceNM: number;
}

export const AnchorageTonightSheet: React.FC<{
    visible: boolean;
    centre: { lat: number; lon: number } | null;
    /** Fly the chart to an anchorage and open its verdict popup (the layer's
     *  imperative handle). Returns false when the layer can't show it. */
    onShow?: (id: string) => boolean;
}> = ({ visible, centre, onShow }) => {
    const [open, setOpen] = useState(false);
    const [rows, setRows] = useState<RankedRow[] | null>(null);
    const [state, setState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle');
    const [revision, setRevision] = useState(0);
    const titleId = useId();
    const closeRef = useRef<HTMLButtonElement>(null);
    const close = useCallback(() => setOpen(false), []);
    // The shared dialog trap every other sheet has (UX scorecard run 9: this
    // was the one role=dialog without it): focus moves in to Close, Tab stays
    // inside, and Escape closes it.
    const dialogRef = useFocusTrap<HTMLDivElement>(open && visible && !!centre, {
        initialFocusRef: closeRef,
        onEscape: close,
    });
    useEffect(() => {
        if (!open) return;
        const refresh = () => setRevision((r) => r + 1);
        const timer = setInterval(refresh, 60_000);
        window.addEventListener('offline', refresh);
        window.addEventListener('online', refresh);
        return () => {
            clearInterval(timer);
            window.removeEventListener('offline', refresh);
            window.removeEventListener('online', refresh);
        };
    }, [open]);

    useEffect(() => {
        if (!visible) setOpen(false);
    }, [visible]);

    useEffect(() => {
        if (!open || !centre) return;
        let cancelled = false;
        setState('loading');
        // Clear the previous centre's ranking — it used to sit under "Reading
        // tonight's conditions…" for the new one (audit 2026-09-02).
        setRows(null);
        (async () => {
            try {
                const data = await AnchorageService.loadNear(centre.lat, centre.lon, 50);
                if (cancelled) return;
                const candidates = data.points.features
                    .filter((f) => {
                        const p = f.properties;
                        return p.kind !== 'marina' && p.likelyAnchorage !== false && p.fetchLandNM && p.fetchReefNM;
                    })
                    .map((f) => ({
                        ...conditionsPlaceForAnchorage(f),
                        name: f.properties.name,
                        distanceNM: distanceNM(centre, {
                            lat: f.geometry.coordinates[1],
                            lon: f.geometry.coordinates[0],
                        }),
                    }))
                    .filter((p) => p.distanceNM <= 50)
                    .sort((a, b) => a.distanceNM - b.distanceNM)
                    .slice(0, 24);
                if (candidates.length === 0) {
                    setState('empty');
                    setRows(null);
                    return;
                }
                await loadPlaceConditions(candidates);
                if (cancelled) return;
                const order = { green: 0, amber: 1, unknown: 2, red: 3 };
                const ranked = candidates
                    .map((c) => ({ id: c.id, name: c.name, distanceNM: c.distanceNM, ...cachedPlaceConditions(c) }))
                    .sort((a, b) => order[a.light] - order[b.light] || a.distanceNM - b.distanceNM);
                if (ranked.length === 0) {
                    setState('empty');
                    setRows(null);
                    return;
                }
                setRows(ranked.slice(0, 8));
                setState('idle');
            } catch {
                if (!cancelled) setState('error');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, centre, revision]);

    if (!visible || !centre) return null;

    return (
        <>
            {!open && (
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setOpen(true);
                    }}
                    // Geometry in index.css (.thalassa-anchorage-chip): it rides
                    // directly above the chart's layer pill, which the Anchorages
                    // layer always brings with it. At a fixed 8.5rem it lay over
                    // the pill (and, in short landscape, the zoom rail) once the
                    // pill stepped up clear of the Mapbox wordmark. Absolute, in
                    // the pill's own containing block, so a split pane keeps it
                    // in the chart. 44px tall: the app's touch-target floor.
                    className="thalassa-anchorage-chip absolute z-720 inline-flex min-h-[44px] items-center justify-center gap-1 px-3 py-2 bg-slate-800/95 border border-cyan-500/30 rounded-full text-cyan-300 text-xs font-black uppercase tracking-widest shadow-xl shadow-black/40 active:scale-95 transition-all"
                    aria-label="Compare anchorages for the next 12 hours"
                >
                    <span aria-hidden>⚓</span>
                    <span className="thalassa-anchorage-chip-text">Next 12 hours</span>
                </button>
            )}
            {open && (
                <div
                    ref={dialogRef}
                    // The chart's modal-sheet tier (10050+, as TraceReportModal),
                    // above the helm (10020): at z-730 MOB and the layers button
                    // painted over the sheet, and MOB lay across its Close button.
                    className="fixed inset-0 z-10050 flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                >
                    <div className="absolute inset-0 bg-black/50" onClick={close} />
                    {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
                    <div className="relative w-full max-w-md bg-slate-900 border border-cyan-500/20 rounded-2xl shadow-2xl max-h-full flex flex-col">
                        <div className="flex items-center justify-between px-4 pt-3 pb-2">
                            <h2 id={titleId} className="text-sm font-bold text-white">
                                <span aria-hidden>⚓ </span>Where to stop · next 12 hours
                            </h2>
                            <button
                                ref={closeRef}
                                type="button"
                                onClick={close}
                                className="min-h-[44px] min-w-[44px] px-3 py-1 text-slate-300 text-sm font-bold active:scale-95"
                            >
                                Close
                            </button>
                        </div>
                        <div className="overflow-y-auto px-4 pb-3">
                            {state === 'loading' && (
                                <div className="py-6 text-center text-xs text-gray-400">
                                    Reading tonight's conditions…
                                </div>
                            )}
                            {state === 'error' && (
                                <div className="py-6 text-center text-xs text-gray-400">
                                    Couldn't load anchorages or forecast — try again with signal.
                                </div>
                            )}
                            {state === 'empty' && (
                                <div className="py-6 text-center text-xs text-gray-400">
                                    No charted anchorages within 50 NM of the location box.
                                </div>
                            )}
                            {rows?.map((r, i) => {
                                return (
                                    <button
                                        key={r.id}
                                        onClick={() => {
                                            triggerHaptic('light');
                                            // Put the pick on the chart; the sheet
                                            // yields the screen to the bay itself.
                                            if (onShow?.(r.id)) setOpen(false);
                                        }}
                                        className="block w-full text-left py-2.5 border-b border-white/5 last:border-b-0 active:bg-white/5 transition-colors"
                                        aria-label={`Show ${r.name} on the chart`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-gray-500 text-xs font-black w-4">{i + 1}</span>
                                            <span className="text-white text-sm font-bold flex-1 truncate">
                                                {r.name}
                                            </span>
                                            <span
                                                className="px-2 py-0.5 rounded-full text-xs font-bold"
                                                style={{ color: CONDITION_COLOURS[r.light] }}
                                            >
                                                ● {CONDITION_LABELS[r.light]}
                                            </span>
                                            <span className="text-gray-600 text-base leading-none" aria-hidden>
                                                ›
                                            </span>
                                        </div>
                                        <div className="pl-6 mt-1 text-xs text-gray-400 leading-snug">
                                            <span className="text-gray-500">{r.distanceNM.toFixed(1)} NM · </span>
                                            {r.reasons.slice(0, 2).join(' · ')}
                                        </div>
                                    </button>
                                );
                            })}
                            {rows && (
                                <div className="pt-3 text-xs text-gray-400 leading-relaxed">
                                    Comparing up to 24 nearby mapped anchorages within 50 NM. Weather/shelter advisory,
                                    not clearance. Check warnings, tide/depth, holding and swing room. Missing data
                                    stays unassessed. Data: © OpenStreetMap contributors (ODbL), © GBRMPA (CC BY).
                                    Forecast: Open-Meteo / national weather services.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
