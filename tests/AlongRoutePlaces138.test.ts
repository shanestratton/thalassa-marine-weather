import { describe, expect, it } from 'vitest';
import {
    prepareAlongRoute,
    projectAlongPlaces,
    publicAlongPlace,
    type AlongPlace,
} from '../services/routing/alongRoutePlaces';
const point = (id: string, lat = 0, lon = 0.5): AlongPlace => ({
    id,
    lat,
    lon,
    name: 'Fictional reference',
    kind: 'marina',
    source: 'Generated fixture',
    sourceAt: '2026-10-16T00:00:00Z',
    sourceUrl: null,
    aboardOnly: false,
    note: 'No checked approach',
});
const timing = { departureMs: Date.parse('2026-10-17T06:00:00Z'), speedKts: 6 };
const run = (route: { lat: number; lon: number }[], points: AlongPlace[], clock = timing) =>
    projectAlongPlaces(prepareAlongRoute(route), points, clock, new AbortController().signal, () => {});
describe('bounded along-route reference projection', () => {
    it('retains spherical progress/ETA, sorts it, and excludes places outside the5NM corridor', async () => {
        const route = [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
        ];
        const result = await run(route, [point('late', 0, 0.8), point('early', 0.01, 0.2), point('outside', 1, 0.5)]);
        expect(result.rows.map((p) => p.id)).toEqual(['early', 'late']);
        expect(result.rows[0].alongNm).toBeCloseTo(12.008, 2);
        expect(result.rows[0].offRouteNm).toBeCloseTo(0.6004, 3);
        expect(result.rows[0].etaMs).toBeCloseTo(timing.departureMs + (result.rows[0].alongNm / 6) * 3600000, 0);
        expect(result.rows[0].ambiguousVisit).toBe(false);
    });
    it('splits dateline windows without turning a short leg into a global request', async () => {
        const geometry = prepareAlongRoute([
            { lat: 0, lon: 179.8 },
            { lat: 0, lon: -179.8 },
        ]);
        expect(geometry.keys.length).toBeLessThanOrEqual(4);
        expect(geometry.bounds.some((b) => b[0] === -180)).toBe(true);
        expect(geometry.bounds.every((b) => b[2] - b[0] < 2 && b[0] >= -180 && b[2] <= 180)).toBe(true);
        const result = await projectAlongPlaces(
            geometry,
            [point('east', 0, -179.9)],
            timing,
            new AbortController().signal,
            () => {},
        );
        expect(result.rows[0].alongNm).toBeCloseTo(18.012, 2);
    });
    it('refuses invalid points, antipodal arcs and a whole passage exceeding16 catalogue cells', () => {
        expect(() =>
            prepareAlongRoute([
                { lat: 0, lon: 0 },
                { lat: NaN, lon: 1 },
            ]),
        ).toThrow();
        expect(() =>
            prepareAlongRoute([
                { lat: 0, lon: 0 },
                { lat: 0, lon: 180 },
            ]),
        ).toThrow('antipodal');
        expect(() =>
            prepareAlongRoute([
                { lat: 0, lon: 0 },
                { lat: 0, lon: 90 },
            ]),
        ).toThrow('individual leg');
        expect(() =>
            prepareAlongRoute([
                { lat: 89, lon: 0 },
                { lat: 89, lon: 1 },
            ]),
        ).toThrow('85');
    });
    it('shows an ambiguous visit with no ETA for out-and-back water, while dense forward points remain unambiguous', async () => {
        const outback = await run(
            [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 1 },
                { lat: 0, lon: 0 },
            ],
            [point('twice')],
        );
        expect(outback.rows[0]).toMatchObject({ etaMs: null, ambiguousVisit: true });
        const dense = await run(
            Array.from({ length: 31 }, (_, i) => ({ lat: 0, lon: i / 30 })),
            [point('once', 0.05, 0.51)],
        );
        expect(dense.rows[0].ambiguousVisit).toBe(false);
        expect(dense.rows[0].etaMs).not.toBeNull();
    });
    it('refuses the whole projection at its fixed comparison cap and honours cancellation between chunks', async () => {
        const geometry = prepareAlongRoute(Array.from({ length: 101 }, (_, i) => ({ lat: 0, lon: i / 100 })));
        await expect(
            projectAlongPlaces(
                geometry,
                Array.from({ length: 5001 }, (_, i) => point(String(i))),
                timing,
                new AbortController().signal,
                () => {},
            ),
        ).rejects.toThrow('projection budget');
        const stop = new AbortController();
        const pending = projectAlongPlaces(geometry, [point('cancelled')], timing, stop.signal, () => {});
        stop.abort();
        await expect(pending).rejects.toThrow();
    });
    it('labels bounded displayed results and never treats missing speed as a zero-duration ETA', async () => {
        const route = [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.1 },
        ];
        const result = await run(
            route,
            Array.from({ length: 129 }, (_, i) => point(String(i), 0, 0.05)),
            { departureMs: timing.departureMs, speedKts: 0 },
        );
        expect(result.rows).toHaveLength(128);
        expect(result.limited).toBe(true);
        expect(result.rows.every((p) => p.etaMs === null)).toBe(true);
    });
    it('whitelists public reference fields and does not infer operational fuel or approach permission', () => {
        const result = publicAlongPlace(
            {
                id: 'osm-node1',
                name: 'Fictional private marina',
                kind: 'marina',
                facilityKinds: ['marina', 'fuel'],
                lat: 0,
                lon: 0,
                approximate: true,
                access: 'private',
                country: '',
                aliases: [],
                restrictions: ['Reported opening_hours: unknown'],
            },
            { label: 'OSM / ODbL', at: '2026-10-16T00:00:00Z', url: 'https://www.openstreetmap.org/node/1' },
        );
        expect(result?.note).toContain('Marina and marine fuel mapped');
        expect(result?.note).toContain('Confirm permission');
        expect(result?.aboardOnly).toBe(false);
    });
});
