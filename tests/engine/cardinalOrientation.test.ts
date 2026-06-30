/**
 * orientHazardsTowardLand — cardinal-direction awareness. An East cardinal means safe water
 * to the EAST (hazard WEST), so the avoidance half-disc must block the WEST side, guaranteeing
 * the route passes EAST. Two same-direction cardinals therefore end up on the SAME side of the
 * track (Shane's Brisbane River pair). The disc is one-sided (only the hazard side is blocked,
 * safe side always open), so it's sized LARGE to reach an open-water route without ever
 * disconnecting water. It must stay inert for bare 'cardinal' / non-cardinal hazards.
 */
import { describe, it, expect } from 'vitest';
import { orientHazardsTowardLand } from '../../services/InshoreRouter';

type Ring = [number, number][];
type OutFeature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: Ring[] } };

// Land polygon ~1.5 km NORTH of (lon,lat) — within the 5 km orientation gate.
const landNorthOf = (lon: number, lat: number): { geometry: { type: string; coordinates: number[][][] } } => ({
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [lon - 0.01, lat + 0.01],
                [lon + 0.01, lat + 0.01],
                [lon + 0.01, lat + 0.02],
                [lon - 0.01, lat + 0.02],
                [lon - 0.01, lat + 0.01],
            ],
        ],
    },
});
const cardinal = (
    lon: number,
    lat: number,
    dir: string,
): { geometry: { type: 'Point'; coordinates: [number, number] }; properties: unknown } => ({
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { _class: 'direct-hazard', _osmClass: dir },
});
const meanLon = (r: Ring): number => r.reduce((s, [lon]) => s + lon, 0) / r.length;
const meanLat = (r: Ring): number => r.reduce((s, [, lat]) => s + lat, 0) / r.length;

describe('orientHazardsTowardLand — cardinal direction', () => {
    it('an EAST cardinal blocks the WEST side (route passes east), NOT the shore side', () => {
        const lon = 153.1;
        const lat = -27.3;
        const out = orientHazardsTowardLand(
            [cardinal(lon, lat, 'cardinal_e')],
            [landNorthOf(lon, lat)],
        ) as OutFeature[];
        const ring = out[0].geometry.coordinates[0];
        expect(out[0].properties._cardinalOriented).toBe(true);
        expect(meanLon(ring)).toBeLessThan(lon); // disc centred WEST (hazard side of an E cardinal)
        expect(meanLat(ring)).toBeGreaterThan(lat - 0.003); // NOT pulled north toward the shore
    });

    it('two EAST cardinals both block their WEST side (same side of track — no thread between)', () => {
        const lat = -27.3;
        const a = cardinal(153.1, lat, 'cardinal_e');
        const b = cardinal(153.104, lat, 'cardinal_e');
        const out = orientHazardsTowardLand([a, b], [landNorthOf(153.102, lat)]) as OutFeature[];
        expect(meanLon(out[0].geometry.coordinates[0])).toBeLessThan(153.1); // both west of their own mark
        expect(meanLon(out[1].geometry.coordinates[0])).toBeLessThan(153.104);
    });

    it('a WEST cardinal blocks the EAST side (mirror)', () => {
        const lon = 153.1;
        const lat = -27.3;
        const out = orientHazardsTowardLand(
            [cardinal(lon, lat, 'cardinal_w')],
            [landNorthOf(lon, lat)],
        ) as OutFeature[];
        expect(meanLon(out[0].geometry.coordinates[0])).toBeGreaterThan(lon); // disc EAST (hazard side of a W cardinal)
    });

    it('uses a LARGE directional radius (one-sided disc → connectivity-safe, reaches an open-water route)', () => {
        const lon = 153.1;
        const lat = -27.3;
        const out = orientHazardsTowardLand(
            [cardinal(lon, lat, 'cardinal_e')],
            [landNorthOf(lon, lat)],
        ) as OutFeature[];
        // The half-disc blocks only the hazard side, so it can't disconnect water — sized to
        // REACH a route that may sit 500 m+ off the mark (the 300 m cap never could).
        expect(out[0].properties._radiusM).toBe(1000); // CARDINAL_RADIUS_MAX_M
    });

    it('stays inert for a bare "cardinal" (no direction) — falls back to shore orientation', () => {
        const lon = 153.1;
        const lat = -27.3;
        const out = orientHazardsTowardLand([cardinal(lon, lat, 'cardinal')], [landNorthOf(lon, lat)]) as OutFeature[];
        expect(out[0].properties._cardinalOriented).toBe(false);
        expect(meanLat(out[0].geometry.coordinates[0])).toBeGreaterThan(lat); // disc faces NORTH (the shore)
    });
});
