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
import React, { useEffect, useState } from 'react';
import { AnchorageService } from '../../services/anchorages/AnchorageService';
import { getStayWindowCached } from '../../services/anchorages/anchorageForecast';
import {
    rankAnchorages,
    type AnchorageForVerdict,
    type AnchorageVerdict,
} from '../../services/anchorages/anchorageVerdict';
import { triggerHaptic } from '../../utils/system';

const GRADE_CHIP: Record<AnchorageVerdict['grade'], { label: string; cls: string }> = {
    bombproof: { label: 'BOMBPROOF', cls: 'bg-emerald-500/20 text-emerald-300' },
    good: { label: 'GOOD', cls: 'bg-teal-500/20 text-teal-300' },
    tenable: { label: 'TENABLE', cls: 'bg-amber-500/20 text-amber-300' },
    poor: { label: 'POOR', cls: 'bg-red-500/20 text-red-300' },
    'no-anchoring': { label: 'NO ANCHOR', cls: 'bg-red-500/30 text-red-200' },
};

interface RankedRow extends AnchorageVerdict {
    distanceNM: number;
}

function rowsFor(
    centre: { lat: number; lon: number },
    verdicts: AnchorageVerdict[],
    byId: Map<string, AnchorageForVerdict>,
): RankedRow[] {
    return verdicts.map((v) => {
        const a = byId.get(v.id);
        const distanceNM = a
            ? Math.hypot((a.lat - centre.lat) * 60, (a.lon - centre.lon) * 60 * Math.cos((centre.lat * Math.PI) / 180))
            : 0;
        return { ...v, distanceNM };
    });
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
    const [swellUnknown, setSwellUnknown] = useState(false);

    useEffect(() => {
        if (!visible) setOpen(false);
    }, [visible]);

    useEffect(() => {
        if (!open || !centre) return;
        let cancelled = false;
        setState('loading');
        (async () => {
            try {
                const [data, hours] = await Promise.all([
                    AnchorageService.loadNear(centre.lat, centre.lon, 50),
                    getStayWindowCached(centre.lat, centre.lon),
                ]);
                if (cancelled) return;
                const candidates: AnchorageForVerdict[] = data.points.features
                    .filter((f) => {
                        const p = f.properties;
                        return p.kind !== 'marina' && p.likelyAnchorage !== false && p.fetchLandNM && p.fetchReefNM;
                    })
                    .map((f) => ({
                        id: f.properties.id,
                        name: f.properties.name,
                        kind: f.properties.kind,
                        lat: f.geometry.coordinates[1],
                        lon: f.geometry.coordinates[0],
                        fetchLandNM: f.properties.fetchLandNM as number[],
                        fetchReefNM: f.properties.fetchReefNM as number[],
                        noAnchoring: f.properties.noAnchoring,
                        noAnchoringName: f.properties.noAnchoringName,
                    }));
                if (candidates.length === 0) {
                    setState('empty');
                    setRows(null);
                    return;
                }
                const verdicts = rankAnchorages(candidates, hours ?? []);
                const byId = new Map(candidates.map((c) => [c.id, c]));
                // Tiles load whole; the PROMISE is 50 NM — hold the sheet to
                // it, and break same-score ties by distance (the closer of
                // two equally bombproof bays wins the night).
                const ranked = rowsFor(centre, verdicts, byId)
                    .filter((r) => r.distanceNM <= 50)
                    .sort(
                        (a, b) =>
                            (a.grade === 'no-anchoring' ? 1 : 0) - (b.grade === 'no-anchoring' ? 1 : 0) ||
                            b.score - a.score ||
                            a.distanceNM - b.distanceNM,
                    );
                if (ranked.length === 0) {
                    setState('empty');
                    setRows(null);
                    return;
                }
                setRows(ranked.slice(0, 8));
                setSwellUnknown(verdicts.some((v) => v.swellUnknown));
                setState('idle');
            } catch {
                if (!cancelled) setState('error');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, centre]);

    if (!visible || !centre) return null;

    return (
        <>
            {!open && (
                <button
                    onClick={() => {
                        triggerHaptic('light');
                        setOpen(true);
                    }}
                    className="fixed left-3 z-[720] px-3 py-2 bg-slate-800/95 border border-cyan-500/30 rounded-full text-cyan-300 text-xs font-black uppercase tracking-widest shadow-xl shadow-black/40 active:scale-95 transition-all"
                    style={{ bottom: 'calc(8.5rem + env(safe-area-inset-bottom))' }}
                    aria-label="Rank anchorages for tonight"
                >
                    <span aria-hidden>⚓ </span>Tonight?
                </button>
            )}
            {open && (
                <div
                    className="fixed inset-0 z-[730] flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
                    role="dialog"
                    aria-label="Anchorages tonight"
                >
                    <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
                    {/* Centred per the standing modal rule (Shane 2026-09-02: "all modal boxes centered on the punters screen"). */}
                    <div className="relative w-full max-w-md bg-slate-900 border border-cyan-500/20 rounded-2xl shadow-2xl max-h-full flex flex-col">
                        <div className="flex items-center justify-between px-4 pt-3 pb-2">
                            <div className="text-sm font-bold text-white">
                                <span aria-hidden>⚓ </span>Where tonight?
                            </div>
                            <button
                                onClick={() => setOpen(false)}
                                className="px-3 py-1 text-gray-400 text-xs font-black uppercase tracking-widest active:scale-95"
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
                                const chip = GRADE_CHIP[r.grade];
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
                                                className={`px-2 py-0.5 rounded-full text-[10px] font-black tracking-wider ${chip.cls}`}
                                            >
                                                {chip.label}
                                            </span>
                                            <span className="text-gray-600 text-base leading-none" aria-hidden>
                                                ›
                                            </span>
                                        </div>
                                        <div className="pl-6 mt-1 text-[11px] text-gray-400 leading-snug">
                                            <span className="text-gray-500">{r.distanceNM.toFixed(1)} NM · </span>
                                            {r.reasons.slice(0, 2).join(' · ')}
                                        </div>
                                    </button>
                                );
                            })}
                            {rows && (
                                <div className="pt-3 text-[9px] text-gray-500 leading-relaxed">
                                    {swellUnknown && 'Swell data unavailable — roll unassessed. '}
                                    Advisory only — verify against official charts, the pilot and your own eyes before
                                    anchoring. Data: © OpenStreetMap contributors (ODbL), © GBRMPA (CC BY). Forecast:
                                    Open-Meteo.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
