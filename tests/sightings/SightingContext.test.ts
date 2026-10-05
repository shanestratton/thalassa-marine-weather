/**
 * Context for a sighting, with no typing: the vessel's GPS chain first (bus,
 * Pi, cloud), the phone only as a tagged stand-in, ashore when the phone is
 * far from the boat, and only fresh instrument and forecast values.
 * Fictional positions (Whitsundays) and boat.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    captureSightingContext,
    readInstruments,
    readWeather,
    type ContextDeps,
    type InstrumentState,
    type PhoneFix,
    type WeatherSnapshot,
} from '../../services/sightings/sightingContext';
import type { BoatFix } from '../../services/boatPositionChain';

const NOW = Date.parse('2026-08-14T01:20:00.000Z');
const BOAT = { lat: -20.2567, lon: 148.9512 };

const metric = (value: number | null, age = 1_000) => ({ value, lastUpdated: NOW - age, freshness: 'live' });

function instruments(overrides: Partial<InstrumentState> = {}): InstrumentState {
    return {
        waterTemp: metric(22.43),
        depth: metric(31.52),
        depthReference: 'below-transducer',
        tws: metric(14.26),
        twd: metric(121.6),
        sog: metric(5.62),
        cog: metric(349.6),
        heading: metric(340),
        headingTrue: metric(352.2),
        gpsAccuracyM: metric(4),
        ...overrides,
    };
}

function boatFix(rung: BoatFix['rung'], ageMs: number, extra: Partial<BoatFix> = {}): BoatFix {
    return { latitude: BOAT.lat, longitude: BOAT.lon, timestamp: NOW - ageMs, rung, ...extra };
}

function phone(lat: number, lon: number, accuracy = 8): PhoneFix {
    return { latitude: lat, longitude: lon, accuracy, speed: 2, heading: 10, timestamp: NOW - 2_000 };
}

const REPORT: WeatherSnapshot = {
    coordinates: { lat: -20.27, lon: 148.72 }, // ~24 km away
    generatedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    modelUsed: 'ecmwf_ifs025',
    hourly: [
        { time: '2026-08-14T00:00:00.000Z', windSpeed: 9, windDegree: 100, waveHeight: 2, waterTemperature: 22 },
        {
            time: '2026-08-14T01:00:00.000Z',
            windSpeed: 12,
            windDegree: 110,
            waveHeight: 3.28084,
            waterTemperature: 22.6,
        },
    ],
};

function deps(overrides: Partial<ContextDeps> = {}): ContextDeps {
    return {
        now: () => NOW,
        boatConfigured: async () => true,
        busFix: async () => null,
        piFix: async () => null,
        cloudFix: async () => null,
        phoneFix: async () => null,
        instruments: async () => instruments(),
        weather: async () => REPORT,
        ...overrides,
    };
}

describe('position: the vessel GPS chain', () => {
    it('takes the bus first, with the receiver accuracy, and never asks the phone', async () => {
        const phoneFix = vi.fn(async () => phone(-20.3, 148.9));
        const ctx = await captureSightingContext(deps({ busFix: async () => boatFix('bus', 2_000), phoneFix }));
        expect(ctx.position).toMatchObject({
            latitude: BOAT.lat,
            longitude: BOAT.lon,
            source: 'bus',
            accuracyM: 4,
            ashore: false,
        });
        // 4 m + 5.62 kn for 2 s ≈ 9.8 m
        expect(ctx.position?.uncertaintyM).toBe(10);
        expect(ctx.boatSilent).toBe(false);
        expect(phoneFix).not.toHaveBeenCalled();
    });

    it('skips a stale bus fix for the Pi (2 s timeout)', async () => {
        const piFix = vi.fn(async () => boatFix('pi', 10_000));
        const ctx = await captureSightingContext(deps({ busFix: async () => boatFix('bus', 20_000), piFix }));
        expect(piFix).toHaveBeenCalledWith(2_000);
        expect(ctx.position?.source).toBe('pi');
    });

    it('uses the cloud row when the phone is aboard (or has no good fix)', async () => {
        const ctx = await captureSightingContext(
            deps({
                cloudFix: async () => boatFix('cloud', 30_000, { sogKts: 6.1, cogDeg: 12 }),
                phoneFix: async () => phone(BOAT.lat + 0.001, BOAT.lon), // ~110 m: aboard
                instruments: async () => null,
            }),
        );
        expect(ctx.position).toMatchObject({ source: 'cloud', ashore: false });
        expect(ctx.samplingProtocol).toBe('opportunistic vessel-based observation');
        // Speed and course from the cloud row when no instrument has them.
        expect(ctx.sogKts).toBe(6.1);
        expect(ctx.cogDeg).toBe(12);
    });

    it('logs ashore at the phone when a good phone fix is more than 300 m from the boat', async () => {
        const ctx = await captureSightingContext(
            deps({
                cloudFix: async () => boatFix('cloud', 30_000),
                phoneFix: async () => phone(-20.27, 148.95), // ~1.5 km
            }),
        );
        expect(ctx.position).toMatchObject({ source: 'phone', ashore: true, latitude: -20.27 });
        expect(ctx.samplingProtocol).toBe('opportunistic shore-based observation');
        // The boat's instruments describe somewhere else.
        expect(ctx.seaTempSource).not.toBe('instrument');
        expect(ctx.waterDepthM).toBeNull();
        expect(ctx.headingDeg).toBeNull();
    });

    it('does not call it ashore on a poor phone fix', async () => {
        const ctx = await captureSightingContext(
            deps({
                cloudFix: async () => boatFix('cloud', 30_000),
                phoneFix: async () => phone(-20.27, 148.95, 250),
            }),
        );
        expect(ctx.position?.source).toBe('cloud');
    });

    it('falls back to the phone, tagged, and says the boat GPS is silent when one is configured', async () => {
        const ctx = await captureSightingContext(deps({ phoneFix: async () => phone(-20.25, 148.95) }));
        expect(ctx.position).toMatchObject({ source: 'phone', ashore: false, accuracyM: 8 });
        expect(ctx.boatSilent).toBe(true);

        const noBoat = await captureSightingContext(
            deps({ boatConfigured: async () => false, phoneFix: async () => phone(-20.25, 148.95) }),
        );
        expect(noBoat.boatSilent).toBe(false);
    });

    it('returns no position (not a throw) when nothing answers', async () => {
        const ctx = await captureSightingContext(
            deps({
                busFix: async () => {
                    throw new Error('socket');
                },
                phoneFix: async () => null,
            }),
        );
        expect(ctx.position).toBeNull();
        expect(ctx.wxModel).toBeNull();
    });

    it('ignores impossible fixes (null island, out of range)', async () => {
        const ctx = await captureSightingContext(
            deps({
                busFix: async () => ({ ...boatFix('bus', 1_000), latitude: 0, longitude: 0 }),
                piFix: async () => ({ ...boatFix('pi', 1_000), latitude: 95 }),
                phoneFix: async () => phone(-20.25, 148.95),
            }),
        );
        expect(ctx.position?.source).toBe('phone');
    });
});

describe("the cloud lane: the sighting's own boat, time-boxed", () => {
    const WREN = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

    it("reads the named boat's row ('self' or the skipper's id) and tags whose it was", async () => {
        const cloudFix = vi.fn(async () => boatFix('cloud', 5_000));
        const own = await captureSightingContext(deps({ cloudFix }), { vesselOwner: async () => 'self' });
        expect(cloudFix).toHaveBeenLastCalledWith('self');
        expect(own.position).toMatchObject({ source: 'cloud', cloudOwner: 'self' });
        const crewed = await captureSightingContext(deps({ cloudFix }), { vesselOwner: async () => WREN });
        expect(cloudFix).toHaveBeenLastCalledWith(WREN);
        expect(crewed.position).toMatchObject({ source: 'cloud', cloudOwner: WREN });
    });

    it('never reads a cloud row for a sighting with no boat: the phone stands in, tagged', async () => {
        const cloudFix = vi.fn(async () => boatFix('cloud', 5_000));
        const ctx = await captureSightingContext(deps({ cloudFix, phoneFix: async () => phone(-20.3, 148.9) }), {
            vesselOwner: async () => null,
        });
        expect(cloudFix).not.toHaveBeenCalled();
        expect(ctx.position).toMatchObject({ source: 'phone', ashore: false });
    });

    it('gives up on a hung cloud read after 3 s and uses the phone (bars, but no data)', async () => {
        vi.useFakeTimers();
        try {
            const pending = captureSightingContext(
                deps({
                    cloudFix: () => new Promise<BoatFix | null>(() => undefined),
                    phoneFix: async () => phone(-20.3, 148.9),
                }),
                { vesselOwner: async () => 'self' },
            );
            await vi.advanceTimersByTimeAsync(3_000);
            const ctx = await pending;
            expect(ctx.position).toMatchObject({ source: 'phone' });
            expect(ctx.boatSilent).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not even ask the cloud when the phone knows it is offline', async () => {
        const cloudFix = vi.fn(async () => boatFix('cloud', 5_000));
        const ctx = await captureSightingContext(
            deps({ cloudFix, online: () => false, phoneFix: async () => phone(-20.3, 148.9) }),
            { vesselOwner: async () => 'self' },
        );
        expect(cloudFix).not.toHaveBeenCalled();
        expect(ctx.position?.source).toBe('phone');
    });
});

describe('instruments', () => {
    it('takes fresh values only, range-checked, wind as a pair', () => {
        const fresh = readInstruments(instruments(), NOW);
        expect(fresh).toMatchObject({
            seaTempC: 22.4,
            waterDepthM: 31.52,
            depthReference: 'below-transducer',
            windSpeedKts: 14.3,
            windDirDeg: 122,
            sogKts: 5.6,
            cogDeg: 350,
            headingDeg: 352,
        });
        const stale = readInstruments(
            instruments({
                waterTemp: metric(22, 20_000),
                twd: metric(90, 20_000),
                depth: { ...metric(5), freshness: 'dead' },
            }),
            NOW,
        );
        expect(stale.seaTempC).toBeNull();
        expect(stale.waterDepthM).toBeNull();
        expect(stale.depthReference).toBeNull();
        expect(stale.windSpeedKts).toBeNull();
        expect(stale.windDirDeg).toBeNull();
        const silly = readInstruments(instruments({ waterTemp: metric(85), sog: metric(400) }), NOW);
        expect(silly.seaTempC).toBeNull();
        expect(silly.sogKts).toBeNull();
    });
});

describe('weather', () => {
    const at = { latitude: BOAT.lat, longitude: BOAT.lon, eventAt: NOW, now: NOW };

    it('uses the nearest hour, converts wave height from FEET to metres, and names the model', () => {
        expect(readWeather(REPORT, at)).toEqual({
            seaTempC: 22.6,
            windSpeedKts: 12,
            windDirDeg: 110,
            waveHeightM: 1,
            model: 'ecmwf_ifs025',
        });
    });

    it('refuses a report for somewhere else, an old report, or no hour near the sighting', () => {
        expect(readWeather({ ...REPORT, coordinates: { lat: -19.26, lon: 146.82 } }, at).model).toBeNull();
        expect(
            readWeather({ ...REPORT, generatedAt: new Date(NOW - 7 * 60 * 60 * 1000).toISOString() }, at).model,
        ).toBeNull();
        expect(readWeather(REPORT, { ...at, eventAt: NOW + 4 * 60 * 60 * 1000 }).model).toBeNull();
        expect(readWeather(null, at).model).toBeNull();
    });

    it('fills only what the instruments lack, tagged forecast', async () => {
        const ctx = await captureSightingContext(
            deps({
                busFix: async () => boatFix('bus', 1_000),
                instruments: async () => instruments({ waterTemp: metric(null), tws: metric(null) }),
            }),
        );
        expect(ctx).toMatchObject({
            seaTempC: 22.6,
            seaTempSource: 'forecast',
            windSpeedKts: 12,
            windSource: 'forecast',
            waveHeightM: 1,
            wxModel: 'ecmwf_ifs025',
            waterDepthM: 31.52,
        });
        const all = await captureSightingContext(deps({ busFix: async () => boatFix('bus', 1_000) }));
        expect(all).toMatchObject({ seaTempSource: 'instrument', windSource: 'instrument', windSpeedKts: 14.3 });
        // Waves only come from the forecast, so the model is still credited.
        expect(all.wxModel).toBe('ecmwf_ifs025');
    });
});
