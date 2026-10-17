import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), get: vi.fn(), set: vi.fn(), remove: vi.fn() }));
vi.mock('../services/osm/ownedOverpass', () => ({ fetchOwnedOverpass: mocks.fetch }));
vi.mock('@capacitor/preferences', () => ({ Preferences: mocks }));
import { ownedOperationForQuery } from '../services/osm/ownedOverpassContract';
import { namedPlacesQuery, referenceQuery } from '../services/anchorages/cruisingReference';
const now = Date.UTC(2026, 9, 17),
    sourceAt = new Date(now - 86400_000).toISOString();
const bounds = { south: -27.6, west: 153.1, north: -27.5, east: 153.2 };
const body = () => ({
    queryComplete: true,
    elements: [
        {
            type: 'node',
            id: 42,
            lat: -27.55,
            lon: 153.15,
            tags: { 'seamark:type': 'buoy_lateral', name: 'Fictional mark' },
        },
    ],
    thalassaSource: { sourceAt, cohortSha256: 'a'.repeat(64) },
});
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.fetch.mockReset().mockImplementation(async (query) => {
        ownedOperationForQuery(query);
        return body();
    });
    mocks.get.mockReset().mockResolvedValue({ value: null });
    mocks.set.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('owned OSM real query/cache consumers', () => {
    it('recognizes actual names/reference builders without replacing them with self-generated fixtures', () => {
        const tile = { key: '-28:153', south: -28, west: 153, north: -27, east: 154 };
        expect(ownedOperationForQuery(referenceQuery(tile))).toEqual({
            schema: 1,
            kind: 'references',
            bbox: [-28, 153, -27, 154],
        });
        expect(ownedOperationForQuery(namedPlacesQuery(tile))).toEqual({
            schema: 1,
            kind: 'names',
            bbox: [-28, 153, -27, 154],
        });
    });
    it('actual SeamarkService query is recognized and its persisted tiles retain original database time', async () => {
        const { SeamarkService } = await import('../services/SeamarkService');
        await SeamarkService.loadViewport(bounds, 11);
        expect(SeamarkService.getFeatures().features).toHaveLength(1);
        expect(SeamarkService.getFeatures().sourceAt).toBe(sourceAt);
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(ownedOperationForQuery(mocks.fetch.mock.calls[0][0]).kind).toBe('seamarks');
        expect(mocks.set.mock.calls[0][0].key).toBe('seamark_cache_v3_owned');
        const saved = JSON.parse(mocks.set.mock.calls[0][0].value) as Record<string, { at: number }>;
        expect(Object.values(saved).every((row) => row.at === Date.parse(sourceAt))).toBe(true);
        vi.setSystemTime(now + 46 * 86400_000);
        mocks.fetch.mockRejectedValue(new Error('Unavailable'));
        await SeamarkService.loadViewport(bounds, 11);
        expect(SeamarkService.getFeatures().features).toEqual([]);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
    it('does not mark partial sentinel output as a complete or empty cached tile', async () => {
        mocks.fetch.mockResolvedValue({ ...body(), queryComplete: false });
        const { SeamarkService } = await import('../services/SeamarkService');
        await SeamarkService.loadViewport(bounds, 11);
        expect(SeamarkService.cachedTileCount).toBe(0);
        expect(SeamarkService.getFeatures().features).toEqual([]);
        mocks.fetch.mockResolvedValue(body());
        await SeamarkService.loadViewport(bounds, 11);
        expect(SeamarkService.getFeatures().features).toHaveLength(1);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
});
