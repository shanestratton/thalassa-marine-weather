/**
 * Tropical-cyclone climatology along a planned route (W1-12).
 *
 * Two layers of test:
 *  - REAL DATA: the shipped public/climatology/tc-monthly-5deg.json (built
 *    from NOAA IBTrACS v04r01 by scripts/build-tc-climatology.py) sampled
 *    along real-world passages in every cyclone basin the plan names, plus
 *    the Mediterranean and a southern-hemisphere passage across New Year.
 *    The expectations are the published basin seasons; where the data
 *    disagrees, the test follows the data and says so (the Med is 0 because
 *    IBTrACS does not cover it, and the season flags that).
 *  - SYNTHETIC: tiny hand-made climatologies that pin the counting rules —
 *    a storm crossing several boxes counts once, months follow the legs under
 *    way, the antimeridian does not wrap the globe, malformed files refuse.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    NEAR_ROUTE_BUFFER_NM,
    TC_CLIMATOLOGY_URL,
    __resetTcClimatologyCacheForTests,
    assessRouteSeason,
    boxKey,
    boxesNearRoute,
    inMediterranean,
    isInSeason,
    legArrivalIso,
    loadTcClimatology,
    monthsUnderWay,
    parseTcClimatology,
    resolveLegGeometry,
    stormsNearBoxes,
    type LatLon,
    type TcClimatology,
} from './tcClimatology';

const JSON_PATH = resolve(__dirname, '../../public/climatology/tc-monthly-5deg.json');
const loadReal = (): TcClimatology => parseTcClimatology(JSON.parse(readFileSync(JSON_PATH, 'utf8')));

const JAN = 0;
const FEB = 1;
const MAR = 2;
const APR = 3;
const MAY = 4;
const JUN = 5;
const JUL = 6;
const AUG = 7;
const SEP = 8;
const OCT = 9;
const NOV = 10;
const DEC = 11;

/** Whole-year season for one straight leg (no dates → every month). */
function seasonFor(clim: TcClimatology, points: LatLon[]) {
    const season = assessRouteSeason(clim, [{ points }]);
    expect(season).not.toBeNull();
    return season!;
}

// ── Real data ─────────────────────────────────────────────────────────

