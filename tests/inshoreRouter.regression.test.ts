/**
 * Inshore router regression harness — the whack-a-mole insurance.
 *
 * Claude B is tuning the A* cost / corridor logic against real routes by
 * eye, where fixing Newport kept breaking Brisbane (and vice-versa).
 * This harness pins the STABLE invariants that must hold regardless of
 * how the cost function is tuned, using small synthetic charts fed
 * straight into routeInshore(layers, req) — deterministic, fast, no real
 * ENC data. A cost change that regresses any of these fails CI.
 *
 * Lane note (docs/ROUTING_COLLAB.md): this file is owned by Claude A and
 * only IMPORTS the engine (read-only). The engine itself is Claude B's.
 *
 * Cell model (from inshoreRouterEngine):
 *   - no layer data over a cell      → open / navigable
 *   - DEPARE DRVAL1 ≥ draft+safety    → navigable
 *   - DEPARE DRVAL1 <  draft+safety   → CAUTION (soft-blocked, crossable)
 *   - LANDARE                         → hard blocked
 *   - FAIRWY / DRGARE / NAVLINE       → preferred corridor
 */
import { describe, expect, it } from 'vitest';
import { routeInshore, type InshoreLayers, type RouteRequest } from '../services/inshoreRouterEngine';
import type { FeatureCollection, Feature } from 'geojson';

// ── Synthetic-chart helpers ──────────────────────────────────────────
function rect(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    props: Record<string, unknown> = {},
): Feature {
    return {
        type: 'Feature',
        properties: props,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    };
}
function fc(...features: Feature[]): FeatureCollection {
    return { type: 'FeatureCollection', features };
}

// Compact test domain in Moreton Bay (matches the real problem area).
// ~4 km E-W between origin and destination at this latitude.
const FROM = { lat: -27.2, lon: 153.08 };
const TO = { lat: -27.2, lon: 153.12 };

function baseReq(over: Partial<RouteRequest> = {}): RouteRequest {
    return {
        fromLat: FROM.lat,
        fromLon: FROM.lon,
        toLat: TO.lat,
        toLon: TO.lon,
        draftM: 2.0,
        safetyM: 1.0,
        resolutionM: 100, // coarse → fast grid for tests
        ...over,
    };
}

const isResult = (r: ReturnType<typeof routeInshore>): r is Extract<typeof r, { polyline: unknown }> => 'polyline' in r;

/** True if [lon,lat] falls inside an axis-aligned rect (incl. edges). */
function inRect(lon: number, lat: number, minLon: number, minLat: number, maxLon: number, maxLat: number): boolean {
    return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

/**
 * True if ANY point sampled densely along the polyline's segments falls
 * inside the rect. Catches a segment that crosses land even when its
 * endpoints are outside (path-smoothing can clip corners) — a truer
 * "route crosses land" test than checking vertices alone.
 */
function polylineEntersRect(
    polyline: [number, number][],
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    samplesPerSeg = 20,
): boolean {
    for (let i = 0; i < polyline.length - 1; i++) {
        const [aLon, aLat] = polyline[i];
        const [bLon, bLat] = polyline[i + 1];
        for (let s = 0; s <= samplesPerSeg; s++) {
            const t = s / samplesPerSeg;
            const lon = aLon + (bLon - aLon) * t;
            const lat = aLat + (bLat - aLat) * t;
            if (inRect(lon, lat, minLon, minLat, maxLon, maxLat)) return true;
        }
    }
    return false;
}

describe('inshore router — connectivity invariants', () => {
    it('open water → resolves a connected route between origin and destination', () => {
        const r = routeInshore({}, baseReq());
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.polyline.length).toBeGreaterThanOrEqual(2);
        // Endpoints land near the requested points (within snap tolerance).
        const [startLon, startLat] = r.polyline[0];
        const [endLon, endLat] = r.polyline[r.polyline.length - 1];
        expect(Math.abs(startLat - FROM.lat)).toBeLessThan(0.02);
        expect(Math.abs(startLon - FROM.lon)).toBeLessThan(0.02);
        expect(Math.abs(endLat - TO.lat)).toBeLessThan(0.02);
        expect(Math.abs(endLon - TO.lon)).toBeLessThan(0.02);
        expect(r.distanceNM).toBeGreaterThan(0);
    });

    it('a full barrier with no detour → still routes, but FLAGS caution (warned, never silent)', () => {
        // Engine contract: rather than hard-fail with destination-
        // disconnected, it retries relaxed — routing THROUGH the barrier
        // at high cost and flagging those segments caution so the renderer
        // draws them red. The invariant that must never regress: a route
        // forced through land/shallow is WARNED, never returned as a clean
        // "looks fine" path. Vertical LANDARE wall ~1.3 km thick (>10 cells
        // at 100 m), full bbox height, between origin (W) and dest (E).
        const wall = fc(rect(153.0935, -27.35, 153.1065, -27.05));
        const r = routeInshore({ LNDARE: wall }, baseReq());
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        const cautionCount = (r.cautionMask ?? []).filter(Boolean).length;
        expect(cautionCount).toBeGreaterThan(0);
    });
});

