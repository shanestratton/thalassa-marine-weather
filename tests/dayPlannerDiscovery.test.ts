import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CruisingPoint, ReferenceTile } from '../services/anchorages/cruisingReference';
import { parseOsmReferences } from '../services/anchorages/cruisingReference';
import type { DayPlanRequest } from '../services/dayPlanner/engine';
const api = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../services/anchorages/CruisingReferenceService', () => ({ loadReferenceTile: api.load }));
import {
    dayPlannerDiscoveryTiles,
    discoverMappedDayPlanCandidates,
    DAY_PLANNER_REFERENCE_MAX_AGE_MS,
} from '../services/dayPlanner/discovery';

const now = Date.UTC(2026, 8, 27, 0);
const request = (): DayPlanRequest => ({
    start: { lat: 37.5, lon: -122.5, label: 'Synthetic start' },
    departureMs: now + 3600000,
    maxSailingHours: 8,
    stopHours: 2,
    mode: 'return',
    activities: ['explore'],
    speedKts: 6,
    draftM: 1.5,
});
const point = (patch: Partial<CruisingPoint> = {}): CruisingPoint => ({
    id: 'osm-node123',
    kind: 'anchorage',
    name: 'Synthetic mapped reference',
    lat: 37.55,
    lon: -122.5,
    colours: [],
    band: null,
    mooringClass: null,
    access: 'Unknown — check permission',
    notes: '',
    source: 'OpenStreetMap',
    sourceUrl: 'https://www.openstreetmap.org/node/123',
    retrievedAt: new Date(now - 1000).toISOString(),
    approximate: false,
    restrictionNotes: [],
    ...patch,
});
const options = () => ({ signal: new AbortController().signal, timeZone: 'America/Los_Angeles', now: () => now });
function rows(points: CruisingPoint[], stale = false) {
    api.load.mockImplementation(async (tile: ReferenceTile) => ({
        stale,
        points: points.filter(
            (p) => p.lat >= tile.south && p.lat <= tile.north && p.lon >= tile.west && p.lon <= tile.east,
        ),
    }));
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    rows([point()]);
});
afterEach(() => vi.restoreAllMocks());

describe('Bounded worldwide reference cells', () => {
    it.each([
        { lat: 37.5, lon: -122.5 },
        { lat: -33.8, lon: 151.2 },
        { lat: 79.9, lon: 40.4 },
        { lat: -80, lon: -179.9 },
        { lat: 0, lon: 180 },
    ])('queries at most four integer one-degree cells around %j', (start) => {
        const result = dayPlannerDiscoveryTiles({
            ...request(),
            start: { ...start, label: 'Test' },
            maxSailingHours: 24,
        });
        expect(result.radiusNM).toBe(30);
        expect(result.tiles.length).toBeGreaterThan(0);
        expect(result.tiles.length).toBeLessThanOrEqual(4);
        for (const tile of result.tiles) {
            expect(Number.isInteger(tile.west) && Number.isInteger(tile.south)).toBe(true);
            expect(tile.east - tile.west).toBe(1);
            expect(tile.north - tile.south).toBe(1);
        }
    });
    it('splits a date-line search into nearby cells, never a full-world extent', () => {
        const { tiles } = dayPlannerDiscoveryTiles({ ...request(), start: { lat: -17.8, lon: 179.99, label: 'Test' } });
        expect(tiles.some((tile) => tile.west === 179)).toBe(true);
        expect(tiles.some((tile) => tile.west === -180)).toBe(true);
        expect(tiles.every((tile) => Math.abs(tile.west) >= 179)).toBe(true);
    });
    it('uses total return sailing budget and reports high-latitude truncation', () => {
        expect(dayPlannerDiscoveryTiles({ ...request(), maxSailingHours: 2 }).radiusNM).toBe(6);
        expect(dayPlannerDiscoveryTiles({ ...request(), mode: 'overnight', maxSailingHours: 2 }).radiusNM).toBe(12);
        expect(
            dayPlannerDiscoveryTiles({ ...request(), start: { lat: 79, lon: 0, label: 'Test' }, maxSailingHours: 24 })
                .truncated,
        ).toBe(true);
    });
    it.each([
        { lat: 80.01, lon: 0 },
        { lat: -81, lon: 0 },
        { lat: 0, lon: 181 },
        { lat: NaN, lon: 0 },
    ])('rejects unsupported coordinates %j', (start) => {
        expect(() => dayPlannerDiscoveryTiles({ ...request(), start: { ...start, label: 'Test' } })).toThrow();
    });
});