describe('tc-monthly-5deg.json — the shipped IBTrACS climatology', () => {
    it('is the 34-year IBTrACS v04r01 count on 5-degree boxes, credited and small', () => {
        const clim = loadReal();
        expect(clim.source).toBe('NOAA IBTrACS v04r01');
        expect(clim.credit).toMatch(/IBTrACS/);
        expect(clim.credit).toMatch(/v04r01/);
        expect(clim.firstYear).toBe(1991);
        expect(clim.lastYear).toBe(2024);
        expect(clim.years).toBe(34);
        expect(clim.boxDeg).toBe(5);
        expect(clim.minWindKt).toBe(34);
        // Roughly 85-90 tropical storms a year worldwide.
        expect(clim.storms).toBeGreaterThan(2500);
        expect(clim.storms).toBeLessThan(4096);
        // A static asset fetched only when the card shows: keep it small.
        expect(statSync(JSON_PATH).size).toBeLessThan(64 * 1024);
    });

    it('counts each storm once per box per month (no repeated storm in any cell-month)', () => {
        const clim = loadReal();
        let cellMonths = 0;
        for (const [key, months] of clim.cells) {
            expect(months).toHaveLength(12);
            for (const segment of months) {
                expect(segment.length % clim.idWidth).toBe(0);
                const ids = segment.match(new RegExp(`.{${clim.idWidth}}`, 'g')) ?? [];
                expect(new Set(ids).size, `duplicate storm in ${key}`).toBe(ids.length);
                if (ids.length > 0) cellMonths++;
            }
        }
        expect(cellMonths).toBeGreaterThan(1000);
    });

    it('Caribbean (Antigua → Kingston): June–November season, peak Aug–Oct, nothing in spring', () => {
        const s = seasonFor(loadReal(), [
            { lat: 17.0, lon: -61.76 },
            { lat: 17.93, lon: -76.8 },
        ]);
        for (const m of [AUG, SEP, OCT]) expect(s.inSeason[m], `month ${m}`).toBe(true);
        expect(s.monthly[SEP]).toBeGreaterThanOrEqual(10);
        for (const m of [JAN, FEB, MAR, APR]) {
            expect(s.inSeason[m], `month ${m}`).toBe(false);
            expect(s.monthly[m]).toBeLessThanOrEqual(1);
        }
    });

    it('Coral Sea (Port Vila → Cairns): Jan–Mar season, quiet June–September', () => {
        const s = seasonFor(loadReal(), [
            { lat: -17.74, lon: 168.31 },
            { lat: -16.92, lon: 145.78 },
        ]);
        for (const m of [JAN, FEB, MAR]) expect(s.inSeason[m], `month ${m}`).toBe(true);
        expect(s.monthly[FEB]).toBeGreaterThanOrEqual(10);
        for (const m of [JUN, JUL, AUG, SEP]) {
            expect(s.inSeason[m], `month ${m}`).toBe(false);
            expect(s.monthly[m]).toBeLessThanOrEqual(1);
        }
    });

    it('NW Pacific (Naha → Hong Kong): July–October season, quiet in February', () => {
        const s = seasonFor(loadReal(), [
            { lat: 26.2, lon: 127.68 },
            { lat: 22.29, lon: 114.17 },
        ]);
        for (const m of [JUL, AUG, SEP, OCT]) expect(s.inSeason[m], `month ${m}`).toBe(true);
        expect(s.monthly[AUG]).toBeGreaterThanOrEqual(20);
        expect(s.inSeason[FEB]).toBe(false);
    });

    it('Bay of Bengal (Chennai → Chittagong): two seasons, May and Oct–Nov, with a monsoon lull', () => {
        const s = seasonFor(loadReal(), [
            { lat: 13.08, lon: 80.29 },
            { lat: 22.33, lon: 91.81 },
        ]);
        for (const m of [MAY, OCT, NOV]) expect(s.inSeason[m], `month ${m}`).toBe(true);
        for (const m of [FEB, MAR]) expect(s.inSeason[m], `month ${m}`).toBe(false);
        expect(s.monthly[JUL]).toBeLessThan(s.monthly[NOV]);
        expect(s.monthly[JUL]).toBeLessThan(s.monthly[MAY]);
        // The North Indian Ocean's 1991–1995 fixes all carry NATURE "NR" (not
        // reported), which is not "not tropical". Dropping them lost the April
        // 1991 Bangladesh cyclone (1991113N10091, landfall at Chittagong) and
        // left this April at 5; counting NR puts it back.
        expect(s.monthly[APR]).toBeGreaterThanOrEqual(6);
        expect(s.monthly[NOV]).toBeGreaterThanOrEqual(30);
    });

    it('Arabian Sea (Mumbai → Muscat): November is in season (1993316N11070 is an NR-only storm)', () => {
        const s = seasonFor(loadReal(), [
            { lat: 18.94, lon: 72.84 },
            { lat: 23.61, lon: 58.59 },
        ]);
        expect(s.monthly[NOV]).toBeGreaterThanOrEqual(4);
        expect(s.inSeason[NOV]).toBe(true);
        expect(s.inSeason[JUN]).toBe(true);
        for (const m of [JAN, FEB, MAR]) expect(s.inSeason[m], `month ${m}`).toBe(false);
    });

    it('states its counting rule: TS anywhere, unreported/disputed nature only in the tropics, never ET', () => {
        const raw = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { rule: string };
        expect(raw.rule).toMatch(/NATURE TS, or NATURE NR or MX within 30 degrees of the equator/);
        expect(raw.rule).toMatch(/ET, SS and DS never count/);
    });

    it('does not count the post-tropical tail (NR/MX poleward of 30°) as tropical cyclones', () => {
        // Sydney → Lord Howe Island: February has 2 storms reported tropical
        // (NATURE TS) near the route. Counting NR/MX at any latitude adds the
        // South Pacific's unreported post-tropical tail and makes it 4.
        const s = seasonFor(loadReal(), [
            { lat: -33.86, lon: 151.21 },
            { lat: -31.55, lon: 159.08 },
        ]);
        expect(s.monthly[FEB]).toBeLessThanOrEqual(2);
        expect(s.mediterranean).toBe(false);
    });

    it('Mediterranean (Palma → Valletta, Marseille → Piraeus): 0 in IBTrACS, flagged as not covered', () => {
        // The truth of the data: no RSMC reports medicanes, so IBTrACS holds no
        // tropical system in the Med under this rule (only three extratropical
        // Atlantic remnants pass nearby). The 0 stays, and the season says the
        // Med is a gap so the card can say so.
        const clim = loadReal();
        for (const route of [
            [
                { lat: 39.57, lon: 2.65 },
                { lat: 35.9, lon: 14.51 },
            ],
            [
                { lat: 43.3, lon: 5.37 },
                { lat: 37.94, lon: 23.65 },
            ],
        ]) {
            const s = seasonFor(clim, route);
            expect(s.monthly).toEqual(new Array(12).fill(0));
            expect(s.inSeason.some(Boolean)).toBe(false);
            expect(s.mediterranean).toBe(true);
        }
    });

    it('flags the Mediterranean only on routes that enter it', () => {
        const clim = loadReal();
        const routes: Array<[string, LatLon[], boolean]> = [
            [
                'Caribbean',
                [
                    { lat: 17.0, lon: -61.76 },
                    { lat: 17.93, lon: -76.8 },
                ],
                false,
            ],
            [
                'Coral Sea',
                [
                    { lat: -17.74, lon: 168.31 },
                    { lat: -16.92, lon: 145.78 },
                ],
                false,
            ],
            [
                'NW Pacific',
                [
                    { lat: 26.2, lon: 127.68 },
                    { lat: 22.29, lon: 114.17 },
                ],
                false,
            ],
            [
                'Atlantic into the Med (Lisbon → Gibraltar)',
                [
                    { lat: 38.7, lon: -9.15 },
                    { lat: 36.13, lon: -5.35 },
                ],
                true,
            ],
        ];
        for (const [name, points, med] of routes) {
            expect(seasonFor(clim, points).mediterranean, name).toBe(med);
        }
    });

    it('South Pacific across New Year (Suva → Nukuʻalofa, 20 Dec → 8 Jan): both months in season', () => {
        const clim = loadReal();
        const season = assessRouteSeason(clim, [
            {
                points: [
                    { lat: -18.14, lon: 178.42 },
                    { lat: -21.14, lon: -175.2 },
                ],
                departureIso: '2026-12-20T12:00:00Z',
                arrivalIso: '2027-01-08T12:00:00Z',
            },
        ])!;
        expect(season.planned.map((p) => p.month)).toEqual([DEC, JAN]);
        for (const p of season.planned) {
            expect(p.inSeason).toBe(true);
            expect(p.count).toBeGreaterThanOrEqual(4);
        }
        // 2024364S17177 (a provisional track, NATURE NR) is a December storm
        // here: 13 reported-tropical storms plus it.
        expect(season.planned[0].count).toBeGreaterThanOrEqual(14);
        expect(season.mediterranean).toBe(false);
        for (const m of [DEC, JAN, FEB, MAR]) expect(season.inSeason[m], `month ${m}`).toBe(true);
        for (const m of [JUL, AUG]) expect(season.inSeason[m], `month ${m}`).toBe(false);
        // Crossing 180° must not sweep the boxes of the whole globe.
        expect(season.boxCount).toBeLessThanOrEqual(8);
    });
});

