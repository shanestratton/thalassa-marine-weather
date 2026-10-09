/**
 * The off-route alarm's offshore limit (126-02a) takes the Ship's Log shore
 * zone only where it rests on evidence. The log's own 'nearshore' is ALSO its
 * offline / unresolved fallback (services/shiplog/ShoreZoneResolver.ts), so on
 * an offline ocean passage it would have pinned the alarm to the inshore
 * quarter mile for days. getEvidencedShoreZone() says null there, and the
 * alarm falls back to its open-water-leg test.
 *
 * Fictional positions: the Bay of Islands and out to sea.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ShipLogService } from '../services/ShipLogService';
import { ShoreZoneResolver } from '../services/shiplog/ShoreZoneResolver';
import type { Segment } from '../services/weather/shelter/shelterGeometry';

type Internals = {
    trackingState: { isTracking: boolean; isPaused: boolean; loggingZone?: string };
    shoreZoneResolver: ShoreZoneResolver;
};
const internals = ShipLogService as unknown as Internals;
const original = { tracking: internals.trackingState, resolver: internals.shoreZoneResolver };

afterEach(() => {
    internals.trackingState = original.tracking;
    internals.shoreZoneResolver = original.resolver;
});

const OCEAN = { isWater: true, feature: 'OCEAN', failedOpen: false } as const;
/** A short stretch of fictional coastline about 0.3 NM west of the fix. */
const COAST: Segment[] = [
    [
        [174.094, -35.25],
        [174.094, -35.2],
    ],
] as unknown as Segment[];

describe('ShipLogService.getEvidencedShoreZone', () => {
    it('offline (no coastline), the log says nearshore but the evidence says nothing', async () => {
        internals.trackingState = { isTracking: true, isPaused: false, loggingZone: 'nearshore' };
        internals.shoreZoneResolver = new ShoreZoneResolver({ fetchSegments: async () => null });
        await internals.shoreZoneResolver.observe({ latitude: -34.9, longitude: 174.4, waterStatus: OCEAN });
        expect(internals.shoreZoneResolver.currentZone).toBe('nearshore');
        expect(ShipLogService.getEvidencedShoreZone()).toBeNull();
    });

    it('with real ocean + coastline agreement, the zone it found', async () => {
        internals.trackingState = { isTracking: true, isPaused: false, loggingZone: 'nearshore' };
        internals.shoreZoneResolver = new ShoreZoneResolver({ fetchSegments: async () => COAST });
        await internals.shoreZoneResolver.observe({ latitude: -35.22, longitude: 174.1, waterStatus: OCEAN });
        expect(ShipLogService.getEvidencedShoreZone()).toBe('nearshore');
        // Clear of the 60 km query (no coastline at all, confirmed ocean): offshore after two looks.
        internals.shoreZoneResolver = new ShoreZoneResolver({ fetchSegments: async () => [] });
        await internals.shoreZoneResolver.observe({ latitude: -34.5, longitude: 175, waterStatus: OCEAN });
        await internals.shoreZoneResolver.observe({ latitude: -34.5, longitude: 175.01, waterStatus: OCEAN });
        expect(ShipLogService.getEvidencedShoreZone()).toBe('offshore');
    });

    it('not recording, or paused: no zone', async () => {
        internals.shoreZoneResolver = new ShoreZoneResolver({ fetchSegments: async () => [] });
        await internals.shoreZoneResolver.observe({ latitude: -34.5, longitude: 175, waterStatus: OCEAN });
        await internals.shoreZoneResolver.observe({ latitude: -34.5, longitude: 175.01, waterStatus: OCEAN });
        internals.trackingState = { isTracking: false, isPaused: false };
        expect(ShipLogService.getEvidencedShoreZone()).toBeNull();
        internals.trackingState = { isTracking: true, isPaused: true };
        expect(ShipLogService.getEvidencedShoreZone()).toBeNull();
    });
});
