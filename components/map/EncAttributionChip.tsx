/**
 * EncAttributionChip — viewport-aware ENC source credit.
 *
 * Shows a small chip in the bottom-left of the map listing which
 * hydrographic offices' data the user is currently looking at. IHO
 * standard practice — every chart display has source attribution
 * visible whenever surveyed data is being shown.
 *
 * Visibility rules:
 *  - Hidden when no ENC cells intersect the current viewport.
 *  - Visible whenever at least one cell's bbox crosses the viewport.
 *  - Re-evaluates on every map `moveend` (panning, zooming).
 *  - Re-evaluates on cell-list changes (import / remove).
 *
 * Format: "Charts: AHO ed.4 (2024)" for one source, or
 *         "Charts: AHO, NOAA" for multiple, with a tooltip listing
 *         every cell in detail when the user taps the chip.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

import { getCoverage as getEncCoverage, subscribe as subscribeToEnc } from '../../services/enc/EncHazardService';
import type { EncCatzoc, EncCell } from '../../services/enc/types';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from '../../services/enc/types';

// ── Bbox helpers ──────────────────────────────────────────────────

function viewportIntersectsCellBBox(
    view: { west: number; south: number; east: number; north: number },
    cellBBox: [number, number, number, number],
): boolean {
    const [cMinLon, cMinLat, cMaxLon, cMaxLat] = cellBBox;
    return !(cMaxLon < view.west || cMinLon > view.east || cMaxLat < view.south || cMinLat > view.north);
}

function getViewportBounds(map: mapboxgl.Map): { west: number; south: number; east: number; north: number } {
    const b = map.getBounds();
    if (!b) return { west: -180, south: -90, east: 180, north: 90 };
    return {
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
    };
}

/**
 * Compute the worst CATZOC across cells in view. Returns null if
 * no cells ship M_QUAL data — `null` here means "we don't know,"
 * not "everything's fine."
 */
function worstCatzocInView(cells: EncCell[]): EncCatzoc | null {
    let worst: EncCatzoc | null = null;
    for (const c of cells) {
        if (!c.catzocRange) continue;
        const cellWorst = c.catzocRange[1];
        if (worst === null || cellWorst > worst) worst = cellWorst;
    }
    return worst;
}

/**
 * Pick a UI tone for a CATZOC bucket. We map to coloured pills in
 * the chip — emerald for high confidence (A1/A2), sky for B,
 * amber for C/D/U, gray when M_QUAL missing entirely.
 */
function catzocTone(c: EncCatzoc | null): { dot: string; text: string; label: string } {
    if (c === null) return { dot: 'bg-gray-500', text: 'text-gray-300/70', label: 'no CATZOC' };
    if (c <= 2) return { dot: 'bg-emerald-400', text: 'text-emerald-300', label: `CATZOC ${CATZOC_LABELS[c]}` };
    if (c === 3) return { dot: 'bg-sky-400', text: 'text-sky-300', label: `CATZOC ${CATZOC_LABELS[c]}` };
    return {
        dot: 'bg-amber-400',
        text: 'text-amber-300',
        label: `CATZOC ${CATZOC_LABELS[c]} — verify visually`,
    };
}

/**
 * Group cells by source HO and find the latest issue date in each
 * group. Used for the compact chip label.
 */
