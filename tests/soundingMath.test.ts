/**
 * The sounding sheet's maths (build 125, SND), checked against values worked
 * by hand from the approved mock-up's formulas: Magnus dewpoint, Bolton's LCL,
 * the pseudo-adiabatic parcel, the freezing level, the strongest inversion
 * below 700 hPa and the dry "trade lid". Fictional profiles only, from three
 * regimes: Caribbean trades, a North Sea winter and a subsidence inversion
 * off the Canary Islands.
 */
import { describe, expect, it } from 'vitest';
import {
    barbParts,
    cloudBaseMetres,
    dryLid,
    fillMissingHeights,
    freezingLevelMetres,
    lclBolton,
    magnusDewpoint,
    parcelTemperature,
    strongestInversion,
    surfacePressureHpa,
    toKnots,
    warmNose,
    type SoundingLevel,
} from '../services/weather/sounding/soundingMath';

const level = (p: number, t: number, td: number, z: number | null): SoundingLevel => ({
    p,
    t,
    td,
    z,
    windKmh: null,
    windFrom: null,
});

/** Caribbean trades (fictional): moist below 925 hPa, dry above 850. */
const TRADES: SoundingLevel[] = [
    level(1013, 26, 21, 0),
    level(1000, 24.5, 20, 120),
    level(925, 20, 17, 790),
    level(850, 17.5, 4, 1530),
    level(700, 9, -8, 3160),
    level(500, -6, -30, 5880),
    level(300, -32, -55, 9650),
    level(250, -42, -62, 10950),
];

/** North Sea, January (fictional): a cold surface, 0 °C just above 500 m. */
const NORTH_SEA_WINTER: SoundingLevel[] = [
    level(1004, 4, 2, 0),
    level(1000, 3.6, 1.5, 40),
    level(925, -1, -3, 680),
    level(850, -6, -9, 1330),
    level(700, -15, -22, 2850),
    level(500, -32, -40, 5350),
    level(300, -55, -62, 8800),
    level(250, -57, -66, 10000),
];

/** Off the Canary Islands (fictional): a 5 °C subsidence inversion between
 *  1000 and 925 hPa, and a weaker 0.5 °C one above it. */
const CANARIES_SUBSIDENCE: SoundingLevel[] = [
    level(1016, 18, 15, 0),
    level(1000, 16.5, 14, 135),
    level(925, 21.5, 2, 800),
    level(850, 22, -5, 1520),
    level(700, 8, -15, 3140),
    level(500, -12, -35, 5820),
    level(300, -38, -50, 9500),
    level(250, -48, -58, 10800),
];

describe('Magnus dewpoint', () => {
    it('matches the hand-worked value at 25 °C and 70 %', () => {
        expect(magnusDewpoint(25, 70)).toBeCloseTo(19.148, 2);
    });
    it('works below freezing and is exact at saturation', () => {
        expect(magnusDewpoint(-10, 50)).toBeCloseTo(-18.468, 2);
        expect(magnusDewpoint(12, 100)).toBeCloseTo(12, 6);
    });
    it('treats 0 % humidity as 1 % rather than taking the log of zero', () => {
        expect(magnusDewpoint(30, 0)).toBeCloseTo(-31.96, 1);
        expect(Number.isFinite(magnusDewpoint(30, 0))).toBe(true);
    });
});

describe('cloud base (LCL)', () => {
    it("finds Bolton's LCL temperature and pressure", () => {
        const lcl = lclBolton(30, 20, 1010);
        expect(lcl.tK).toBeCloseTo(290.815, 2);
        expect(lcl.pHpa).toBeCloseTo(873.3, 0);
    });
    it('gives the North Sea winter LCL from a 4/2 °C surface', () => {
        expect(lclBolton(4, 2, 1004).pHpa).toBeLessThan(1004);
        expect(lclBolton(6, 2, 1004).pHpa).toBeCloseTo(944.1, 0);
    });
    it('rounds the 125 m per degree spread to the nearest 50 m', () => {
        expect(cloudBaseMetres(30, 20)).toBe(1250);
        expect(cloudBaseMetres(26, 21)).toBe(650); // 625 rounds up
        expect(cloudBaseMetres(4, 2)).toBe(250);
        expect(cloudBaseMetres(15, 15)).toBe(0);
    });
});

