/**
 * EncAttributionChip — viewport-aware ENC source credit.
 *
 * Shows renderer lifecycle separately from the available source inventory.
 * Bbox-intersecting imports are NOT a count of painted charts or route
 * coverage: scale selection, memory caps and missing local blobs can all
 * make those counts differ. The source drawer preserves raw import identity.
 *
 * Visibility rules:
 *  - Hidden when no ENC cells intersect the current viewport.
 *  - Visible whenever at least one cell's bbox crosses the viewport.
 *  - Re-evaluates on every map `moveend` (panning, zooming).
 *  - Re-evaluates on cell-list changes (import / remove).
 *
 * Format: "ENC: AHO ed.4 (2024)" for one source, or
 *         "ENC: AHO, NOAA" for multiple, with a tooltip listing
 *         every cell in detail when the user taps the chip.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

import { chartAgeLabel, chartAgeYears, isChartStale } from '../../services/enc/chartCurrency';
import { getDisplayCoverage, subscribe as subscribeToEnc } from '../../services/enc/EncHazardService';
import type { EncCatzoc, EncCell } from '../../services/enc/types';
import { CATZOC_LABELS, isLowConfidenceCatzoc } from '../../services/enc/types';
import { EMPTY_ENC_DISPLAY, getEncDisplayState, subscribeEncDisplay } from './encDisplayState';

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
    /** Compact maps have their own controls below the chart, not over it. */
    bottom?: number;
}

