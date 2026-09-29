import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import { resolveAutomaticCanalExit, VERIFIED_CANAL_EXIT_PROFILES } from '../services/automaticCanalExit';
import { NEWPORT_CANAL_EXIT_PROFILE as profile } from '../services/newportCanalExitProfile';
import { encLayer } from './helpers/encCells';

// The shipped Newport profile is RETIRED (owner, 2026-09-29). This suite keeps
// the reviewed geometry under test as renewal evidence, so it sees the record
// unretired; tests/newportRetirement.test.ts pins the shipped, retired state.
vi.mock('../services/newportCanalExitProfile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/newportCanalExitProfile')>();
    const { retirement: _retired, ...reviewed } = actual.NEWPORT_CANAL_EXIT_PROFILE;
    return { ...actual, NEWPORT_CANAL_EXIT_PROFILE: reviewed };
});

const now = Date.parse('2026-09-13T00:00:00Z');
const offshore = { lat: -27.44, lon: 153.1 };
const resolve = (lon: number, lat: number) =>
    resolveAutomaticCanalExit({ lon, lat }, offshore, VERIFIED_CANAL_EXIT_PROFILES, now);

describe('reviewed Newport automatic departure profile', () => {
    it.each([
        [153.0897666667, -27.2145],
        [153.0878, -27.2144833333],
        [153.094, -27.21],
    ])('resolves reviewed tidal-canal departure %s,%s', (lon, lat) => {
        const result = resolve(lon, lat);
        expect(result.status).toBe('resolved');
        if (result.status !== 'resolved') throw Error(result.reason);
        expect(result.gateCentres).toHaveLength(4);
        expect(result.exit.lon).toBeCloseTo(153.094083, 10);
        expect(result.exit.lat).toBeCloseTo(-27.183025, 10);
        expect(result.gateCentres.at(-1)).toEqual(result.exit);
        expect(result.sourceRevision).toBe(profile.sourceRevision);
    });
    it.each([
        [153.088, -27.209],
        [153.098, -27.215],
        [153.094, -27.18],
        [153.106, -27.194],
        [153.095, -27.44],
    ])('does not claim lake, bridge-separated canals, bay or another harbour %s,%s', (lon, lat) => {
        expect(resolve(lon, lat).status).toBe('manual-required');
    });
    it('retains all eight reviewed ENC identities and never imports regional guessed gates', () => {
        expect(profile.chartEvidence).toEqual([{ cellId: 'OC-61-10RCS5', edition: 1, issued: '2022-03-07' }]);
        const chart = encLayer('OC-61-10RCS5', 'BCNLAT');
        // Fixture is regression evidence only; the source review used the live
        // licensed chart and the official channel map, not these test records.
        for (const gate of profile.gates)
            for (const [mark, category] of [
                [gate.port, 1],
                [gate.starboard, 2],
            ] as const) {
                const feature = chart.find((f) => f.properties?.rcid === Number(mark.id.split('/').at(-1)));
                expect(feature?.properties?.CATLAM).toBe(category);
                expect(feature?.geometry).toMatchObject({ type: 'Point', coordinates: [mark.lon, mark.lat] });
            }
    });
    it('keeps the conservative departure boundary inside actual mapped canal water and outside the lake/lock', () => {
        const envelope = JSON.parse(readFileSync('supabase/functions/osm-overlay/data/newport-v1.json', 'utf8'));
        const data = JSON.parse(envelope.overlayJson) as { water: FeatureCollection<Polygon | MultiPolygon> };
        const canal = data.water.features.filter(
            (f) => f.properties?.water === 'canal' && ![9093123, 722856950].includes(Number(f.properties?.['@id'])),
        );
        const ring = profile.departureArea.coordinates[0];
        for (let i = 1; i < ring.length; i++)
            for (let j = 0; j <= 10; j++) {
                const a = ring[i - 1],
                    b = ring[i],
                    p = [a[0] + ((b[0] - a[0]) * j) / 10, a[1] + ((b[1] - a[1]) * j) / 10];
                expect(canal.some((f) => booleanPointInPolygon(p, f))).toBe(true);
            }
    });
    it('does not retain an expired review or unnecessarily leave and re-enter the same canal', () => {
        const start = { lon: 153.0897666667, lat: -27.2145 };
        expect(resolveAutomaticCanalExit(start, offshore, [profile], Date.parse(profile.validUntil)).status).toBe(
            'manual-required',
        );
        expect(resolveAutomaticCanalExit(start, { lon: 153.0878, lat: -27.2144833333 }, [profile], now).status).toBe(
            'manual-required',
        );
    });
});