describe('the rising parcel', () => {
    const surface = { p: 1010, t: 30, td: 20 };
    it('follows the dry adiabat below the LCL', () => {
        expect(parcelTemperature(950, surface)).toBeCloseTo(24.74, 1);
        expect(parcelTemperature(900, surface)).toBeCloseTo(20.18, 1);
    });
    it('follows the pseudo-adiabat above it', () => {
        expect(parcelTemperature(700, surface)).toBeCloseTo(9.51, 1);
        expect(parcelTemperature(500, surface)).toBeCloseTo(-4.27, 1);
        expect(parcelTemperature(250, surface)).toBeCloseTo(-41.31, 1);
    });
});

describe('surface pressure from the sea-level value', () => {
    it('is the sea-level pressure at sea level', () => {
        expect(surfacePressureHpa(1020, 0, 20)).toBeCloseTo(1020, 6);
    });
    it('falls with height by the hypsometric equation', () => {
        expect(surfacePressureHpa(1013, 1000, 15)).toBeCloseTo(900.9, 0);
    });
});

describe('freezing level', () => {
    it('interpolates between 700 and 500 hPa in the trades', () => {
        // 9 °C at 3,160 m, −6 °C at 5,880 m: 0 °C is 9/15 of the way up.
        expect(freezingLevelMetres(TRADES)).toBeCloseTo(4792, 0);
    });
    it('sits just above 500 m on a North Sea winter day', () => {
        expect(freezingLevelMetres(NORTH_SEA_WINTER)).toBeCloseTo(540.9, 0);
    });
    it('takes the lowest crossing, and the surface when it is already freezing there', () => {
        const warmNose: SoundingLevel[] = [
            level(1010, -2, -4, 0),
            level(925, 1.5, 0, 700),
            level(850, -3, -6, 1400),
            level(700, -12, -20, 2900),
        ];
        expect(freezingLevelMetres(warmNose)).toBe(0);
        const twoCrossings: SoundingLevel[] = [
            level(1010, 3, 1, 0),
            level(925, -1, -3, 700),
            level(850, 2, -6, 1400),
            level(700, -8, -20, 2900),
        ];
        expect(freezingLevelMetres(twoCrossings)).toBeCloseTo(525, 0);
    });
    it('is null when nothing in the column reaches 0 °C', () => {
        expect(freezingLevelMetres([level(1010, 30, 20, 0), level(850, 22, 10, 1500)])).toBeNull();
    });
});

describe('heights a partial sync left out', () => {
    // Gulf of St Lawrence, autumn (fictional): the 700 hPa height did not sync.
    const GAP: SoundingLevel[] = [
        level(1008, 9, 6, 0),
        level(1000, 8, 5.5, 65),
        level(925, 6, 3, 700),
        level(850, 4, 1, 1400),
        level(700, -4, -9, null),
        level(500, -20, -30, 5500),
    ];

    it('fills a missing height from the level below by the hypsometric equation', () => {
        const filled = fillMissingHeights(GAP);
        // 850→700 hPa at a mean virtual temperature of 0.6 °C is 1,556 m thick.
        expect(filled[4].z).toBeCloseTo(2956, 0);
        expect(filled.map((q) => q.z)).toEqual([0, 65, 700, 1400, filled[4].z, 5500]);
        // Nothing else changes, and a complete profile comes back as it went in.
        expect(filled[4]).toEqual({ ...GAP[4], z: filled[4].z });
        expect(fillMissingHeights(NORTH_SEA_WINTER)).toEqual(NORTH_SEA_WINTER);
    });

    it('so the freezing level is found across the gap, not lost above it', () => {
        expect(freezingLevelMetres(GAP)).toBeNull();
        // 4 °C at 1,400 m, −4 °C at 2,956 m: half-way, 2,178 m.
        expect(freezingLevelMetres(fillMissingHeights(GAP))).toBeCloseTo(2178, 0);
    });
});

