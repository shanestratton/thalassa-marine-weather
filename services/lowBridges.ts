/**
 * lowBridges — curated fixed-bridge clearances for air-draft route gating.
 *
 * The BUNDLED `public/notices/bridges-au.json` (hand-curated from OSM bridge
 * ways; clearances marked `estimated` until surveyed), seeded with the
 * Newport canal-estate road crossings (Griffith Rd / Klingner Rd / Dalton
 * St). Since Part B (2026-09-30) it is an EXTRA source beside the chart's own
 * S-57 BRIDGE / CBLOHD / PIPOHD / CONVYR, and both go through ONE verdict:
 * services/routing/overheadClearance.ts (clearanceBlock).
 *
 * SAFETY SEMANTICS (owner decisions 2026-09-29/30): a bridge the vessel
 * cannot clear is LAND for that vessel — clearance below air draft + 1 m, a
 * NULL or estimated clearance (unknown never passes), or NO AIR DRAFT SET
 * (nothing can be checked, so every bridge blocks). The orchestrator turns
 * each blocked bridge into thin `_class: 'low-clearance'` OBSTRN bars across
 * the waterway (overheadClearance.curatedClearanceBars); the grid hard-blocks
 * them, every rescue/carve pass refuses to tunnel them, the canal centre-line
 * network is severed across them, and a final route that still passes under
 * one is refused with the bridge named.
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('lowBridges');

export interface LowBridge {
    id: string;
    name: string;
    /** Charted/estimated vertical clearance (m). NULL = no published
     *  value exists — the bridge still DISPLAYS (position is real), and for
     *  routing it BLOCKS (owner decision: unknown clearance blocks; a number
     *  is never invented either way). */
    clearanceM: number | null;
    /** True until the clearance is verified against a survey/chart value. */
    estimated?: boolean;
    /** The bridge deck line across the waterway — [lon, lat] pairs. */
    span: [number, number][];
}

let cache: LowBridge[] | null = null;
let inflight: Promise<LowBridge[]> | null = null;

/** Load the bundled bridge set (cached for the session). Fail-quiet: []. */
export async function loadLowBridges(): Promise<LowBridge[]> {
    if (cache) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const res = await fetch('/notices/bridges-au.json');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { bridges?: LowBridge[] };
            cache = (data.bridges ?? [])
                .filter((b) => Array.isArray(b.span) && b.span.length >= 2)
                .map((b) => ({ ...b, clearanceM: Number.isFinite(b.clearanceM) ? b.clearanceM : null }));
            log.warn(`[lowBridges] loaded ${cache.length} curated bridge(s)`);
            return cache;
        } catch (err) {
            log.warn(`[lowBridges] bridge data unavailable: ${err instanceof Error ? err.message : String(err)}`);
            cache = [];
            return cache;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

// bridgeBarPolygon and blockedBridgesFor went in the fix-up (2026-09-30): no
// production caller since Part B — the router and the tracer build curated
// bars through overheadClearance.curatedClearanceBars, one verdict for chart
// and curated bridges alike (its tests cover what blockedBridgesFor did).
