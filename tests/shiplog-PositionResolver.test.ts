/**
 * Tests for PositionResolver — focused on the staleness boundaries since
 * the resolver is otherwise a thin forwarder over GpsService /
 * BgGeoManager / NmeaGpsProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBestPosition, getGpsNavData, getGpsStatus } from '../services/shiplog/PositionResolver';
import type { CachedPosition } from '../services/BgGeoManager';

const lanes = vi.hoisted(() => ({
    bus: null as null | Record<string, unknown>,
    pi: null as null | Record<string, unknown>,
    cloud: null as null | Record<string, unknown>,
    freshPhone: null as unknown,
}));

vi.mock('../services/BgGeoManager', () => ({
    BgGeoManager: {
        getLastPosition: () => null,
        getFreshPosition: vi.fn(async () => lanes.freshPhone),
    },
}));
vi.mock('../services/NmeaGpsProvider', () => ({
    NmeaGpsProvider: { getPosition: () => lanes.bus },
}));
vi.mock('../services/boatPositionChain', () => ({
    piFix: async () => lanes.pi,
    cloudFix: async () => lanes.cloud,
}));

function makeFix(ageMs: number, overrides: Partial<CachedPosition> = {}): CachedPosition {
    return {
        latitude: 0,
        longitude: 0,
        accuracy: 5,
        altitude: null,
        heading: 90,
        speed: 5, // m/s = ~9.7 kts
        timestamp: Date.now() - ageMs,
        receivedAt: Date.now() - ageMs,
        ...overrides,
    } as CachedPosition;
}

describe('getGpsStatus', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-02T06:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns "none" when no fix is supplied and not native', () => {
        expect(getGpsStatus(null, false)).toBe('none');
    });

    it('returns "locked" for fixes < 60s old', () => {
        expect(getGpsStatus(makeFix(30_000), false)).toBe('locked');
    });

    it('returns "stale" for fixes 60s–5min old', () => {
        expect(getGpsStatus(makeFix(120_000), false)).toBe('stale');
        expect(getGpsStatus(makeFix(290_000), false)).toBe('stale');
    });

    it('returns "none" for fixes > 5min old', () => {
        expect(getGpsStatus(makeFix(310_000), false)).toBe('none');
    });
});

describe('getGpsNavData', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-02T06:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns nulls when no fix is supplied', () => {
        expect(getGpsNavData(null, false)).toEqual({ sogKts: null, cogDeg: null });
    });

    it('returns nulls when fix is stale', () => {
        expect(getGpsNavData(makeFix(120_000), false)).toEqual({ sogKts: null, cogDeg: null });
    });

    it('converts m/s → knots and rounds heading for fresh fixes', () => {
        const fix = makeFix(5_000, { speed: 5, heading: 92.7 });
        expect(getGpsNavData(fix, false)).toEqual({ sogKts: 9.7, cogDeg: 93 });
    });

    it('returns null sog when speed is missing or negative', () => {
        const fixNoSpeed = makeFix(5_000, { speed: undefined as unknown as number });
        expect(getGpsNavData(fixNoSpeed, false).sogKts).toBeNull();
        const fixNeg = makeFix(5_000, { speed: -1 });
        expect(getGpsNavData(fixNeg, false).sogKts).toBeNull();
    });

    it('returns null cog when heading is missing or negative', () => {
        const fixNoHdg = makeFix(5_000, { heading: undefined as unknown as number });
        expect(getGpsNavData(fixNoHdg, false).cogDeg).toBeNull();
        const fixNeg = makeFix(5_000, { heading: -1 });
        expect(getGpsNavData(fixNeg, false).cogDeg).toBeNull();
    });
});

// ── Build 123, package VL: entries obey the phone hold, and say whose fix ──
//
// A Voyage End or a manual note used to fall through to the phone even while
// the track was refusing it (voyagelog.md, whyWrong 3d): the entry pinned at a
// car park while the track sat with the boat.
describe('getBestPosition — the phone hold and the fix source', () => {
    // Nouméa: the boat in Port Moselle, the phone at the airport.
    const PORT_MOSELLE = { latitude: -22.2796, longitude: 166.4389 };
    const TONTOUTA = { latitude: -22.0146, longitude: 166.2129 };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-07T05:00:00Z'));
        lanes.bus = null;
        lanes.pi = null;
        lanes.cloud = null;
        lanes.freshPhone = null;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('with every boat lane silent and the phone held, returns null — never the phone', async () => {
        const phone = makeFix(2_000, TONTOUTA);
        lanes.freshPhone = makeFix(500, TONTOUTA);
        await expect(getBestPosition(phone, true, { phoneAllowed: () => false })).resolves.toBeNull();
    });

    it('with the phone allowed (no boat, or a tagged stand-in), the cached phone fix is used and tagged phone', async () => {
        const phone = makeFix(2_000, TONTOUTA);
        const best = await getBestPosition(phone, true, { phoneAllowed: () => true });
        expect(best?.latitude).toBe(TONTOUTA.latitude);
        expect(best?.fixSource).toBe('phone');
    });

    it('a fresh phone fetch is tagged phone too', async () => {
        lanes.freshPhone = makeFix(500, TONTOUTA);
        const best = await getBestPosition(null, true);
        expect(best?.fixSource).toBe('phone');
    });

    it('the bus answers as the vessel; the Pi direct and her cloud row as the vessel relayed', async () => {
        lanes.bus = {
            ...PORT_MOSELLE,
            accuracy: 5,
            heading: 90,
            speed: 0,
            timestamp: Date.now() - 1_000,
            source: 'nmea',
        };
        expect((await getBestPosition(null, true, { phoneAllowed: () => false }))?.fixSource).toBe('vessel');

        lanes.bus = null;
        lanes.pi = { ...PORT_MOSELLE, timestamp: Date.now() - 2_000, rung: 'pi' };
        expect((await getBestPosition(null, true, { phoneAllowed: () => false }))?.fixSource).toBe('vessel-relay');

        lanes.pi = null;
        lanes.cloud = { ...PORT_MOSELLE, timestamp: Date.now() - 20_000, rung: 'cloud', sogKts: 0, cogDeg: null };
        const relayed = await getBestPosition(null, true, { phoneAllowed: () => false });
        expect(relayed?.latitude).toBe(PORT_MOSELLE.latitude);
        expect(relayed?.fixSource).toBe('vessel-relay');
    });

    it('her bus reached over a private network from elsewhere is tagged as the track tags it: vessel-relay', async () => {
        // Build 123 review: an entry from the same lane as the track must not
        // claim 'vessel' while the track's points from it say 'vessel-relay'.
        lanes.bus = {
            ...PORT_MOSELLE,
            accuracy: 5,
            heading: 90,
            speed: 0,
            timestamp: Date.now() - 1_000,
            source: 'nmea',
        };
        const best = await getBestPosition(null, true, {
            phoneAllowed: () => false,
            classifyBusFix: () => 'vessel-relay',
        });
        expect(best?.fixSource).toBe('vessel-relay');
    });
});
