import { describe, expect, it } from 'vitest';
import type { NavGrid } from '../../services/inshoreRouterEngine';
import { routeTier4, type Tier4Context } from '../../services/tier4/tier4Router';
import { isRefusal, type BoundaryNode, type LatLon } from '../../services/routing/legContract';
import type { TierSpan } from '../../services/routing/segmentRoute';

const M_PER_LAT = 110_540;
const MIN_LAT = -27.3;
const MIN_LON = 153.0;
const dLat = 50 / M_PER_LAT;
const dLon = 50 / (111_320 * Math.cos((MIN_LAT * Math.PI) / 180));

function grid(): NavGrid {
    const width = 80;
    const height = 80;
    return {
        width,
        height,
        minLat: MIN_LAT,
        minLon: MIN_LON,
        dLat,
        dLon,
        cells: new Float32Array(width * height).fill(10),
        preferred: new Uint8Array(width * height),
    };
}

const node = (at: LatLon, kind: BoundaryNode['kind'] = 'channel-mouth'): BoundaryNode => ({
    at,
    headingDeg: 0,
    kind,
    depthM: 10,
    snapped: true,
});

function span(full: readonly LatLon[]): TierSpan {
    return {
        tier: 2,
        entry: node(full[0], 'mark-portal'),
        exit: node(full[full.length - 1], 'last-lead'),
        fromIdx: 0,
        toIdx: full.length - 1,
        caution: false,
    };
}

describe('routeTier4', () => {
    it('replaces a gate wiggle with the explicit channel-centre chain', () => {
        const entry: LatLon = [153.02, -27.26];
        const gateA: LatLon = [153.02, -27.25];
        const gateB: LatLon = [153.02, -27.24];
        const exit: LatLon = [153.02, -27.23];
        const wiggleA: LatLon = [153.0192, -27.2508];
        const wiggleB: LatLon = [153.0208, -27.2492];
        const full: LatLon[] = [entry, wiggleA, wiggleB, gateA, gateB, exit];
        const ctx: Tier4Context = {
            grid: grid(),
            recommendedTracks: [],
            marks: [],
            channelChains: [{ pts: [gateA, gateB].map(([lon, lat]) => ({ lat, lon })) }],
        };

        const leg = routeTier4(span(full), full, ctx);

        expect(isRefusal(leg)).toBe(false);
        if (isRefusal(leg)) return;
        expect(leg.provenance).toBe('tier2:chain×2');
        expect(leg.polyline).toEqual([entry, gateA, gateB, exit]);
    });
});