// ── Synthetic rules ───────────────────────────────────────────────────

/** A 12-segment cell from {month: tokens}. */
function cell(months: Partial<Record<number, string>>): string {
    return Array.from({ length: 12 }, (_, m) => months[m] ?? '').join('|');
}

function synthetic(cells: Record<string, string>, extra: Record<string, unknown> = {}) {
    return {
        format: 'thalassa.tc-climatology',
        version: 1,
        source: 'NOAA IBTrACS v04r01',
        credit: 'Synthetic test data (IBTrACS v04r01 shape)',
        accessed: '2026-10-08',
        firstYear: 1991,
        lastYear: 2024,
        boxDeg: 5,
        minWindKt: 34,
        storms: 99,
        idWidth: 2,
        cells,
        ...extra,
    };
}

describe('boxesNearRoute', () => {
    it('keys boxes by their south-west corner', () => {
        expect(boxKey(17.0, -61.76, 5)).toBe('15,-65');
        expect(boxKey(-17.74, 168.31, 5)).toBe('-20,165');
        expect(boxKey(0, 0, 5)).toBe('0,0');
        expect(boxKey(-0.1, -0.1, 5)).toBe('-5,-5');
        // 180°E is the same meridian as 180°W.
        expect(boxKey(-18, 180, 5)).toBe('-20,-180');
    });

    it('stays inside one box when the route is well clear of its edges', () => {
        const boxes = boxesNearRoute([
            { lat: 12.0, lon: 62.0 },
            { lat: 13.0, lon: 63.0 },
        ]);
        expect([...boxes]).toEqual(['10,60']);
    });

    it(`adds the next box when the route passes within ${NEAR_ROUTE_BUFFER_NM} NM of its edge`, () => {
        // 14.5°N is 30 NM south of the 15°N box edge.
        const boxes = boxesNearRoute([
            { lat: 14.5, lon: 62.0 },
            { lat: 14.5, lon: 63.0 },
        ]);
        expect(boxes).toEqual(new Set(['10,60', '15,60']));
    });

    it(`measures ${NEAR_ROUTE_BUFFER_NM} NM to the nearest point of a box, not a lat/lon rectangle`, () => {
        // 14.2°N 60.85°W: 48 NM south of 15°N and 49 NM west of 60°W, so the
        // boxes north and east are near — but the north-east box's nearest
        // point is its corner, ~69 NM away, so it is not.
        const boxes = boxesNearRoute([{ lat: 14.2, lon: -60.85 }]);
        expect(boxes).toEqual(new Set(['10,-65', '15,-65', '10,-60']));
        expect(boxes.has('15,-60')).toBe(false);
    });

    it('crosses the antimeridian the short way', () => {
        const boxes = boxesNearRoute([
            { lat: -17.5, lon: 177.5 },
            { lat: -17.5, lon: -177.5 },
        ]);
        expect(boxes).toEqual(new Set(['-20,175', '-20,-180']));
    });

    it('needs at least one finite point', () => {
        expect(boxesNearRoute([]).size).toBe(0);
        expect(boxesNearRoute([{ lat: Number.NaN, lon: 0 }]).size).toBe(0);
    });
});