function summariseSources(cells: EncCell[]): { ho: string; latestIssued: string; count: number }[] {
    const groups = new Map<string, { ho: string; latestIssued: string; count: number }>();
    for (const c of cells) {
        const existing = groups.get(c.sourceHO);
        if (!existing) {
            groups.set(c.sourceHO, { ho: c.sourceHO, latestIssued: c.issued, count: 1 });
            continue;
        }
        existing.count++;
        if (c.issued > existing.latestIssued) existing.latestIssued = c.issued;
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

// ── Component ──────────────────────────────────────────────────────

interface EncAttributionChipProps {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
}

export const EncAttributionChip: React.FC<EncAttributionChipProps> = ({ mapRef, mapReady }) => {
    const [cellsInView, setCellsInView] = useState<EncCell[]>([]);
    const [expanded, setExpanded] = useState(false);

    const recompute = useCallback(() => {
        const map = mapRef.current;
        if (!map) {
            setCellsInView([]);
            return;
        }
        const all = getEncCoverage();
        if (all.length === 0) {
            setCellsInView([]);
            return;
        }
        const view = getViewportBounds(map);
        setCellsInView(all.filter((c) => viewportIntersectsCellBBox(view, c.bbox)));
    }, [mapRef]);

    // Recompute on map move + zoom.
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        if (!map) return;
        const handler = (): void => recompute();
        map.on('moveend', handler);
        map.on('zoomend', handler);
        // Initial check in case some cells already intersect.
        recompute();
        return () => {
            map.off('moveend', handler);
            map.off('zoomend', handler);
        };
    }, [mapRef, mapReady, recompute]);

    // Recompute on cell list changes.
    useEffect(() => {
        return subscribeToEnc(() => recompute());
    }, [recompute]);

    if (cellsInView.length === 0) return null;

    // Freshly-registered cloud cells carry a placeholder identity
    // (sourceHO 'cloud', ed.0, no issue date) until their blob lands —
    // the trust chip must never present "cloud ed.0 ()" as provenance
    // (2026-07-12 audit). Real cells drive the label; edition/year come
    // from a cell of the SAME HO as the label (they used to be paired
    // from whichever cell happened to be first in view).
    const hydratedInView = cellsInView.filter((c) => c.sourceHO !== 'cloud' && c.edition > 0 && c.issued);
    const sources = summariseSources(hydratedInView.length > 0 ? hydratedInView : cellsInView);
    let compactLabel: string;
    if (hydratedInView.length === 0) {
        compactLabel = 'downloading…';
    } else if (sources.length === 1) {
        const exemplar = hydratedInView.find((c) => c.sourceHO === sources[0].ho) ?? hydratedInView[0];
        compactLabel = `${sources[0].ho} ed.${exemplar.edition} (${exemplar.issued.slice(0, 4)})`;
    } else {
        compactLabel = sources.map((s) => s.ho).join(', ');
    }
    const worstCatzoc = worstCatzocInView(cellsInView);
    const tone = catzocTone(worstCatzoc);

    return (
        <div
            className="absolute right-2 bottom-2 z-[140] pointer-events-auto max-w-[280px]"
            role="contentinfo"
            aria-label="ENC chart attribution"
        >
            <button
                onClick={() => setExpanded((x) => !x)}
                className="rounded-lg border border-emerald-400/30 bg-black/60 backdrop-blur-sm px-2 py-1 text-[10px] leading-tight text-emerald-100/85 hover:bg-black/75 transition-colors text-right flex items-center gap-1.5"
            >
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} aria-hidden="true" />
                <span className="font-bold text-emerald-300">{'⚓'} Charts:</span>
                <span>{compactLabel}</span>
                {cellsInView.length > 1 && (
                    <span className="text-emerald-300/70 ml-1">· {cellsInView.length} cells</span>
                )}
            </button>

            {expanded && (
                <div className="mt-1 rounded-lg border border-emerald-400/20 bg-black/80 backdrop-blur-sm px-2 py-2 text-[10px] leading-snug text-emerald-100/80 max-h-[40vh] overflow-y-auto">
                    <p className="mb-1 text-[9px] uppercase tracking-wider text-emerald-300/60">In view</p>
                    {cellsInView.map((cell) => (
                        <div key={cell.id} className="mb-1 last:mb-0">
                            <span className="font-mono text-emerald-200">{cell.id}</span>
                            <span className="text-emerald-300/70">
                                {cell.sourceHO === 'cloud'
                                    ? ' · downloading…'
                                    : ` · ${cell.sourceHO} ed.${cell.edition} · ${cell.issued.slice(0, 7)}`}
                            </span>
                            {cell.catzocRange && (
                                <span
                                    className={`ml-1 ${isLowConfidenceCatzoc(cell.catzocRange[1]) ? 'text-amber-300' : 'text-emerald-300/70'}`}
                                >
                                    · CATZOC {CATZOC_LABELS[cell.catzocRange[0]]}
                                    {cell.catzocRange[0] !== cell.catzocRange[1] &&
                                        `..${CATZOC_LABELS[cell.catzocRange[1]]}`}
                                </span>
                            )}
                        </div>
                    ))}
                    <p className={`mt-2 text-[10px] ${tone.text}`}>
                        <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${tone.dot}`} />
                        Worst confidence in view: {tone.label}
                    </p>
                    <p className="mt-1 text-[9px] text-emerald-300/50 italic">
                        Source: hydrographic offices. Verify visually before navigation.
                    </p>
                </div>
            )}
        </div>
    );
};

export default EncAttributionChip;
