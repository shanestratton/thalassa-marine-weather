/**
 * lowBridges — curated fixed-bridge clearances for air-draft route gating.
 *
 * v1 data is the BUNDLED `public/notices/bridges-au.json` (hand-curated from
 * OSM bridge ways; clearances marked `estimated` until surveyed). Seeded with
 * the Newport canal-estate road crossings (Griffith Rd / Klingner Rd / Dalton
 * St) — fixed low bridges no sailboat clears. Phase 2 sources: S-57 BRIDGE +
 * VERCLR via the SENC extractor, OSM maxheight via the Pi Overpass query.
 *
 * SAFETY SEMANTICS: a bridge the vessel cannot clear is LAND for that vessel.
 * The orchestrator turns each blocked bridge into a thin `_class:
 * 'low-clearance'` OBSTRN polygon across the waterway; the grid hard-blocks
 * it, every rescue/carve pass refuses to tunnel it, and the canal centre-line
 * network is severed across it. No clearance data or no air draft set ⇒ no
 * gating (never fabricate a clearance).
 */
import { createLogger } from '../utils/createLogger';

const log = createLogger('lowBridges');

export interface LowBridge {
    id: string;
    name: string;
    /** Charted/estimated vertical clearance (m). */
    clearanceM: number;
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
            cache = (data.bridges ?? []).filter(
                (b) => Array.isArray(b.span) && b.span.length >= 2 && Number.isFinite(b.clearanceM),
            );
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

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/**
 * Thin blocking polygon across the waterway from the bridge's span line:
 * the span widened `halfWidthM` each side and extended `endPadM` past each
 * end, so the bar seals bank-to-bank even when the OSM way stops at the
 * water's edge. GeoJSON Polygon, [lon, lat].
 *
 * halfWidthM defaults to 30 m (60 m bar) because the engine's coarse grid
 * rasterises by CELL-CENTRE sampling at ~50 m — a 20 m bar can slip between
 * cell centres and claim ZERO cells, i.e. not block at all. 60 m guarantees
 * at least one cell row across the waterway; over-blocking ±30 m around a
 * bridge the vessel can't pass anyway costs nothing.
 */
export function bridgeBarPolygon(bridge: LowBridge, halfWidthM = 30, endPadM = 15): GeoJSON.Polygon {
    const a = bridge.span[0];
    const b = bridge.span[bridge.span.length - 1];
    const midLat = (a[1] + b[1]) / 2;
    const mx = mPerDegLon(midLat);
    // Span direction in metres.
    let dx = (b[0] - a[0]) * mx;
    let dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Perpendicular unit.
    const px = -dy;
    const py = dx;
    const toLL = (ex: number, ey: number): [number, number] => [a[0] + ex / mx, a[1] + ey / M_PER_DEG_LAT];
    // Endpoints in metre frame anchored at `a`, padded along the span.
    const ax = -dx * endPadM;
    const ay = -dy * endPadM;
    const bx = (b[0] - a[0]) * mx + dx * endPadM;
    const by = (b[1] - a[1]) * M_PER_DEG_LAT + dy * endPadM;
    const ring: [number, number][] = [
        toLL(ax + px * halfWidthM, ay + py * halfWidthM),
        toLL(bx + px * halfWidthM, by + py * halfWidthM),
        toLL(bx - px * halfWidthM, by - py * halfWidthM),
        toLL(ax - px * halfWidthM, ay - py * halfWidthM),
    ];
    ring.push(ring[0]);
    return { type: 'Polygon', coordinates: [ring] };
}

/** Bridges whose clearance the vessel cannot make. */
export function blockedBridgesFor(bridges: readonly LowBridge[], airDraftM: number | null): LowBridge[] {
    if (airDraftM === null || !Number.isFinite(airDraftM) || airDraftM <= 0) return [];
    return bridges.filter((b) => airDraftM > b.clearanceM);
}