describe('inMediterranean — where IBTrACS has no coverage (medicanes)', () => {
    it.each([
        ['Strait of Gibraltar', 36.0, -5.4, true],
        ['Ionian Sea (Ianos 2020)', 37.8, 20.5, true],
        ['Gulf of Sidra (Daniel 2023)', 32.0, 19.0, true],
        ['Northern Adriatic', 45.5, 13.2, true],
        ['Gulf of Cádiz (Atlantic)', 36.5, -7.0, false],
        ['Bay of Biscay', 44.5, -3.0, false],
        ['Black Sea', 42.5, 31.0, false],
        ['Red Sea', 22.0, 38.0, false],
        ['Caribbean', 17.0, -70.0, false],
    ])('%s', (_name, lat, lon, med) => {
        expect(inMediterranean(lat, lon)).toBe(med);
    });
});

describe('stormsNearBoxes — a storm counts once however many boxes it crosses', () => {
    const clim = parseTcClimatology(
        synthetic({
            '10,60': cell({ [SEP]: 'AAABAC', [OCT]: 'AD' }),
            '15,60': cell({ [SEP]: 'AAAE' }),
        }),
    );

    it('unions storms across boxes in the same month', () => {
        // AA crossed both boxes: counted once. AB, AC, AE once each.
        expect(stormsNearBoxes(clim, ['10,60', '15,60'], SEP)).toBe(4);
        expect(stormsNearBoxes(clim, ['10,60'], SEP)).toBe(3);
        expect(stormsNearBoxes(clim, ['10,60', '15,60'], OCT)).toBe(1);
        expect(stormsNearBoxes(clim, ['10,60', '15,60'], MAR)).toBe(0);
    });

    it('treats boxes the file does not list as storm-free', () => {
        expect(stormsNearBoxes(clim, ['40,10'], SEP)).toBe(0);
    });
});

