import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aheadCone, type AheadHazard } from '../services/underway/lookaheadRule';
const state = vi.hoisted(() => ({ world: vi.fn(), load: vi.fn() }));
vi.mock('../services/weather/api/worldtides', () => ({ fetchWorldTides: state.world }));
vi.mock('../services/tides/officialTides', () => ({ fetchOfficialTides: vi.fn(async () => null) }));
vi.mock('../services/weather/apiCache', () => ({ apiCacheGet: () => null, apiCacheSet: vi.fn() }));
vi.mock('../services/enc/readChartDatum', () => ({ readChartDatumForBounds: vi.fn(async () => 'LAT') }));
vi.mock('../services/enc/EncHazardService', () => ({
    getCoverage: () => [{ id: 'ZZSYNTH', bbox: [-151, 29, -149, 32] }],
}));
vi.mock('../services/enc/EncCellMetadata', () => ({ getVersion: () => 1 }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: state.load }));
vi.mock('../services/enc/encHazardParse', () => ({
    buildHazardsForCell: (blob: { hazards: unknown[] }) => blob.hazards,
    buildCoastlines: () => [],
}));
vi.mock('../services/enc/chartDatum', () => ({ cellSoundingDatum: () => 'LAT' }));
vi.mock('../services/enc/EncSpatialIndex', () => ({
    EncSpatialIndex: class {
        constructor(
            _id: string,
            private readonly hazards: unknown[],
        ) {}
        lookaheadCandidates() {
            return this.hazards;
        }
    },
}));
import { fetchTideCurve, clearTideCache } from '../services/TideHeightService';
import { readTideCurveWindow } from '../services/TideOffsetService';
import { queryChartLookahead } from '../services/underway/ChartLookaheadQuery';
import { routeAreaTideCeilings } from '../services/routing/tideCeilings';
import { sweepDepartures } from '../services/routing/DepartureSweepInshore';
import { tideFieldFromCurve } from '../services/routing/env/EnvFields';
import { fetchTidesForPosition } from '../services/weather/api/tides';

const now = Date.parse('2026-10-16T00:00:00Z');
const depth: AheadHazard = {
    layer: 'DEPARE',
    minDepthM: 1,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [-151, 29],
                [-149, 29],
                [-149, 32],
                [-151, 32],
                [-151, 29],
            ],
        ],
    },
};
beforeEach(() => {
    clearTideCache();
    vi.clearAllMocks();
    state.load.mockResolvedValue({ hazards: [depth] });
    // If a navigation consumer accidentally requests this LAT response,
    // its ten metres would incorrectly clear the one-metre shallow.
    state.world.mockResolvedValue({
        status: 200,
        responseDatum: 'LAT',
        station: { name: 'Informational station' },
        extremes: [
            { dt: now / 1000, date: new Date(now).toISOString(), type: 'Low', height: 10 },
            { dt: now / 1000 + 21600, date: new Date(now + 21600_000).toISOString(), type: 'High', height: 11 },
        ],
    });
});

describe('WorldTides informational-only runtime boundary', () => {
    it('cannot suppress an actual chart-ahead shallow alarm with a positive LAT prediction', async () => {
        const cone = aheadCone({ lat: 30, lon: -150, at: now, sogKn: 6, cogDeg: 0 })!;
        const answer = await queryChartLookahead(cone, 2, 0.5);
        expect(answer.coverage).toBe('charted'); // Chart coverage, never tidal clearance.
        expect(answer.hit).toMatchObject({ kind: 'depth', chartDepthM: 1 });
        expect(state.world).not.toHaveBeenCalled();
    });
    it('keeps live-depth offsets and area tide ceilings unavailable rather than inventing zero or a high tide', async () => {
        expect(await readTideCurveWindow(30, -150)).toBeNull();
        const area = await routeAreaTideCeilings({ lat: 30, lon: -150 }, { lat: 30.01, lon: -150 }, now);
        expect(area.ceilings).toEqual([]);
        expect(area.curves?.size).toBe(0);
        expect(state.world).not.toHaveBeenCalled();
    });
    it('returns unknown UKC and no best departure when a shallow gate needs tide data', async () => {
        const curve = await fetchTideCurve(30, -150, now, now + 24 * 3600_000);
        const result = sweepDepartures({
            polyline: [
                [-150, 30],
                [-150, 30.01],
            ],
            speed: { stwMs: () => 3 },
            tide: curve ? tideFieldFromCurve(curve) : null,
            shallowSpots: [{ legIndex: 0, minDepthM: 1 }],
            draftM: 2,
            startMs: now,
        });
        expect(result.options.length).toBeGreaterThan(0);
        expect(result.options.every((row) => row.status === 'unknown' && row.minUkcM === null)).toBe(true);
        expect(result.best).toBeNull();
        expect(state.world).not.toHaveBeenCalled();
    });
    it('still delivers labelled informational predictions and the hourly curve to Glass', async () => {
        const data = await fetchTidesForPosition(30, -150);
        expect(data?.tides.map((row) => row.height)).toEqual([10, 11]);
        expect(data?.tideHourly.length).toBeGreaterThan(2);
        expect(data?.tideGUIDetails).toMatchObject({ provider: 'WorldTides', source: 'worldtides', datumLabel: 'LAT' });
        expect(state.world).toHaveBeenCalledExactlyOnceWith(30, -150, 14);
    });
});