describe('a warm nose over freezing air', () => {
    it('finds the warmest layer above 0 °C below 700 hPa when the surface is freezing', () => {
        // The Baltic in January (fictional): −3 °C at the surface, +1.5 °C at 925 hPa.
        const baltic: SoundingLevel[] = [
            level(1012, -3, -3.6, 0),
            level(1000, -2, -2.5, 95),
            level(925, 1.5, 1, 720),
            level(850, -2, -2.8, 1390),
            level(700, -9, -10, 2900),
        ];
        expect(warmNose(baltic)).toEqual({ p: 925, t: 1.5 });
    });

    it('is null over a surface above freezing, and ignores warmth above 700 hPa', () => {
        expect(warmNose(TRADES)).toBeNull();
        expect(warmNose([level(1010, -1, -2, 0), level(850, -5, -6, 1400), level(500, 1, -20, 5500)])).toBeNull();
    });
});

describe('inversions below 700 hPa', () => {
    it('finds the strongest inversion, not the last one', () => {
        expect(strongestInversion(CANARIES_SUBSIDENCE)).toEqual({ baseHpa: 1000, topHpa: 925, warmingC: 5 });
    });
    it('ignores warming above 700 hPa and finds none in the trades', () => {
        const aloft: SoundingLevel[] = [
            level(1013, 20, 15, 0),
            level(850, 12, 5, 1500),
            level(700, 4, -5, 3100),
            level(500, 6, -20, 5800),
        ];
        expect(strongestInversion(aloft)).toBeNull();
        expect(strongestInversion(TRADES)).toBeNull();
    });
});

describe('the dry lid', () => {
    it('finds the trade lid: lapse under 3.5 °C/km with the dewpoint dropping more than 5 °C', () => {
        const lid = dryLid(TRADES);
        expect(lid).not.toBeNull();
        expect(lid!.baseHpa).toBe(925);
        expect(lid!.topHpa).toBe(850);
        expect(lid!.baseM).toBe(790);
        expect(lid!.topM).toBe(1530);
        expect(lid!.lapseCPerKm).toBeCloseTo(3.378, 2);
        expect(lid!.dewpointDropC).toBeCloseTo(13, 6);
    });
    it('finds none in a North Sea winter column, which cools at a normal rate', () => {
        expect(dryLid(NORTH_SEA_WINTER)).toBeNull();
    });
    it('does not call an inversion layer a lid', () => {
        // 1000→925 and 925→850 both warm with height (inversions, not lids),
        // and 850→700 cools at 8.6 °C/km: no lid in this column.
        expect(dryLid(CANARIES_SUBSIDENCE)).toBeNull();
    });
});

describe('wind barbs', () => {
    it('converts every skipper unit to knots', () => {
        expect(toKnots(50, 'kts')).toBe(50);
        expect(toKnots(92.6, 'kmh')).toBeCloseTo(50, 6);
        expect(toKnots(25.7, 'mps')).toBeCloseTo(49.957, 2);
        expect(toKnots(40, 'mph')).toBeCloseTo(34.759, 2);
    });
    it('draws the same pennant for 50 kt, 92.6 km/h and 25.7 m/s', () => {
        for (const [speed, unit] of [
            [50, 'kts'],
            [92.6, 'kmh'],
            [25.7, 'mps'],
        ] as const) {
            expect(barbParts(speed, unit)).toEqual({ knots: 50, pennants: 1, full: 0, half: 0, calm: false });
        }
    });
    it('adds full and half barbs to the nearest 5 kt', () => {
        expect(barbParts(65, 'kts')).toEqual({ knots: 65, pennants: 1, full: 1, half: 1, calm: false });
        expect(barbParts(40, 'mph')).toEqual({ knots: 35, pennants: 0, full: 3, half: 1, calm: false });
        expect(barbParts(7, 'kts')).toEqual({ knots: 5, pennants: 0, full: 0, half: 1, calm: false });
    });
    it('is calm under 2.5 kt', () => {
        expect(barbParts(4, 'kmh')).toEqual({ knots: 0, pennants: 0, full: 0, half: 0, calm: true });
    });
});
