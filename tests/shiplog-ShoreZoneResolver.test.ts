import { describe, expect, it, vi } from 'vitest';

import {
    NEARSHORE_ENTER_NM,
    NEARSHORE_EXIT_NM,
    OFFSHORE_ENTER_NM,
    OFFSHORE_EXIT_NM,
    ShoreZoneResolver,
    classifyShoreZone,
    isConfirmedOcean,
    nearestCoastDistanceNm,
    type ShoreWaterStatus,
} from '../services/shiplog/ShoreZoneResolver';
import type { Segment } from '../services/weather/shelter/shelterGeometry';

const OCEAN: ShoreWaterStatus = { isWater: true, feature: 'OCEAN', failedOpen: false };
const LAND: ShoreWaterStatus = { isWater: false, feature: 'LAND', failedOpen: false };
const RIVER: ShoreWaterStatus = { isWater: true, feature: 'RIVER', failedOpen: false };
const LAKE: ShoreWaterStatus = { isWater: true, feature: 'LAKE', failedOpen: false };
const FAILED_OPEN: ShoreWaterStatus = { isWater: true, feature: 'OCEAN', failedOpen: true };

/** A horizontal coastline a known number of nautical miles north of a point. */
function coastAtNmFrom(baseLatitude: number, distanceNm: number): Segment[] {
    const latitude = baseLatitude + distanceNm / 60;
    return [
        [
            [0, latitude],
            [2, latitude],
        ],
    ];
}

/** A horizontal coastline a known number of nautical miles north of (1, 1). */
function coastAtNm(distanceNm: number): Segment[] {
    return coastAtNmFrom(1, distanceNm);
}

describe('ShoreZoneResolver pure evidence helpers', () => {
    it('accepts only an actual OCEAN result as proof that sparse offshore sampling is safe', () => {
        expect(isConfirmedOcean(OCEAN)).toBe(true);
        expect(isConfirmedOcean(LAND)).toBe(false);
        expect(isConfirmedOcean(RIVER)).toBe(false);
        expect(isConfirmedOcean(LAKE)).toBe(false);
        expect(isConfirmedOcean(FAILED_OPEN)).toBe(false);
        expect(isConfirmedOcean(undefined)).toBe(false);
    });

    it('measures nearest OSM coastline geometry in nautical miles', () => {
        const distance = nearestCoastDistanceNm(1, 1, coastAtNm(2));
        expect(distance).not.toBeNull();
        expect(distance!).toBeCloseTo(2, 1);
        expect(nearestCoastDistanceNm(1, 1, [])).toBeNull();
    });

    it('uses conservative hysteresis thresholds and always returns unknown evidence to nearshore', () => {
        expect(classifyShoreZone('nearshore', LAND, 20)).toBe('nearshore');
        expect(classifyShoreZone('nearshore', RIVER, 20)).toBe('nearshore');
        expect(classifyShoreZone('nearshore', LAKE, 20)).toBe('nearshore');
        expect(classifyShoreZone('nearshore', FAILED_OPEN, 20)).toBe('nearshore');
        expect(classifyShoreZone('nearshore', undefined, 20)).toBe('nearshore');

        expect(classifyShoreZone('nearshore', OCEAN, NEARSHORE_EXIT_NM)).toBe('nearshore');
        expect(classifyShoreZone('nearshore', OCEAN, NEARSHORE_EXIT_NM + 0.01)).toBe('coastal');
        expect(classifyShoreZone('nearshore', OCEAN, OFFSHORE_EXIT_NM + 0.01)).toBe('offshore');

        // The user-facing inshore boundary is one nautical mile. Returning
        // from coastal detail must become dense at that boundary, not wait
        // for a smaller hidden threshold.
        expect(NEARSHORE_ENTER_NM).toBe(1);
        expect(classifyShoreZone('coastal', OCEAN, NEARSHORE_ENTER_NM)).toBe('nearshore');
        expect(classifyShoreZone('coastal', OCEAN, NEARSHORE_ENTER_NM + 0.01)).toBe('coastal');
        expect(classifyShoreZone('coastal', OCEAN, OFFSHORE_EXIT_NM)).toBe('coastal');
        expect(classifyShoreZone('coastal', OCEAN, OFFSHORE_EXIT_NM + 0.01)).toBe('offshore');

        expect(classifyShoreZone('offshore', OCEAN, NEARSHORE_ENTER_NM)).toBe('nearshore');
        expect(classifyShoreZone('offshore', OCEAN, OFFSHORE_ENTER_NM)).toBe('coastal');
        expect(classifyShoreZone('offshore', OCEAN, OFFSHORE_ENTER_NM + 0.01)).toBe('offshore');
    });
});