describe('monthsUnderWay — departure month, every month at sea, arrival month', () => {
    it('one month when the leg starts and ends in it', () => {
        expect(monthsUnderWay('2026-09-03T12:00:00Z', '2026-09-20T12:00:00Z')).toEqual([SEP]);
    });

    it('wraps across the year boundary', () => {
        expect(monthsUnderWay('2026-12-20T12:00:00Z', '2027-01-08T12:00:00Z')).toEqual([DEC, JAN]);
    });

    it('includes the months in between on a long passage', () => {
        expect(monthsUnderWay('2026-01-15T12:00:00Z', '2026-04-10T12:00:00Z')).toEqual([JAN, FEB, MAR, APR]);
    });

    it('falls back to the departure month without a usable arrival', () => {
        expect(monthsUnderWay('2026-06-15T12:00:00Z', null)).toEqual([JUN]);
        expect(monthsUnderWay('2026-06-15T12:00:00Z', '2026-05-01T12:00:00Z')).toEqual([JUN]);
        expect(monthsUnderWay('2026-06-15T12:00:00Z', 'not a date')).toEqual([JUN]);
    });

    it('never lists more than twelve months, and nothing without a departure', () => {
        expect(monthsUnderWay('2026-03-15T12:00:00Z', '2028-03-15T12:00:00Z')).toHaveLength(12);
        expect(monthsUnderWay(null, '2026-03-15T12:00:00Z')).toEqual([]);
        expect(monthsUnderWay('garbage', null)).toEqual([]);
    });
});

describe('assessRouteSeason', () => {
    const clim = parseTcClimatology(
        synthetic({
            // Leg A's box: busy in February (5 storms), one in July.
            '-20,165': cell({ [FEB]: 'AAABACADAE', [JUL]: 'AF' }),
            // Leg B's box: busy in March (4 storms; AA also crossed leg A's box in February).
            '-20,150': cell({ [MAR]: 'AABBBCBD' }),
        }),
    );
    const legA = {
        points: [
            { lat: -17.5, lon: 166.5 },
            { lat: -17.5, lon: 168.0 },
        ],
        departureIso: '2026-02-10T12:00:00Z',
        arrivalIso: '2026-02-14T12:00:00Z',
    };
    const legB = {
        points: [
            { lat: -17.5, lon: 151.5 },
            { lat: -17.5, lon: 153.0 },
        ],
        departureIso: '2026-03-02T12:00:00Z',
        arrivalIso: '2026-03-06T12:00:00Z',
    };

    it('counts each planned month over only the legs under way in it', () => {
        const s = assessRouteSeason(clim, [legA, legB])!;
        expect(s.planned).toEqual([
            { month: FEB, count: 5, inSeason: true },
            { month: MAR, count: 4, inSeason: true },
        ]);
    });

    it('builds the 12-month strip over the whole route', () => {
        const s = assessRouteSeason(clim, [legA, legB])!;
        expect(s.monthly[FEB]).toBe(5);
        expect(s.monthly[MAR]).toBe(4);
        expect(s.monthly[JUL]).toBe(1);
        expect(s.inSeason[FEB]).toBe(true);
        // One storm in 34 years is below one-a-decade.
        expect(s.inSeason[JUL]).toBe(false);
        expect(s.years).toBe(34);
        expect(s.boxCount).toBe(2);
    });

    it('has no planned months when no leg has a date, and is null without geometry', () => {
        expect(assessRouteSeason(clim, [{ points: legA.points }])!.planned).toEqual([]);
        expect(assessRouteSeason(clim, [{ points: [] }])).toBeNull();
        expect(assessRouteSeason(clim, [])).toBeNull();
    });

    it('calls a month in season at one storm a decade or more', () => {
        expect(isInSeason(4, 34)).toBe(true);
        expect(isInSeason(3, 34)).toBe(false);
        expect(isInSeason(0, 34)).toBe(false);
        expect(isInSeason(1, 10)).toBe(true);
    });
});

