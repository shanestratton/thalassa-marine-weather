/**
 * Tier-2 REAL-CHART fixture (collab reply 40) — a genuine ≥5 m open-bay
 * crossing in eastern Moreton Bay, captured live off the Pi
 * (tests/fixtures/moreton-bay-tier2.corridor.json.gz, 4 cells, DEPARE 2952).
 *
 * B's tier2Router.test.ts proves routeTier2 on SYNTHETIC grids. This proves
 * it on REAL chart depths: build the engine grid from the captured DEPARE,
 * then route a documented deep crossing through it. The eastern bay is ~37%
 * ≥5 m water, so these are genuine open-bay corridors, not dredged channels.
 *
 * Verified crossings (node = [lon, lat], from the scratch hunt against this
 * exact grid):
 *   • BEND  [153.22,-27.3533] → [153.30,-27.4467]  ~7 NM, curves through deep
 *     water — the high-value case (centerline bend on real geometry).
 *   • This is the Tier-2 regression input for PHASE 4 wiring.
 */
import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    routeInshore,
    getCachedNavGrid,
    type InshoreLayers,
    type RouteRequest,
} from '../../services/inshoreRouterEngine';
import { routeTier2, type Tier2Context } from '../../services/tier2/tier2Router';
import { isRefusal, type BoundaryNode, type LatLon } from '../../services/routing/legContract';
import type { TierSpan } from '../../services/routing/segmentRoute';
import { assembleLayers, type CorridorFixture } from '../helpers/corridorFixture';

function loadFixtureRaw(name: string): CorridorFixture {
    const path = join(__dirname, '..', 'fixtures', name);
    return JSON.parse(gunzipSync(readFileSync(path)).toString()) as CorridorFixture;
}

const node = (p: LatLon): BoundaryNode => ({
    at: p,
    headingDeg: 90,
    kind: 'channel-mouth',
    depthM: 6,
    snapped: true,
});
const span = (entry: LatLon, exit: LatLon): TierSpan => ({
    tier: 2,
    entry: node(entry),
    exit: node(exit),
    fromIdx: 0,
    toIdx: 1,
    caution: false,
});

describe('Tier-2 real-chart fixture — Moreton Bay open-bay crossing', () => {
    const fx = loadFixtureRaw('moreton-bay-tier2.corridor.json.gz');
    const layers = assembleLayers(fx) as InshoreLayers;
    const req = fx.request as RouteRequest;

    // Build + cache the engine grid by routing once (route result irrelevant).
    const built = routeInshore(layers, req);
    const bbox = 'bbox' in built ? built.bbox : null;

    const ENTRY: LatLon = [153.22, -27.3533];
    const EXIT: LatLon = [153.3, -27.4467];

    it('the fixture carries real chart depth data (DEPARE present)', () => {
        expect(fx.cells.DEPARE?.features.length ?? 0).toBeGreaterThan(1000);
    });

    it('the engine grid builds and is mostly deep open water', () => {
        expect(bbox).not.toBeNull();
        if (!bbox) return;
        const grid = getCachedNavGrid(layers, bbox, req.resolutionM ?? 50, req.draftM, req.safetyM ?? 0.2, 30);
        expect(grid).not.toBeNull();
        if (!grid) return;
        let deep = 0;
        for (let i = 0; i < grid.cells.length; i++) if (!Number.isNaN(grid.cells[i]) && grid.cells[i] >= 5) deep++;
        // Eastern bay is genuinely open deep water, not a thin channel.
        expect(deep / grid.cells.length).toBeGreaterThan(0.2);
    });

    it('routeTier2 routes the documented open-bay crossing as a clean deep Leg', () => {
        expect(bbox).not.toBeNull();
        if (!bbox) return;
        const grid = getCachedNavGrid(layers, bbox, req.resolutionM ?? 50, req.draftM, req.safetyM ?? 0.2, 30);
        expect(grid).not.toBeNull();
        if (!grid) return;
        const ctx: Tier2Context = { grid, draftM: 2.4, tideSafetyM: 0.5 };
        const leg = routeTier2(span(ENTRY, EXIT), ctx);
        expect(isRefusal(leg), `routeTier2 refused: ${isRefusal(leg) ? leg.reason : ''}`).toBe(false);
        if (isRefusal(leg)) return;
        // routeTier2 emits tierId 3 under the four-tier contract (7574df84):
        // the marks-free deep bay crossing IS tier 3; "tier 2" is now the
        // marked channel. The function keeps its legacy name.
        expect(leg.tierId).toBe(3);
        expect(leg.controllingDepthM ?? 0).toBeGreaterThanOrEqual(5); // genuine ≥5 m crossing
        expect(leg.polyline.length).toBeGreaterThanOrEqual(2);
        expect(leg.cautionMask.every((c) => c === false)).toBe(true); // open deep water, no caution
        expect(Object.isFrozen(leg)).toBe(true);
    });
});