describe('ShoreZoneResolver', () => {
    it('uses only the supplied GPS coordinate and stays dense until a sparse zone is corroborated', async () => {
        const fetchSegments = vi.fn(async (latitude: number, longitude: number) => {
            expect({ latitude, longitude }).toEqual({ latitude: 1, longitude: 1 });
            return coastAtNm(2);
        });
        const onZoneChange = vi.fn();
        const resolver = new ShoreZoneResolver({ fetchSegments, onZoneChange });

        // Unknown water is intentionally a no-network dense fallback.
        await expect(resolver.observe({ latitude: 1, longitude: 1 })).resolves.toBe('nearshore');
        expect(fetchSegments).not.toHaveBeenCalled();

        // The first coastal result is a candidate only; two matching actual
        // GPS observations are required before detail is reduced.
        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN })).resolves.toBe('nearshore');
        expect(resolver.profileFor(1, 1)).toBe('nearshore');
        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN })).resolves.toBe('coastal');

        expect(fetchSegments).toHaveBeenCalledTimes(1); // cached local geometry is reused
        expect(resolver.currentZone).toBe('coastal');
        expect(resolver.profileFor(1, 1)).toBe('coastal');
        expect(onZoneChange).toHaveBeenCalledTimes(1);
        expect(onZoneChange.mock.calls[0][0]).toMatchObject({ zone: 'coastal', latitude: 1, longitude: 1 });
    });

    it('requires two confirmations before going offshore, then immediately returns to dense nearshore detail', async () => {
        const onZoneChange = vi.fn();
        const resolver = new ShoreZoneResolver({
            fetchSegments: async (latitude) => (latitude < 1.25 ? [] : coastAtNmFrom(latitude, 0.5)),
            onZoneChange,
        });

        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN })).resolves.toBe('nearshore');
        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN })).resolves.toBe('offshore');
        expect(resolver.currentZone).toBe('offshore');
        expect(resolver.getLastResolution()).toMatchObject({ zone: 'offshore', confirmed: true });

        // A trusted close shoreline immediately restores the denser profile;
        // it does not wait for an extra confirmation.
        await expect(resolver.observe({ latitude: 1.5, longitude: 1, waterStatus: OCEAN })).resolves.toBe('nearshore');
        expect(resolver.currentZone).toBe('nearshore');

        expect(onZoneChange).toHaveBeenCalledWith(expect.objectContaining({ zone: 'offshore' }));
        expect(onZoneChange).toHaveBeenCalledWith(expect.objectContaining({ zone: 'nearshore' }));
    });

    it('treats land, river, lake, fail-open, and coastline failure as immediate dense fallbacks', async () => {
        const fetchSegments = vi.fn(async () => null);
        const resolver = new ShoreZoneResolver({ fetchSegments });

        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: LAND })).resolves.toBe('nearshore');
        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: RIVER })).resolves.toBe('nearshore');
        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: LAKE })).resolves.toBe('nearshore');
        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: FAILED_OPEN })).resolves.toBe(
            'nearshore',
        );
        expect(fetchSegments).not.toHaveBeenCalled();

        await expect(resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN })).resolves.toBe('nearshore');
        expect(fetchSegments).toHaveBeenCalledTimes(1);
        expect(resolver.currentZone).toBe('nearshore');
    });

    it('does not reuse a sparse zone away from the exact GPS evidence', async () => {
        const resolver = new ShoreZoneResolver({ fetchSegments: async () => [] });
        await resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN });
        await resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN });

        expect(resolver.profileFor(1, 1)).toBe('offshore');
        // About 30 nm north — a different part of the vessel's route must
        // fall back to dense detail until the resolver sees its evidence.
        expect(resolver.profileFor(1.5, 1)).toBe('nearshore');
    });

    it('reset starts a new voyage dense, invalidates old state, and retains static coastline geometry', async () => {
        const fetchSegments = vi.fn(async () => []);
        const resolver = new ShoreZoneResolver({ fetchSegments });

        await resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN });
        await resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN });
        expect(resolver.currentZone).toBe('offshore');
        expect(fetchSegments).toHaveBeenCalledTimes(1);

        resolver.reset();
        expect(resolver.currentZone).toBe('nearshore');
        expect(resolver.getLastResolution()).toBeNull();
        expect(resolver.profileFor(1, 1)).toBe('nearshore');

        // The OSM coastline is static; a new voyage can reuse it without a
        // second network request, while still requiring fresh confirmations.
        await resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN });
        await resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN });
        expect(resolver.currentZone).toBe('offshore');
        expect(fetchSegments).toHaveBeenCalledTimes(1);
    });

    it('coalesces requests and cannot let an old offshore result override a newer GPS point', async () => {
        let resolveFirst!: (segments: Segment[] | null) => void;
        const fetchSegments = vi.fn(
            () =>
                new Promise<Segment[] | null>((resolve) => {
                    resolveFirst = resolve;
                }),
        );
        const onZoneChange = vi.fn();
        const resolver = new ShoreZoneResolver({ fetchSegments, onZoneChange });

        const oldOceanRequest = resolver.observe({ latitude: 1, longitude: 1, waterStatus: OCEAN });
        const newestLandRequest = resolver.observe({ latitude: 2, longitude: 1, waterStatus: LAND });

        // The old request would classify offshore after its second
        // confirmation in a real session, but this response must not even
        // touch the current zone after the newer land GPS observation landed.
        resolveFirst([]);

        await expect(oldOceanRequest).resolves.toBeNull();
        await expect(newestLandRequest).resolves.toBe('nearshore');
        expect(fetchSegments).toHaveBeenCalledTimes(1);
        expect(resolver.currentZone).toBe('nearshore');
        expect(onZoneChange).not.toHaveBeenCalled();
        expect(resolver.getLastResolution()).toMatchObject({ latitude: 2, longitude: 1, zone: 'nearshore' });
    });
});