describe('parseTcClimatology refuses a file it cannot trust', () => {
    it('accepts the synthetic shape', () => {
        const clim = parseTcClimatology(synthetic({ '10,60': cell({ [SEP]: 'AA' }) }));
        expect(clim.cells.get('10,60')?.[SEP]).toBe('AA');
    });

    it.each([
        ['wrong format', synthetic({}, { format: 'something-else' })],
        ['future version', synthetic({}, { version: 2 })],
        ['missing years', synthetic({}, { firstYear: undefined })],
        ['bad id width', synthetic({}, { idWidth: 0 })],
        ['eleven months', synthetic({ '10,60': 'AA||||||||||' })],
        ['ragged ids', synthetic({ '10,60': cell({ [SEP]: 'AAA' }) })],
        ['bad key', synthetic({ north: cell({}) })],
        ['not an object', null],
    ])('%s', (_label, raw) => {
        expect(() => parseTcClimatology(raw)).toThrow();
    });
});

describe('resolveLegGeometry — the saved route first, never a guess across trips', () => {
    const line = (lat: number): LatLon[] => [
        { lat, lon: 150 },
        { lat, lon: 151 },
    ];
    const baseLeg = {
        id: 'voyage-7',
        departure_port: 'Port Alpha',
        destination_port: 'Port Beta',
        departure_time: '2026-02-10T12:00:00Z',
        eta: null,
    };
    const routes = [
        { label: 'Port Alpha → Port Beta', points: line(-10) },
        { label: 'Somewhere → Else', points: line(-11), savedRouteId: 'trace-3' },
        { label: 'Other → Place', points: line(-12), linkedPlanId: 'voyage-7' },
    ];

    it("uses the row's own geometry when it carries one", () => {
        expect(resolveLegGeometry({ ...baseLeg, routeCoordinates: line(-20) }, routes)).toEqual(line(-20));
    });

    it('then the planned route linked to this voyage id', () => {
        expect(resolveLegGeometry(baseLeg, routes)).toEqual(line(-12));
    });

    it('then the canonical saved route id', () => {
        expect(resolveLegGeometry({ ...baseLeg, id: 'voyage-8', saved_route_id: 'trace-3' }, routes)).toEqual(
            line(-11),
        );
    });

    it('then the "Departure → Arrival" label', () => {
        expect(resolveLegGeometry({ ...baseLeg, id: 'voyage-9' }, routes)).toEqual(line(-10));
    });

    it('then a straight line between known end points, else nothing', () => {
        const ends = { departureCoords: { lat: 1, lon: 2 }, arrivalCoords: { lat: 3, lon: 4 } };
        expect(resolveLegGeometry({ ...baseLeg, id: 'x', destination_port: 'Nowhere', ...ends }, routes)).toEqual([
            { lat: 1, lon: 2 },
            { lat: 3, lon: 4 },
        ]);
        expect(resolveLegGeometry({ ...baseLeg, id: 'x', destination_port: 'Nowhere' }, routes)).toBeNull();
    });

    it('takes the arrival from the ETA, else departure + planned duration', () => {
        expect(legArrivalIso({ ...baseLeg, eta: '2026-02-20T12:00:00Z' })).toBe('2026-02-20T12:00:00Z');
        expect(legArrivalIso({ ...baseLeg, durationHours: 48 })).toBe('2026-02-12T12:00:00.000Z');
        expect(legArrivalIso({ ...baseLeg, departure_time: null })).toBeNull();
    });
});

describe('loadTcClimatology — fetched lazily, once, from the static asset', () => {
    afterEach(() => {
        __resetTcClimatologyCacheForTests();
    });

    it('fetches the public JSON once and caches the parsed result', async () => {
        const body = synthetic({ '10,60': cell({ [SEP]: 'AA' }) });
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
        const a = await loadTcClimatology(fetchImpl);
        const b = await loadTcClimatology(fetchImpl);
        expect(a).toBe(b);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith(TC_CLIMATOLOGY_URL);
        expect(TC_CLIMATOLOGY_URL).toBe('/climatology/tc-monthly-5deg.json');
    });

    it('does not cache a failure, so the next open can retry', async () => {
        const body = synthetic({});
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response('nope', { status: 503 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
        await expect(loadTcClimatology(fetchImpl)).rejects.toThrow();
        await expect(loadTcClimatology(fetchImpl)).resolves.toBeTruthy();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