describe('Fresh unverified map candidates', () => {
    it('uses each exact stop’s geographic time zone across a short international boundary', async () => {
        const departure = { ...request(), start: { lat: 37.16, lon: -7.42, label: 'Synthetic Portugal departure' } };
        rows([point({ lat: 37.16, lon: -7.38 })]);
        const found = await discoverMappedDayPlanCandidates(departure, { ...options(), timeZone: 'Europe/Lisbon' });
        expect(found.candidates).toHaveLength(1);
        expect(found.candidates[0].destination.timeZone).toBe('Europe/Madrid');
        expect(departure.start).toEqual({ lat: 37.16, lon: -7.42, label: 'Synthetic Portugal departure' });
    });
    it('preserves exact node identity, coordinates and source; never invents activities or shelter', async () => {
        rows([point({ fetchLandNM: Array(36).fill(0.1) })]);
        const found = await discoverMappedDayPlanCandidates(request(), options());
        expect(found.candidates).toHaveLength(1);
        const candidate = found.candidates[0];
        expect(candidate.destination).toMatchObject({
            id: 'osm-node123',
            lat: 37.55,
            lon: -122.5,
            catalogueQuality: 'mapped-reference',
            activities: ['explore'],
            timeZone: 'America/Los_Angeles',
            openMapUrl: point().sourceUrl,
        });
        expect(candidate.destination.verifiedAt).toBeUndefined();
        expect(candidate.place.fetchLandNM).toBeUndefined();
        expect(found.limitations.join(' ')).toMatch(/not established/);
        expect(found.freshUntilMs).toBe(now - 1000 + DAY_PLANNER_REFERENCE_MAX_AGE_MS);
        expect(api.load.mock.calls.length).toBeLessThanOrEqual(4);
    });
    it.each([
        { approximate: true },
        { kind: 'mooring' as const },
        { id: 'osm-way123' },
        { source: 'QPWS' as const },
        { sourceUrl: 'https://example.test/not-the-node' },
        { lat: 37.99 },
        { retrievedAt: new Date(now - DAY_PLANNER_REFERENCE_MAX_AGE_MS).toISOString() },
        { retrievedAt: new Date(now + 1).toISOString() },
        { retrievedAt: 'bad-date' },
        { restrictionNotes: undefined },
    ])('excludes unsupported, out-of-radius or stale references %j', async (patch) => {
        rows([point(patch)]);
        expect((await discoverMappedDayPlanCandidates(request(), options())).candidates).toEqual([]);
    });
    it.each([
        { access: 'private' },
        { access: 'no' },
        { access: 'yes;restricted' },
        { access: 'permit required' },
        { access: 'military' },
        { notes: 'No anchoring here' },
        { notes: 'Anchoring is prohibited' },
        { notes: 'Restricted anchorage' },
        { notes: 'Marine exclusion zone' },
        { notes: 'Do not anchor in this bay' },
        { notes: 'Not permitted to anchor here' },
        { restrictionNotes: ['Anchoring restriction reported: anchoring=no'] },
    ])('excludes known restrictions %j', async (patch) => {
        rows([point(patch)]);
        const found = await discoverMappedDayPlanCandidates(request(), options());
        expect(found.candidates).toEqual([]);
        expect(found.excluded[0].reason).toMatch(/restricted/);
    });
    it('deduplicates consistent references and rejects conflicting duplicate identities', async () => {
        rows([point(), point()]);
        expect((await discoverMappedDayPlanCandidates(request(), options())).candidates).toHaveLength(1);
        rows([point(), point({ lat: 37.56 })]);
        expect((await discoverMappedDayPlanCandidates(request(), options())).candidates).toHaveLength(0);
        rows([point(), point({ access: 'private' })]);
        expect((await discoverMappedDayPlanCandidates(request(), options())).candidates).toHaveLength(0);
    });
    it.each([
        { 'motorboat:conditional': 'no @ (Oct-Apr)' },
        { 'sailboat:conditional': 'no @ (Oct-Apr)' },
        { boat: 'destination' },
        { 'seamark:anchorage:access': 'destination' },
    ])('excludes raw vessel-specific OSM restrictions even when generic access is yes: %j', async (tags) => {
        const parsed = parseOsmReferences(
            {
                elements: [
                    {
                        type: 'node',
                        id: 123,
                        lat: 37.55,
                        lon: -122.5,
                        tags: { 'seamark:type': 'anchorage', access: 'yes', ...tags },
                    },
                ],
            },
            new Date(now - 1000).toISOString(),
        );
        rows(parsed);
        expect(parsed[0].access).toBe('yes');
        const found = await discoverMappedDayPlanCandidates(request(), options());
        expect(found.candidates).toEqual([]);
        expect(found.excluded[0].reason).toContain('restricted');
    });
    it('never suggests stale fallback tiles or uses fresh cached references offline', async () => {
        rows([point()], true);
        await expect(discoverMappedDayPlanCandidates(request(), options())).rejects.toThrow('stale');
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        api.load.mockClear();
        await expect(discoverMappedDayPlanCandidates(request(), options())).rejects.toThrow('online');
        expect(api.load).not.toHaveBeenCalled();
    });
    it('fails the bounded search if any required tile fails and respects cancellation', async () => {
        api.load.mockRejectedValue(new Error('Provider unavailable'));
        await expect(discoverMappedDayPlanCandidates(request(), options())).rejects.toThrow('Provider unavailable');
        const controller = new AbortController();
        controller.abort();
        api.load.mockClear();
        await expect(
            discoverMappedDayPlanCandidates(request(), { ...options(), signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(api.load).not.toHaveBeenCalled();
    });
    it('rejects swapped tile content and invalid departure zones', async () => {
        api.load.mockResolvedValue({ points: [point({ lat: 0 })], stale: false });
        expect((await discoverMappedDayPlanCandidates(request(), options())).candidates).toEqual([]);
        await expect(
            discoverMappedDayPlanCandidates(request(), { ...options(), timeZone: 'invalid/zone' }),
        ).rejects.toThrow('time zone');
    });
});