export const EncAttributionChip: React.FC<EncAttributionChipProps> = ({ mapRef, mapReady, bottom }) => {
    const [cellsInView, setCellsInView] = useState<EncCell[]>([]);
    const [expanded, setExpanded] = useState(false);
    const [display, setDisplay] = useState(EMPTY_ENC_DISPLAY);

    const recompute = useCallback(() => {
        const map = mapRef.current;
        if (!map) {
            setCellsInView([]);
            return;
        }
        // Attribute everything the renderer can paint, but never let an
        // unsigned library overlay inherit the authority of an ENC cell.
        // Previously reference-only water had no source chip at all.
        const all = getDisplayCoverage();
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

    useEffect(() => {
        const map = mapRef.current;
        if (!mapReady || !map) return;
        const update = () => setDisplay(getEncDisplayState(map));
        update();
        return subscribeEncDisplay(map, update);
    }, [mapRef, mapReady]);

    if (cellsInView.length === 0) return null;

    const navigationInView = cellsInView.filter((cell) => cell.usage !== 'reference');
    const referenceInView = cellsInView.filter((cell) => cell.usage === 'reference');
    const referenceOnly = navigationInView.length === 0;
    // Keep the compact source/edition/confidence about the navigation data
    // when both authorities overlap. The extra reference layer is identified
    // separately, not combined into a stronger-looking source summary.
    const attributedCells = referenceOnly ? referenceInView : navigationInView;

    // Freshly-registered cloud cells carry a placeholder identity
    // (sourceHO 'cloud', ed.0, no issue date) until their blob lands —
    // the trust chip must never present "cloud ed.0 ()" as provenance
    // (2026-07-12 audit). Real cells drive the label; edition/year come
    // from a cell of the SAME HO as the label (they used to be paired
    // from whichever cell happened to be first in view).
    const hydratedInView = attributedCells.filter((c) => c.sourceHO !== 'cloud' && c.edition > 0 && c.issued);
    const sources = summariseSources(hydratedInView.length > 0 ? hydratedInView : attributedCells);
    let compactLabel: string;
    if (hydratedInView.length === 0) {
        compactLabel = 'downloading…';
    } else if (sources.length === 1) {
        const exemplar = hydratedInView.find((c) => c.sourceHO === sources[0].ho) ?? hydratedInView[0];
        compactLabel = `${sources[0].ho} ed.${exemplar.edition} (${exemplar.issued.slice(0, 4)})`;
    } else {
        compactLabel = sources.map((s) => s.ho).join(', ');
    }
    // Chart CURRENCY (mission audit): CATZOC is survey QUALITY, not age — a
    // decade-old edition wore the same emerald dot as this year's. Fold the
    // latest-edition age into the dot: an old edition is a caution to verify
    // Notices to Mariners even at high CATZOC.
    const latestIssued = hydratedInView.reduce<string | null>(
        (m, c) => (m === null || c.issued > m ? c.issued : m),
        null,
    );
    const ageYears = chartAgeYears(latestIssued, Date.now());
    const stale = isChartStale(ageYears);
    const ageLabel = chartAgeLabel(ageYears);
    const worstCatzoc = worstCatzocInView(navigationInView);
    const catTone = catzocTone(worstCatzoc);
    // The emerald frame reads as "trust green" — drop it whenever the data
    // behind it isn't trustworthy (stale edition or low/no CATZOC) — audit #5.
    const frameCaution =
        display.phase !== 'loaded' || display.overview || referenceOnly || stale || isLowConfidenceCatzoc(worstCatzoc);
    const displayLabel =
        display.phase === 'loaded'
            ? `${display.overview ? 'Overview · ' : ''}${display.loadedCells} loaded`
            : display.phase === 'loading'
              ? 'loading chart…'
              : display.phase === 'off'
                ? 'display off'
                : display.phase === 'zoom-in'
                  ? 'zoom in for charts'
                  : 'chart unavailable at this view';
    const tone = stale
        ? {
              dot: 'bg-amber-400',
              text: 'text-amber-300',
              label: `${catTone.label} · edition ~${ageLabel} old — verify updates`,
          }
        : catTone;

    return (
        <div
            // bottom-2 put this 8px above the viewport bottom — underneath the
            // app's bottom nav, which is fixed, opaque and z-900 against this
            // chip's z-[140]. Not clipped: UNTAPPABLE. The tap that expands it
            // never landed, so the chart source, the cell count, the worst-CATZOC
            // low-confidence warning, the edition-age caution and the "verify
            // visually before navigation" caveat were all unreachable — chart
            // safety information, invisible on the navigation surface.
            //
            // Parked in the free right-edge band instead: above MapActionFabs
            // (80px + inset, 48px tall, so clear of 128px) and below
            // ChartKeyPanel (bottom-44 = 176px). Deliberately NOT
            // calc(64px + inset + 8px) — the full-width chart furniture band
            // at z-500 sits there, and it would re-hide this chip.
            className="absolute right-2 z-140 pointer-events-auto max-w-[280px]"
            // Above the Mapbox ⓘ + scale stack, lifted to 4rem + 73px (≈ 137–193px
            // above the inset) to clear the Locate fab on 2026-09-06.
            style={{
                bottom: bottom ?? 'calc(env(safe-area-inset-bottom) + 204px)',
                maxWidth: 'min(280px, calc(100% - 16px))',
            }}
            role="contentinfo"
            aria-label="ENC chart attribution"
        >
            <button
                onClick={() => setExpanded((x) => !x)}
                aria-expanded={expanded}
                className={`hit-target-44 rounded-lg border ${frameCaution ? 'border-amber-400/40' : 'border-emerald-400/30'} bg-black/75 backdrop-blur-xs px-2 py-1 text-[11px] leading-tight text-emerald-100/85 hover:bg-black/75 transition-colors text-right flex items-center gap-1.5`}
            >
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} aria-hidden="true" />
                <span className={`font-bold ${frameCaution ? 'text-amber-300' : 'text-emerald-300'}`}>
                    {'⚓'} {referenceOnly ? 'Reference:' : 'ENC:'}{' '}
                </span>
                <span>{displayLabel}</span>
                {referenceOnly && <span className="text-amber-300">· display only</span>}
                {stale && (
                    <span
                        className="ml-1 font-bold text-amber-300"
                        title={`Chart edition ~${ageLabel} old — verify Notices to Mariners before navigation`}
                    >
                        · ⚠ {ageLabel}
                    </span>
                )}
            </button>

            {expanded && (
                <div className="mt-1 rounded-lg border border-emerald-400/20 bg-black/80 backdrop-blur-xs px-2 py-2 text-[11px] leading-snug text-emerald-100/80 max-h-[40vh] overflow-y-auto">
                    <p className="mb-1 text-[11px] uppercase tracking-wider text-emerald-300/75">
                        Available imports · {cellsInView.length} cells
                    </p>
                    <p className="mb-2">
                        {compactLabel}
                        {!referenceOnly && referenceInView.length > 0 ? ` · ${referenceInView.length} reference` : ''}
                    </p>
                    <p className="mb-2 text-amber-200">
                        {display.overview ? 'Passage overview — zoom in for chart detail. ' : ''}
                        Imported and loaded counts are not rendered coverage. Chart gaps and scale-dependent detail
                        remain; check each leg close up.
                    </p>
                    {cellsInView.map((cell) => (
                        <div key={cell.id} className="mb-1 last:mb-0">
                            <span className="font-mono text-emerald-200">{cell.id}</span>
                            {cell.usage === 'reference' && (
                                <span className="text-amber-300"> · reference only — not navigation coverage</span>
                            )}
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
                    {!referenceOnly && (
                        <p className={`mt-2 text-[11px] ${tone.text}`}>
                            <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle ${tone.dot}`} />
                            Available ENC confidence: {tone.label}
                        </p>
                    )}
                    {ageLabel && (
                        <p className={`mt-1 text-[11px] ${stale ? 'text-amber-300' : 'text-emerald-300/75'}`}>
                            Latest edition ~{ageLabel} old
                            {stale ? ' — verify Notices to Mariners' : ''}.
                        </p>
                    )}
                    <p className="mt-1 text-[11px] text-emerald-300/70 italic">
                        {referenceOnly
                            ? 'Reference display only. These imports do not establish charted navigation coverage.'
                            : 'Imported ENC layers, rendered by Thalassa. Basemap and reference layers do not establish charted navigation coverage.'}{' '}
                        Check source, chart updates and local conditions before navigation.
                    </p>
                </div>
            )}
        </div>
    );
};

export default EncAttributionChip;
