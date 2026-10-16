/**
 * leadOverlayData — the chart overlay's data path for the lead graph
 * (inshore router, Phase 1). The I/O half of services/routing/leadCompiler.ts,
 * kept apart so the compiler stays pure.
 *
 * Cheap by construction:
 *   • only NAVIGATION cells already installed on this phone
 *     (cellsForBBox), read with the remote ladder OFF — the overlay never
 *     downloads a chart;
 *   • the same count/byte bound the chart merge uses (capCellsForMerge);
 *   • one compile per cell set, one re-classification per draft and air
 *     draft (cachedLeadGraph) — panning inside the same cells costs a lookup.
 *
 * The cache follows chart CONTENT, not cell ids (Phase 1 review): each cell
 * is keyed by encCellContentIdentity, so a new edition or a same-edition
 * update recompiles instead of drawing the superseded leads. Peek and store
 * use the same key list — every capped cell, including one whose blob would
 * not load — so a missing blob no longer makes every pan reload every blob.
 */
import { encCellContentIdentity } from '../enc/cellContentIdentity';
import { cellsForBBox } from '../enc/EncCellMetadata';
import { loadCellGeoJSON, reserveNoaaResident } from '../enc/EncCellStore';
import { utf8ByteLength } from '../enc/types';
import { capCellsForMerge } from '../enc/mergeCap';
import {
    cachedLeadGraph,
    clearLeadGraphCache,
    LEAD_UKC_M,
    mergeLeadCells,
    peekLeadGraph,
    type LeadCompileOptions,
    type LeadCellInput,
    type LeadGraph,
} from './leadCompiler';
import { noaaGeometryOwner } from '../enc/noaaGeometryOwner';

/** ~2 km around the view, so a lead that starts just off-screen is drawn. */
const PAD_DEG = 0.02;

/** The capped cells under a view, their cache keys, and the cached graph. */
function viewLookup(
    bbox: [number, number, number, number],
    draftM: number,
    draftAssumed: boolean,
    airDraftM: number | null,
) {
    const window: [number, number, number, number] = [
        bbox[0] - PAD_DEG,
        bbox[1] - PAD_DEG,
        bbox[2] + PAD_DEG,
        bbox[3] + PAD_DEG,
    ];
    // Hazard review reaches 60m beyond a span (structures 10m). Retain
    // complete local evidence around every inner edge, including endpoints.
    const dy = 75 / 110_000;
    const dx = dy / Math.max(0.000001, Math.cos((Math.max(Math.abs(window[1]), Math.abs(window[3])) * Math.PI) / 180));
    const readWindow: [number, number, number, number] = [
        window[0] - dx,
        window[1] - dy,
        window[2] + dx,
        window[3] + dy,
    ];
    const haloCells = cellsForBBox(readWindow);
    const hasPackages = haloCells.some((c) => c.noaaPackage);
    const all = hasPackages ? haloCells : cellsForBBox(window);
    const cells = capCellsForMerge(all, hasPackages ? readWindow : window);
    const bounded =
        readWindow.every(Number.isFinite) &&
        readWindow[0] >= -180 &&
        readWindow[2] <= 180 &&
        readWindow[1] >= -90 &&
        readWindow[3] <= 90;
    const complete = !hasPackages || (bounded && cells.length === all.length);
    const keys = cells.map(encCellContentIdentity);
    const classify = { draftAssumed, airDraftM };
    const options: LeadCompileOptions = hasPackages ? { window } : {};
    const hit = !complete || cells.length === 0 ? null : peekLeadGraph(keys, draftM, options, LEAD_UKC_M, classify);
    return { cells, keys, classify, hit, options, window, readWindow, complete };
}

/**
 * The lead graph for a view ONLY if it is already compiled (the same cells,
 * draft and air draft as leadGraphForView), else null — no cell is read and
 * nothing is compiled. For the router's lead shadow (2026-10-01 review): it
 * must cost a route nothing it would not otherwise spend.
 */
export function peekLeadGraphForView(
    bbox: [number, number, number, number],
    draftM: number,
    draftAssumed = false,
    airDraftM: number | null = null,
): LeadGraph | null {
    return viewLookup(bbox, draftM, draftAssumed, airDraftM).hit;
}

/**
 * The lead graph for the installed navigation cells under a map view
 * [west, south, east, north], classified for `draftM`. `draftAssumed`: the
 * draft is a fallback or an onboarding estimate (vesselDraftIsAssumed), so
 * nothing is classed clear. `airDraftM`: the vessel's air draft
 * (vesselAirDraftMetres; null — not set — makes every bridge and overhead
 * line on a lead a clearance reason, Part B). Null when no installed cell
 * covers the view.
 */
export async function leadGraphForView(
    bbox: [number, number, number, number],
    draftM: number,
    draftAssumed = false,
    airDraftM: number | null = null,
    assertCurrent: () => void = () => {},
): Promise<LeadGraph | null> {
    assertCurrent();
    const { cells, keys, classify, hit, options, readWindow, complete } = viewLookup(
        bbox,
        draftM,
        draftAssumed,
        airDraftM,
    );
    if (!complete || cells.length === 0) return null;
    if (hit) return hit;

    let chartView: Awaited<ReturnType<typeof import('../enc/noaaPackageWindow').loadNoaaPackageCohort>> | undefined;
    let derivedLease: ReturnType<typeof reserveNoaaResident> | undefined;
    try {
        const packages = cells.filter((c) => c.noaaPackage);
        if (packages.length) {
            // Admit one new bounded window after discarding cache ownership of
            // old windows. Mounted sources retain their independent references.
            clearLeadGraphCache();
            const { loadNoaaPackageCohort } = await import('../enc/noaaPackageWindow');
            chartView = await loadNoaaPackageCohort(packages, readWindow, assertCurrent, 'leads');
        }
        const inputs: LeadCellInput[] = [];
        for (const cell of cells) {
            // Installed only: no Pi / cloud fetch from a chart overlay.
            const blob = cell.noaaPackage ? chartView?.blobs.get(cell.id) : await loadCellGeoJSON(cell.id, false);
            assertCurrent();
            chartView?.check();
            if (!blob?.layers) {
                if (chartView) throw Error('The complete chart cohort is unavailable for these leads.');
                continue;
            }
            inputs.push({
                id: cell.id,
                bbox: cell.bbox,
                layers: blob.layers as LeadCellInput['layers'],
                // The cell's own scale, the router's rank (round 2, 2026-09-30).
                nativeScale: blob.nativeScale,
                sourceCellId: cell.sourceCellId ?? blob.sourceCellId,
            });
        }
        if (inputs.length === 0) return null;
        const raw = chartView;
        const remaining = 16 * 1024 * 1024 - (raw?.bytes ?? 0);
        if (raw) derivedLease = reserveNoaaResident(remaining);
        const graph = cachedLeadGraph(
            keys,
            draftM,
            () => mergeLeadCells(inputs),
            options,
            LEAD_UKC_M,
            classify,
            raw
                ? (graph) => {
                      raw.check();
                      const bytes = utf8ByteLength(JSON.stringify(graph), remaining);
                      if (bytes > remaining) throw Error('NOAA derived leads exceed the resident view limit.');
                      derivedLease!.resize(bytes);
                      const owner = noaaGeometryOwner(raw.authority, derivedLease!.release);
                      derivedLease = undefined;
                      return owner;
                  }
                : undefined,
        );
        chartView?.check();
        return graph;
    } finally {
        chartView?.release();
        derivedLease?.release();
    }
}