describe('inshore router — prefers clean water over crossing land', () => {
    it('detours around a land bar through clean water (longer path, zero caution) instead of bulldozing through', () => {
        // ~9.8 km direct (153.05↔153.15). A land bar blocks the direct
        // line but open water exists north + south. The engine should
        // take the clean detour (caution 0) — NOT the shorter relaxed path
        // straight through the bar (which would be caution-flagged). This
        // is the guardrail against a cost-tuning change that makes A*
        // bulldoze through land/shallow because it's geometrically shorter.
        const bar = fc(rect(153.08, -27.22, 153.12, -27.18));
        const r = routeInshore({ LNDARE: bar }, baseReq({ fromLon: 153.05, toLon: 153.15 }));
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        // Took clean water: no caution-flagged segments.
        const cautionCount = (r.cautionMask ?? []).filter(Boolean).length;
        expect(cautionCount).toBe(0);
        // And genuinely detoured (direct ≈ 5.3 NM; a clean detour is longer).
        expect(r.distanceNM).toBeGreaterThan(6.0);
        // Belt-and-braces: the detour did not thread the land bar.
        expect(polylineEntersRect(r.polyline, 153.08, -27.22, 153.12, -27.18)).toBe(false);
    });
});

describe('inshore router — corridor following (the Brisbane doctrine)', () => {
    // Whole domain reads too shallow for the vessel (DRVAL1 1.0 < draft+
    // safety 3.0) → CAUTION everywhere. A marked FAIRWY channel runs
    // straight from origin to destination. The route must still RESOLVE
    // (a marked channel is navigable even when coarse bathymetry says
    // shallow) — this is the "never depth-penalise inside a marked
    // corridor" doctrine, as a guardrail.
    const shallowEverywhere = fc(rect(153.05, -27.25, 153.15, -27.15, { DRVAL1: 1.0 }));
    const fairwayChannel = fc(rect(153.06, -27.203, 153.14, -27.197));

    it('resolves a route through shallow water when a marked FAIRWY channel exists', () => {
        const r = routeInshore({ DEPARE: shallowEverywhere, FAIRWY: fairwayChannel }, baseReq());
        expect(isResult(r)).toBe(true);
        if (!isResult(r)) return;
        expect(r.polyline.length).toBeGreaterThanOrEqual(2);
    });

    it('the resolved route rides the marked channel band (does not wander far off it)', () => {
        const r = routeInshore({ DEPARE: shallowEverywhere, FAIRWY: fairwayChannel }, baseReq());
        if (!isResult(r)) throw new Error('expected a route');
        // Every vertex should sit within ~300 m (0.0027°) of the channel
        // latitude band — i.e. the route follows the channel, not a
        // free diagonal across the shallow flat.
        for (const [, lat] of r.polyline) {
            expect(lat).toBeGreaterThan(-27.206);
            expect(lat).toBeLessThan(-27.194);
        }
    });
});
