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
 *   • one compile per cell set, one re-classification per draft
 *     (cachedLeadGraph) — panning inside the same cells costs a lookup.
 *
 * The cache follows chart CONTENT, not cell ids (Phase 1 review): each cell
 * is keyed by encCellContentIdentity, so a new edition or a same-edition
 * update recompiles instead of drawing the superseded leads. Peek and store
 * use the same key list — every capped cell, including one whose blob would
 * not load — so a missing blob no longer makes every pan reload every blob.
 */
import { encCellContentIdentity } from '../enc/cellContentIdentity';
import { cellsForBBox } from '../enc/EncCellMetadata';
import { loadCellGeoJSON } from '../enc/EncCellStore';
import { capCellsForMerge } from '../enc/mergeCap';
import {
    cachedLeadGraph,
    LEAD_UKC_M,
    mergeLeadCells,
    peekLeadGraph,
    type LeadCellInput,
    type LeadGraph,
} from './leadCompiler';

/** ~2 km around the view, so a lead that starts just off-screen is drawn. */
const PAD_DEG = 0.02;

/**
 * The lead graph for the installed navigation cells under a map view
 * [west, south, east, north], classified for `draftM`. `draftAssumed`: the
 * draft is a fallback or an onboarding estimate (vesselDraftIsAssumed), so
 * nothing is classed clear. Null when no installed cell covers the view.
 */
export async function leadGraphForView(
    bbox: [number, number, number, number],
    draftM: number,
    draftAssumed = false,
): Promise<LeadGraph | null> {
    const window: [number, number, number, number] = [
        bbox[0] - PAD_DEG,
        bbox[1] - PAD_DEG,
        bbox[2] + PAD_DEG,
        bbox[3] + PAD_DEG,
    ];
    const cells = capCellsForMerge(cellsForBBox(window), window);
    if (cells.length === 0) return null;
    const keys = cells.map(encCellContentIdentity);
    const classify = { draftAssumed };
    const hit = peekLeadGraph(keys, draftM, {}, LEAD_UKC_M, classify);
    if (hit) return hit;

    const inputs: LeadCellInput[] = [];
    for (const cell of cells) {
        // Installed only: no Pi / cloud fetch from a chart overlay.
        const blob = await loadCellGeoJSON(cell.id, false);
        if (!blob?.layers) continue;
        inputs.push({ id: cell.id, bbox: cell.bbox, layers: blob.layers as LeadCellInput['layers'] });
    }
    if (inputs.length === 0) return null;
    return cachedLeadGraph(keys, draftM, () => mergeLeadCells(inputs), {}, LEAD_UKC_M, classify);
}
