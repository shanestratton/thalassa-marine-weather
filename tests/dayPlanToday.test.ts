/**
 * Plan Your Day, build 124 — "Today on the water" (services/dayPlanner/today.ts).
 *
 * Pure engine, synthetic 7-model point blocks and route forecasts. Shane's
 * own case first (Coral Sea Marina, Airlie Beach, 8 October 2026, a south-east
 * trade), then the honesty rules: a missing gust never passes, the end of the
 * forecast is never Inside, times are the PLACE's, and a rough day still
 * lists every place with a reason. Non-Australian fixtures alongside: Marseille
 * on a 25-hour day, Tromsø under the midnight sun, Nouméa with no atlas.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CruisingPoint } from '../services/anchorages/cruisingReference';
import { DEFAULT_CRUISING_POLAR } from '../services/defaultPolar';
import { gatherPlaces, type AtlasFeature, type GatheredPlaces } from '../services/dayPlanner/places';
import {
    compactWindow,
    departureScore,
    departureScoreTerms,
    type ScoredDeparture,
} from '../services/passageDepartureSuggestion';
import {
    areaVerdict,
    dayParts,
    dayWindow,
    distanceLine,
    hhmm,
    partCell,
    pickHeadlineMember,
    planDay,
    pointHours,
    resolveDayPlanLimits,
    stopDetail,
    type DayPlanInput,
    type DayPlanLimits,
    type DayPlanView,
    type StopLegs,
} from '../services/dayPlanner/today';
import type { PassageSpeedModel } from '../services/passagePlan';
import type { RouteForecast } from '../services/routeForecastSampler';
import type { RouteSea } from '../services/routeSeaSampler';
import type { RouteSpread } from '../services/routeForecastSpread';
import { routeLengthNm, pointAlongRoute } from '../services/routeProgress';
import type { AtmosVar, SpreadBlock } from '../services/weather/ModelSpreadService';
import { ATMOS_VARS } from '../services/weather/ModelSpreadService';
import { COMPARE_MODELS } from '../services/weather/forecastModels';
import { getFirstLight, getLastLight, localNoon } from '../utils/celestial';
import { DEFAULT_VESSEL } from '../utils/defaultVessel';

const H = 3_600_000;
const BRISBANE = 'Australia/Brisbane';
/** 06:30 on Thursday 8 October 2026 at Airlie Beach. */
const NOW = Date.UTC(2026, 9, 7, 20, 30);
const MARINA = { lat: -20.265, lon: 148.719, name: 'Coral Sea Marina' };

const SAIL: PassageSpeedModel = {
    mode: 'polar',
    cruiseKts: 6,
    isSail: true,
    polar: DEFAULT_CRUISING_POLAR,
    closeHauledDeg: 40,
};
const DEFAULT_LIMITS = resolveDayPlanLimits(undefined, DEFAULT_VESSEL, true);

// ── Synthetic forecasts ────────────────────────────────────────

interface MemberHour {
    kts: number | null;
    dir: number | null;
    gust?: number | null;
    code?: number | null;
}

/** A 7-model point block, hourly from `from`. `wind(model, t)` per member. */
function atmos(from: number, wind: (model: number, t: number) => MemberHour, hours = 96): SpreadBlock<AtmosVar> {
    const times = Array.from({ length: hours }, (_, h) => from + h * H);
    return {
        times,
        models: COMPARE_MODELS.map((m, i) => {
            const values = Object.fromEntries(ATMOS_VARS.map((v) => [v, times.map(() => null)])) as Record<
                AtmosVar,
                (number | null)[]
            >;
            const at = times.map((t) => wind(i, t));
            values.wind_speed_10m = at.map((x) => x.kts);
            values.wind_direction_10m = at.map((x) => x.dir);
            // AIFS and JMA publish no gust, as in life.
            values.wind_gusts_10m = at.map((x) =>
                m.missing?.includes('gust') ? null : x.gust === undefined ? (x.kts ?? 0) + 5 : x.gust,
            );
            values.weather_code = at.map((x) => x.code ?? 2);
            return { id: m.id, label: m.label, provider: m.provider, hex: m.hex, values };
        }),
    };
}

/** The south-east trade: seven members 13–17 kn from about 135°. */
const trade = (from: number) => atmos(from, (m) => ({ kts: 13 + (m % 5), dir: 130 + m * 2 }));

const ROUTE_MODELS = ['ecmwf_ifs025', 'dwd_icon', 'ecmwf_aifs025_single', 'ukmo_global_deterministic_10km', 'jma_gsm'];

interface LegWind {
    kts: number | null;
    dir: number;
    gust: number | null;
}

function routeForecast(
    model: string,
    coords: { lat: number; lon: number }[],
    wind: (frac: number, t: number) => LegWind,
    from: number,
    hours = 72,
): RouteForecast {
    const total = routeLengthNm(coords);
    const n = Math.max(2, Math.ceil(total / 4) + 1);
    const times = Array.from({ length: hours }, (_, h) => from + h * H);
    return {
        model,
        fetchedAt: from,
        totalNm: total,
        stations: Array.from({ length: n }, (_, i) => {
            const alongNm = (total * i) / (n - 1);
            const at = pointAlongRoute(coords, alongNm)!;
            const frac = i / (n - 1);
            const w = times.map((t) => wind(frac, t));
            return {
                alongNm,
                lat: at.lat,
                lon: at.lon,
                timesMs: [...times],
                speedKts: w.map((x) => x.kts),
                dirDeg: w.map((x) => x.dir),
                gustKts: w.map((x) => x.gust),
                precipMm: times.map(() => 0),
                precipProb: times.map(() => 0),
            };
        }),
    };
}

function routeSea(coords: { lat: number; lon: number }[], from: number, waveM = 0.5): RouteSea {
    const total = routeLengthNm(coords);
    const n = Math.max(4, Math.ceil(total / 4) + 1);
    const times = Array.from({ length: 72 }, (_, h) => from + h * H);
    return {
        fetchedAt: from,
        totalNm: total,
        stations: Array.from({ length: n }, (_, i) => {
            const alongNm = (total * i) / (n - 1);
            const at = pointAlongRoute(coords, alongNm)!;
            // Both ends are inside the reef or at a berth: no reading there.
            const inshore = i === 0 || i === n - 1;
            return {
                alongNm,
                lat: at.lat,
                lon: at.lon,
                snapKm: inshore ? 9 : 3,
                inshore,
                timesMs: [...times],
                waveM: times.map(() => (inshore ? null : waveM)),
                wavePeriodS: times.map(() => 5),
                waveFromDeg: times.map(() => 130),
                currentKts: times.map(() => 0.2),
                currentSetDeg: times.map(() => 300),
            };
        }),
    };
}

/** Legs for every stop the view asked for: a headline plus a five-model spread. */
function legsFor(
    view: DayPlanView,
    wind: (frac: number, t: number) => LegWind,
    options: { memberGust?: (model: string) => number | null; hours?: number; from?: number } = {},
): Map<string, StopLegs> {
    const from = options.from ?? Math.floor(NOW / H) * H;
    const out = new Map<string, StopLegs>();
    for (const need of view.needsLegs) {
        const members: Record<string, RouteForecast> = {};
        ROUTE_MODELS.forEach((model, i) => {
            members[model] = routeForecast(
                model,
                need.coords,
                (frac, t) => {
                    const w = wind(frac, t);
                    const gust = options.memberGust ? options.memberGust(model) : w.gust;
                    return { kts: w.kts === null ? null : w.kts + (i - 2) * 0.5, dir: w.dir, gust };
                },
                from,
                options.hours,
            );
        });
        const spread: RouteSpread = { asked: [...ROUTE_MODELS], members, missing: [], fetchedAt: from };
        const picked = pickHeadlineMember(spread, 'ecmwf_ifs025', ROUTE_MODELS)!;
        out.set(need.id, {
            headline: picked.forecast,
            headlineModel: 'ECMWF',
            substituted: picked.substituted,
            spread,
            sea: routeSea(need.coords, from),
        });
    }
    return out;
}

// ── Places ─────────────────────────────────────────────────────

const QLD_TILE = JSON.parse(readFileSync('public/anchorages/qld/t-22e148.geojson', 'utf8')) as {
    features: AtlasFeature[];
};

function whitsundayPlaces(): GatheredPlaces {
    return gatherPlaces({
        start: MARINA,
        nowMs: NOW,
        radiusNm: 30,
        atlas: QLD_TILE.features,
        osm: [],
        coastline: null,
    });
}

function osmPoint(node: number, name: string, lat: number, lon: number): CruisingPoint {
    return {
        id: `osm-node${node}`,
        kind: 'anchorage',
        name,
        lat,
        lon,
        colours: [],
        band: null,
        mooringClass: null,
        access: '',
        notes: '',
        source: 'OpenStreetMap',
        sourceUrl: `https://www.openstreetmap.org/node/${node}`,
        retrievedAt: new Date(NOW - H).toISOString(),
        approximate: false,
        restrictionNotes: [],
    };
}

function input(over: Partial<DayPlanInput> = {}): DayPlanInput {
    return {
        nowMs: NOW,
        zone: BRISBANE,
        start: MARINA,
        stay: '2h',
        limits: DEFAULT_LIMITS,
        speed: SAIL,
        usingDefaultVessel: false,
        atmos: trade(Math.floor(NOW / H) * H),
        weather: 'ok',
        places: whitsundayPlaces(),
        tides: [
            { time: new Date(Date.UTC(2026, 9, 8, 0, 52)).toISOString(), type: 'High', height: 3.1 },
            { time: new Date(Date.UTC(2026, 9, 8, 7, 3)).toISOString(), type: 'Low', height: 0.9 },
            { time: new Date(Date.UTC(2026, 9, 8, 13, 10)).toISOString(), type: 'High', height: 3.0 },
        ],
        ...over,
    };
}

/** Plan once, load the legs it asks for, plan again — as the loader will. */
function planWithLegs(
    over: Partial<DayPlanInput>,
    wind: (frac: number, t: number) => LegWind,
    options?: Parameters<typeof legsFor>[2],
): DayPlanView {
    const first = planDay(input(over));
    return planDay(input({ ...over, legs: legsFor(first, wind, options) }));
}

const SE_TRADE = (): LegWind => ({ kts: 15, dir: 135, gust: 20 });

// ── 1. Shane's case ────────────────────────────────────────────

describe("Shane's case: Coral Sea Marina, Thursday 8 October, a south-east trade", () => {
    const view = planWithLegs({}, SE_TRADE);

    it('opens on today, with a leave window for at least one stop', () => {
        expect(view.date).toBe('2026-10-08');
        expect(view.isToday).toBe(true);
        expect(view.tooLate).toBe(false);
        expect(view.top.length).toBeGreaterThanOrEqual(1);
        expect(view.top.some((row) => (row.plan?.window.length ?? 0) >= 1)).toBe(true);
        for (const row of view.top) expect(row.line2).toMatch(/^Leave \d\d:\d\d · there \d\d:\d\d · home \d\d:\d\d$/);
    });

    it('puts Cid Harbour in the top three', () => {
        expect(view.top.map((row) => row.name).join(' | ')).toMatch(/Cid Harbour/);
    });

    it('reads Nara Inlet as closed by Queensland Parks, and never scores it', () => {
        const nara = view.notToday.find((row) => row.id === 'osm-node2838871153');
        expect(nara?.reason).toBe('closed 6–15 Oct (Queensland Parks)');
        expect(view.ranked.map((stop) => stop.candidate.id)).not.toContain('osm-node2838871153');
    });

    it('Whitehaven either fits, is listed with its route weather not checked, or reads home after dark', () => {
        const id = 'osm-node2982151597';
        const fits = view.fits.some((row) => row.id === id);
        const unchecked = view.unchecked.some((row) => row.id === id);
        const dark = view.notToday.find((row) => row.id === id)?.reason ?? '';
        expect(fits || unchecked || /home after dark/.test(dark)).toBe(true);
    });

    it('only a stop whose own route weather was checked is listed as fitting', () => {
        expect(view.fits.length).toBeGreaterThan(0);
        for (const row of view.fits) {
            expect(row.plan?.weatherLoaded).toBe(true);
            expect(['inside', 'near']).toContain(row.level);
        }
        // The rest of the ranked stops: "route weather not checked", never "Fits".
        expect(view.unchecked.length).toBeGreaterThan(0);
        for (const row of view.unchecked) expect(row.line2).toMatch(/route weather not checked$/);
    });

    it('Cid Harbour keeps its Parks shark warning, under the stay, in its detail', () => {
        const cid = view.top.find((row) => row.id === 'osm-node3020491514')!;
        expect(cid.candidate.reviewed?.accessNotes.join(' ')).toMatch(/Do not swim in Cid Harbour.*sharks/);
        const detail = stopDetail({
            plan: cid.plan!,
            stay: '2h',
            window: view.window,
            speed: SAIL,
            polarIsOwn: false,
            leavingMarina: true,
        });
        const ashore = detail.rows.findIndex((row) => row.startsWith('Ashore '));
        const shark = detail.rows.findIndex((row) => /^Do not swim in Cid Harbour: .*sharks/.test(row));
        expect(ashore).toBeGreaterThan(-1);
        expect(shark).toBeGreaterThan(ashore);
        // The catalogue's shared boilerplate is said once elsewhere, not per stop.
        expect(detail.rows.join(' ')).not.toMatch(/bring-your-own picnic|Position is an existing mapped/);
    });

    it('Chance Bay is held at Some chop in the south-east trade its Parks note warns of', () => {
        // Its baked land table reads 0.1–0.4 NM from 090° to 160°: "Very sheltered" by geometry alone.
        const chance = view.ranked.find((stop) => stop.candidate.id === 'osm-node8925547809')!;
        expect(chance.stay?.grade).toBe('tenable');
        expect(chance.stay?.reasons[0]).toBe('South-easterlies can make access difficult (Queensland Parks)');
        const row = [...view.fits, ...view.unchecked].find((r) => r.id === 'osm-node8925547809');
        expect(row?.shelter).toBe('Some chop');
    });

    it('reads its limits from the default boat and its times in the place’s zone', () => {
        expect(view.window.firstLightMs).not.toBeNull();
        expect(view.facts.text).toMatch(/^☀ 05:\d\d–18:\d\d · HW 10:52 · LW 17:03$/);
        expect(view.facts.ariaLabel).toMatch(/^Light 05:\d\d to 18:\d\d, high water 10:52, low water 17:03$/);
        expect(view.parts.map((p) => p.part)).toEqual(['morning', 'afternoon', 'evening']);
        // A 14 kn median against the default boat's 13 kn comfortable wind.
        for (const part of view.parts) expect(part.level).toBe('near');
    });

    it('never offers the marina, and drops Airlie Bay (under 1 NM away)', () => {
        const ids = view.ranked.map((stop) => stop.candidate.id);
        expect(ids).not.toContain('osm-way245930150');
        expect(ids).not.toContain('osm-node2541206070');
    });
});

describe('an overnight stay', () => {
    it('runs to 09:00 local the next day, there by half an hour before last light, with no trip home', () => {
        const view = planWithLegs({ stay: 'overnight' }, SE_TRADE);
        expect(view.top.length).toBeGreaterThanOrEqual(1);
        for (const row of view.top) {
            expect(row.line2).toMatch(/^Leave \d\d:\d\d · there \d\d:\d\d · about \d+ NM$/);
            const best = row.plan!.best!;
            expect(best.home).toBeNull();
            expect(best.homeMs).toBeNull();
            expect(hhmm(best.stayEndMs!, BRISBANE)).toBe('09:00');
            expect(best.arriveMs!).toBeLessThanOrEqual(view.window.lastLightMs! - 30 * 60_000);
        }
    });
});

// ── 2. Limits ──────────────────────────────────────────────────

describe('limits are the skipper’s own', () => {
    it('Comfort settings beat the vessel thresholds, metric by metric; 5.9 ft is 1.8 m', () => {
        const limits = resolveDayPlanLimits({ maxWindKts: 18 }, null, false);
        expect(limits.wind).toEqual({ good: 14.4, poor: 18, source: 'comfort' });
        expect(limits.gust).toEqual({ good: 20, poor: 28, source: 'default' });
        expect(limits.wave.poor).toBe(1.8);
        expect(limits.wave.good).toBe(1);
        expect(limits.wave.source).toBe('default');

        const boat = resolveDayPlanLimits({ maxWaveM: 1.2 }, DEFAULT_VESSEL, false);
        expect(boat.wind).toEqual({ good: 13, poor: 20, source: 'vessel' });
        expect(boat.gust).toEqual({ good: 18, poor: 25, source: 'vessel' });
        expect(boat.wave.poor).toBe(1.2);
        expect(boat.wave.good).toBeCloseTo(0.96, 6);
        expect(boat.wave.source).toBe('comfort');
    });
});

// ── 3. A split day ─────────────────────────────────────────────

describe('a split day', () => {
    it('is capped at Near and the headline says the models are split', () => {
        const spreadKts = [9, 11, 14, 16, 18, 21, 24];
        const limits: DayPlanLimits = resolveDayPlanLimits({ maxWindKts: 30, maxGustKts: 40 }, null, false);
        const view = planDay(
            input({
                limits,
                atmos: atmos(Math.floor(NOW / H) * H, (m) => ({ kts: spreadKts[m], dir: 135, gust: spreadKts[m] + 4 })),
            }),
        );
        for (const part of view.parts) {
            expect(part.split).toBe(true);
            expect(part.level).toBe('near');
        }
        expect(view.headline.text).toMatch(/^Models split this morning: SE 9 to 24 kn\. Plan for the strong end\./);
    });
});

// ── Thunder, from the models' own weather codes ────────────────

describe('thunder', () => {
    it('comes from weather_code in the point block, and is named in the part it falls in', () => {
        expect(ATMOS_VARS).toContain('weather_code');
        const limits = resolveDayPlanLimits({ maxWindKts: 25, maxGustKts: 35 }, null, false);
        const block = atmos(Math.floor(NOW / H) * H, (m) => ({ kts: 10, dir: 90, code: m < 3 ? 95 : 3 }));
        const view = planDay(input({ limits, atmos: block }));
        expect(view.parts[0].thunder).toBe(3);
        expect(view.parts[0].level).toBe('near');
        const cell = partCell(view.parts[0], 7);
        expect(cell.word).toBe('Thunder');
        expect(cell.glyph).toBe('≈');
        expect(cell.ariaLabel).toMatch(/, near your wind limits, thunder in 3 of 7 models$/);
    });

    it('stays out of the headline, which keeps its line budget (it ran to five lines at 320 px)', () => {
        const limits = resolveDayPlanLimits({ maxWindKts: 30, maxGustKts: 40 }, null, false);
        const kts = [9, 11, 14, 16, 18, 21, 24];
        const block = atmos(Math.floor(NOW / H) * H, (m) => ({ kts: kts[m], dir: 135, code: m < 3 ? 95 : 3 }));
        const view = planDay(input({ limits, atmos: block }));
        expect(view.parts.every((p) => p.thunder === 3)).toBe(true);
        expect(view.headline.text).toBe('Models split this morning: SE 9 to 24 kn. Plan for the strong end.');
        expect(view.headline.text).not.toMatch(/Thunder/);
    });
});

// ── 4. Over all day ────────────────────────────────────────────

describe('over all day', () => {
    const SAT = Date.UTC(2026, 9, 9, 14);
    const gale = atmos(Math.floor(NOW / H) * H, (m, t) =>
        t >= SAT ? { kts: 8 + (m % 3), dir: 120 } : { kts: 26 + (m % 5), dir: 135, gust: 35 },
    );
    const view = planWithLegs({ atmos: gale }, () => ({ kts: 28, dir: 135, gust: 35 }));

    it('says Stay put, and offers the lighter day', () => {
        expect(view.headline.text).toMatch(/^Stay put today: SE \d+(–\d+)? kn, gusts 35, over your limits all day\.$/);
        expect(view.headline.link).toEqual({ label: 'Sat looks lighter ›', date: '2026-10-10' });
    });

    it('beyond the best three, the wind in the area rules each stop out: nothing is listed as fitting', () => {
        expect(view.state).toBe('stay-put');
        expect(view.fits).toEqual([]);
        expect(view.unchecked).toEqual([]);
        const swept = new Set(view.top.map((row) => row.id));
        const rest = view.ranked.filter((stop) => !swept.has(stop.candidate.id));
        expect(rest.length).toBeGreaterThan(5);
        for (const stop of rest) {
            const reason = view.notToday.find((row) => row.id === stop.candidate.id)?.reason ?? '';
            expect(reason).toMatch(/^over your limits: (SE \d+ kn|gusts \d+ kn) in the area$|^over your limits: /);
        }
        // e.g. Chance Bay, "very sheltered" by its land table, in a 29 kn day.
        const chance = view.notToday.find((row) => row.id === 'osm-node8925547809');
        expect(chance?.reason).toBe('over your limits: SE 27 kn in the area');
    });

    it('still lists every place, ranked, each with a plain reason', () => {
        expect(view.top.length).toBeGreaterThanOrEqual(2);
        for (const row of view.top) {
            expect(row.level).toBe('over');
            expect(row.glyph).toBe('✕');
            expect(row.reason).toMatch(/over your limits/);
        }
        expect(view.notToday.length).toBeGreaterThanOrEqual(view.top.length);
        const listed = new Set([...view.fits, ...view.unchecked, ...view.notToday].map((row) => row.id));
        for (const stop of view.ranked) expect(listed.has(stop.candidate.id)).toBe(true);
    });
});

describe('a day over her limits with a gap in it', () => {
    it('lists a stop that fits the gap with that, never under "Fits" beneath "Stay put"', () => {
        // A blow all day but 07:00–13:00 local, at a fictional bight 6 NM off.
        const gapFrom = Date.UTC(2026, 9, 7, 21);
        const gapTo = Date.UTC(2026, 9, 8, 3);
        const blow = atmos(Math.floor(NOW / H) * H, (m, t) =>
            t >= gapFrom && t < gapTo ? { kts: 9 + (m % 3), dir: 135 } : { kts: 27 + (m % 3), dir: 135, gust: 36 },
        );
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osmPoint(9301, 'Fictional Gap Bight', -20.265, 148.8254)], stale: false }],
            coastline: null,
        });
        const view = planWithLegs({ atmos: blow, places, stay: '1h' }, (_, t) =>
            t >= gapFrom && t < gapTo ? { kts: 10, dir: 135, gust: 14 } : { kts: 28, dir: 135, gust: 36 },
        );
        expect(view.state).toBe('stay-put');
        expect(view.top[0].level).toBe('near');
        expect(view.fits).toEqual([]);
        expect(view.notToday.find((row) => row.name === 'Fictional Gap Bight')?.reason).toMatch(
            /^over your limits most of the day \(a gap: leave 07:00\)$/,
        );
    });

    it('a departure is Over whenever the strip is Over for the hours she is under way', () => {
        // The route model is light (12 kn), but the seven at the point say 27–29 after 09:00.
        const after9 = Date.UTC(2026, 9, 7, 23);
        const block = atmos(Math.floor(NOW / H) * H, (m, t) =>
            t < after9 ? { kts: 9 + (m % 3), dir: 135 } : { kts: 27 + (m % 3), dir: 135, gust: 34 },
        );
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osmPoint(9302, 'Fictional Far Reach', -20.265, 149.05)], stale: false }],
            coastline: null,
        });
        const view = planWithLegs({ atmos: block, places }, () => ({ kts: 12, dir: 135, gust: 16 }));
        const best = view.top[0].plan!.best!;
        expect(best.level).toBe('over');
        expect(best.reason).toBe('over your limits: SE 28 kn in the area');
    });
});

describe('the sea, when nothing along the way reads it', () => {
    const limits = resolveDayPlanLimits({ maxWindKts: 30, maxGustKts: 40, maxWaveM: 3 }, null, false);
    const calm = atmos(Math.floor(NOW / H) * H, (m) => ({ kts: 7 + (m % 2), dir: 135, gust: 11 }));
    const cid = () =>
        gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: QLD_TILE.features.filter((f) => f.properties.id === 'osm-node3020491514'),
            osm: [],
            coastline: null,
        });
    const light = () => ({ kts: 8, dir: 135, gust: 12 });

    it('with a reading, a calm day is Inside, and the headline says it is the WIND that is', () => {
        const view = planWithLegs({ limits, atmos: calm, places: cid() }, light);
        expect(view.top[0].level).toBe('inside');
        expect(view.headline.text).toMatch(/^Inside your wind limits all day\./);
        expect(partCell(view.parts[0]).ariaLabel).toMatch(/inside your wind limits$/);
    });

    it('with none (the sea did not load), the same stop is Near at best, and says why', () => {
        const first = planDay(input({ limits, atmos: calm, places: cid() }));
        const legs = legsFor(first, light);
        for (const [id, leg] of legs) legs.set(id, { ...leg, sea: null });
        const view = planDay(input({ limits, atmos: calm, places: cid(), legs }));
        expect(view.top[0].level).toBe('near');
        const detail = stopDetail({
            plan: view.top[0].plan!,
            stay: '2h',
            window: view.window,
            speed: SAIL,
            polarIsOwn: false,
            leavingMarina: false,
        });
        expect(detail.rows).toContain("Sea: not checked, the wave forecast didn't load");
    });

    it('with none inshore (every station snapped too far), Near at best too', () => {
        const first = planDay(input({ limits, atmos: calm, places: cid() }));
        const legs = legsFor(first, light);
        for (const [id, leg] of legs) {
            const sea = leg.sea!;
            legs.set(id, {
                ...leg,
                sea: {
                    ...sea,
                    stations: sea.stations.map((st) => ({ ...st, inshore: true, waveM: st.waveM.map(() => null) })),
                },
            });
        }
        const view = planDay(input({ limits, atmos: calm, places: cid(), legs }));
        expect(view.top[0].level).toBe('near');
    });
});

describe('shelter not known', () => {
    it('is never Inside: an OpenStreetMap stop with no coastline is held at Near', () => {
        const limits = resolveDayPlanLimits({ maxWindKts: 30, maxGustKts: 40, maxWaveM: 3 }, null, false);
        const calm = atmos(Math.floor(NOW / H) * H, (m) => ({ kts: 7 + (m % 2), dir: 135, gust: 11 }));
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osmPoint(9303, 'Fictional Open Cove', -20.265, 148.8254)], stale: false }],
            coastline: null,
        });
        const view = planWithLegs({ limits, atmos: calm, places }, () => ({ kts: 8, dir: 135, gust: 12 }));
        expect(view.top[0].shelter).toBe('Shelter not known');
        expect(view.top[0].level).toBe('near');
        expect(view.top[0].glyph).toBe('≈');
    });
});

describe('a stop whose route weather failed', () => {
    it('shows no times (they would be a no-wind walk), and is listed as weather that did not load', () => {
        const first = planDay(input({}));
        const legs = new Map(
            first.needsLegs.map((need) => [
                need.id,
                { headline: null, headlineModel: 'ECMWF', spread: null, sea: null, failed: true } as StopLegs,
            ]),
        );
        const view = planDay(input({ legs }));
        for (const row of view.top) {
            expect(row.line2).toMatch(/^About \d+ NM · weather not checked$/);
            expect(row.glyph).toBe('?');
            expect(view.notToday.find((r) => r.id === row.id)?.reason).toBe("weather didn't load");
        }
        expect(view.fits).toEqual([]);
    });
});

describe('places still loading', () => {
    it('never says "no anchorages mapped" while OpenStreetMap is still answering', () => {
        const empty = gatherPlaces({ start: MARINA, nowMs: NOW, radiusNm: 30, atlas: [], osm: [], coastline: null });
        const loading = planDay(input({ places: empty, placesStatus: 'loading' }));
        expect(loading.state).not.toBe('no-places');
        expect(loading.headline.text).not.toMatch(/No anchorages mapped/);
        const settled = planDay(input({ places: empty, placesStatus: 'ok' }));
        expect(settled.state).toBe('no-places');
        expect(settled.headline.text).toBe('No anchorages mapped near here in OpenStreetMap.');
    });
});

describe('the earliest leave', () => {
    it('is never the Plan page departure: the morning is not hidden, and 06:30 is not too late', () => {
        const window = dayWindow({ date: '2026-10-08', lat: MARINA.lat, lon: MARINA.lon, zone: BRISBANE, nowMs: NOW });
        expect(hhmm(window.earliestLeaveMs!, BRISBANE)).toBe('07:00');
        const view = planDay(input({}));
        expect(view.tooLate).toBe(false);
        expect(view.date).toBe('2026-10-08');
    });
});

describe('areaVerdict', () => {
    it('finds the calm hours: a stop is out only when every departure meets the blow', () => {
        const blowFrom = Date.UTC(2026, 9, 8, 2); // 12:00 local
        const block = atmos(Math.floor(NOW / H) * H, (m, t) =>
            t < blowFrom ? { kts: 9, dir: 135 } : { kts: 30, dir: 135, gust: 38 },
        );
        const view = planDay(input({ atmos: block }));
        const hours = pointHours(block);
        const near = view.ranked.find((stop) => stop.estNm < 6)!;
        const far = view.ranked.find((stop) => stop.estNm > 20)!;
        expect(areaVerdict(near, view.window, '1h', hours, DEFAULT_LIMITS)).toBeNull();
        expect(areaVerdict(far, view.window, '4h', hours, DEFAULT_LIMITS)).toBe(
            'over your limits: SE 30 kn in the area',
        );
    });
});

// ── 5. Too late ────────────────────────────────────────────────

describe('opened at 16:00', () => {
    it('is too late for a day out and shows tomorrow', () => {
        const at4 = Date.UTC(2026, 9, 8, 6);
        const view = planDay(input({ nowMs: at4, atmos: trade(at4) }));
        expect(view.tooLate).toBe(true);
        expect(view.date).toBe('2026-10-09');
        expect(view.headline.text).toMatch(/^Too late for a day out: last light 18:\d\d\. Showing tomorrow\.$/);
    });
});

// ── 6. The mirror regression ───────────────────────────────────

describe('a 6 NM round trip', () => {
    it('samples the stop station on the way home', () => {
        // Fictional bight 6 NM east of the start: 5 kn at the start, 25 at the stop.
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osmPoint(9001, 'Fictional Bight', -20.265, 148.8254)], stale: false }],
            coastline: null,
        });
        const limits = resolveDayPlanLimits({ maxWindKts: 40, maxGustKts: 50 }, null, false);
        const view = planWithLegs({ places, limits }, (frac) => ({ kts: 5 + 20 * frac, dir: 0, gust: 30 }));
        const best = view.top[0].plan!.best!;
        expect(best.home).not.toBeNull();
        expect(best.home!.hiKts).toBeGreaterThanOrEqual(24);
        expect(best.home!.loKts).toBeLessThanOrEqual(6);
    });
});

// ── 7. Gusts ───────────────────────────────────────────────────

describe('gusts', () => {
    const places = () =>
        gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osmPoint(9002, 'Fictional Reach', -20.265, 148.8254)], stale: false }],
            coastline: null,
        });

    it('fall back to the spread’s gust max when the headline model publishes none', () => {
        const view = planWithLegs({ places: places() }, () => ({ kts: 10, dir: 0, gust: null }), {
            memberGust: (model) => (model === 'dwd_icon' ? 30 : model === 'ukmo_global_deterministic_10km' ? 22 : null),
        });
        const best = view.top[0].plan!.best!;
        expect(best.maxGustKts).toBe(30);
        expect(best.level).toBe('over');
    });

    it('with no gust at all a departure is never Inside', () => {
        const view = planWithLegs({ places: places() }, () => ({ kts: 8, dir: 0, gust: null }), {
            memberGust: () => null,
        });
        const best = view.top[0].plan!.best!;
        expect(best.gustComplete).toBe(false);
        expect(best.level).toBe('near');
    });

    it('with no gust in the point block a part is capped at Near', () => {
        const calm = atmos(Math.floor(NOW / H) * H, () => ({ kts: 8, dir: 135, gust: null }));
        const view = planDay(input({ atmos: calm }));
        for (const part of view.parts) {
            expect(part.noGust).toBe(true);
            expect(part.level).toBe('near');
        }
    });
});

// ── 8. Beyond the forecast ─────────────────────────────────────

describe('beyond the forecast', () => {
    it('is Unknown, never Inside', () => {
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osmPoint(9003, 'Fictional Shoal Bay', -20.265, 148.8254)], stale: false }],
            coastline: null,
        });
        const view = planWithLegs({ places }, () => ({ kts: 8, dir: 0, gust: 12 }), { hours: 2 });
        const plan = view.top[0].plan!;
        for (const departure of plan.departures) expect(departure.level).not.toBe('inside');
        expect(plan.best!.level).toBe('unknown');
        expect(view.top[0].glyph).toBe('?');
    });
});

// ── 9. A 25-hour day in Marseille, on a phone in Brisbane ─────

describe('Europe/Paris on 25 October 2026, the device in Australia/Brisbane', () => {
    const restore = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = BRISBANE;
    });
    afterAll(() => {
        if (restore === undefined) delete process.env.TZ;
        else process.env.TZ = restore;
    });

    it('cuts the parts of the day and labels them on Paris time', () => {
        // Node re-reads TZ when it is assigned: the phone really is in Brisbane.
        expect(new Date(Date.UTC(2026, 9, 25, 0)).getHours()).toBe(10);
        const zone = 'Europe/Paris';
        const start = { lat: 43.29, lon: 5.35, name: 'Vieux-Port' };
        const now = Date.UTC(2026, 9, 25, 5);
        const window = dayWindow({ date: '2026-10-25', lat: start.lat, lon: start.lon, zone, nowMs: now });
        // 06:00 CET; the clocks went back at 03:00 CEST.
        expect(window.isToday).toBe(true);
        const block = atmos(Date.UTC(2026, 9, 24, 22), () => ({ kts: 8, dir: 320 }));
        const parts = dayParts(window, pointHours(block), DEFAULT_LIMITS, now);
        expect(parts[1].startMs).toBe(Date.UTC(2026, 9, 25, 11));
        expect(parts[2].startMs).toBe(Date.UTC(2026, 9, 25, 15));

        const noon = localNoon('2026-10-25', zone);
        const first = getFirstLight(noon, start.lat, start.lon, zone, 'civil').at!.getTime();
        const last = getLastLight(noon, start.lat, start.lon, zone, 'civil').at!.getTime();
        const paris = (ms: number) =>
            new Intl.DateTimeFormat('en-GB', {
                timeZone: zone,
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
            }).format(ms);
        expect(window.firstLightMs).toBe(first);
        expect(hhmm(first, zone)).toBe(paris(first));

        const view = planDay(
            input({
                nowMs: now,
                zone,
                start,
                atmos: block,
                places: gatherPlaces({
                    start,
                    nowMs: now,
                    radiusNm: 30,
                    atlas: [],
                    osm: [{ points: [osmPoint(9004, 'Calanque fictive', 43.21, 5.45)], stale: false }],
                    coastline: null,
                }),
                tides: null,
            }),
        );
        expect(view.date).toBe('2026-10-25');
        expect(view.facts.text).toBe(`☀ ${paris(first)}–${paris(last)} · No tide prediction here`);
        expect(view.chips.map((c) => c.label)).toEqual(['Today', 'Mon', 'Tue']);
        expect(view.chips[1].ariaLabel).toMatch(/^Monday 26 October, /);
    });
});

// ── 10. Midnight sun ───────────────────────────────────────────

describe('Tromsø on 21 June 2026', () => {
    it('says light all day and caps the plan at 14 h', () => {
        const zone = 'Europe/Oslo';
        const start = { lat: 69.65, lon: 18.96, name: 'Tromsø' };
        const now = Date.UTC(2026, 5, 21, 6);
        const window = dayWindow({ date: '2026-06-21', lat: start.lat, lon: start.lon, zone, nowMs: now });
        expect(window.light).toBe('no-true-night');
        expect(window.lastLightMs! - window.firstLightMs!).toBe(14 * H);
        const view = planDay(input({ nowMs: now, zone, start, atmos: trade(now), places: null, tides: null }));
        expect(view.facts.text).toBe('☀ Light all day: plan capped at 14 h · No tide prediction here');
    });
});

// ── 11. No anchoring; marinas ──────────────────────────────────

describe('no-anchoring points and marinas', () => {
    it('a no-anchoring point goes to Not today; a marina is never a destination', () => {
        const view = planWithLegs({}, SE_TRADE);
        const luncheon = view.notToday.find((row) => row.id === 'osm-node2838870586');
        expect(luncheon?.reason).toBe('no anchoring here');
        const marinaIds = QLD_TILE.features.filter((f) => f.properties.kind === 'marina').map((f) => f.properties.id);
        for (const row of [...view.top, ...view.fits]) expect(marinaIds).not.toContain(row.id);
    });
});

// ── 12. A saved route ──────────────────────────────────────────

describe('a saved route that joins start and stop', () => {
    it('gives basis saved, its geometry and its length', () => {
        const stop = { lat: -20.24511, lon: 148.94836 };
        const route = {
            name: 'Airlie → Cid',
            points: [{ lat: MARINA.lat, lon: MARINA.lon }, { lat: -20.3, lon: 148.85 }, stop],
        };
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: QLD_TILE.features.filter((f) => f.properties.id === 'osm-node3020491514'),
            osm: [],
            coastline: null,
            savedRoutes: [route],
        });
        const view = planDay(input({ places }));
        const cid = view.ranked.find((stop) => stop.candidate.id === 'osm-node3020491514')!;
        expect(cid.candidate.distance.basis).toBe('saved');
        expect(cid.candidate.distance.nm).toBeCloseTo(routeLengthNm(route.points), 6);
        expect(view.needsLegs.find((need) => need.id === 'osm-node3020491514')?.coords).toEqual(route.points);
        expect(distanceLine(cid.candidate.distance)).toBe(
            `${cid.candidate.distance.nm.toFixed(1)} NM each way (your saved route 'Airlie → Cid')`,
        );
    });
});

// ── 13. Offline ────────────────────────────────────────────────

describe('offline', () => {
    it('lists places by distance with weather not checked, and still shows the light', () => {
        const view = planDay(input({ atmos: null, weather: 'offline' }));
        expect(view.needsLegs).toEqual([]);
        expect(view.top.length).toBeGreaterThanOrEqual(2);
        const distances = view.top.map((row) => row.candidate.distance.nm);
        expect([...distances].sort((a, b) => a - b)).toEqual(distances);
        for (const row of view.top) {
            expect(row.level).toBeNull();
            expect(row.glyph).toBe('?');
            expect(row.line2).toMatch(/^About \d+ NM · weather not checked$/);
        }
        for (const part of view.parts) expect(part.level).toBe('none');
        expect(view.facts.text).toMatch(/^☀ 05:\d\d–18:\d\d · HW/);
        expect(view.notices.top?.text).toBe('Offline: light and cached tides only');
    });
});

// ── 14. The default boat ───────────────────────────────────────

describe('the default boat', () => {
    it('still gives options, with the notice to set hers', () => {
        const view = planWithLegs({ usingDefaultVessel: true }, SE_TRADE);
        expect(view.top.length).toBeGreaterThanOrEqual(1);
        expect(view.notices.top).toEqual(
            expect.objectContaining({ kind: 'default-boat', text: 'Typical 6 kn boat: set yours in Vessel ›' }),
        );
    });
});

// ── Nouméa: worldwide, no atlas ────────────────────────────────

describe('Nouméa, with OpenStreetMap only', () => {
    it('plans from mapped anchorages with no Queensland data at all', () => {
        const zone = 'Pacific/Noumea';
        const start = { lat: -22.284, lon: 166.436, name: 'Port Moselle' };
        const now = Date.UTC(2026, 9, 7, 19, 30);
        const places = gatherPlaces({
            start,
            nowMs: now,
            radiusNm: 30,
            atlas: [],
            osm: [
                {
                    points: [
                        osmPoint(9101, 'Baie fictive', -22.33, 166.47),
                        osmPoint(9102, 'Îlot fictif', -22.4, 166.35),
                    ],
                    stale: false,
                },
            ],
            coastline: null,
        });
        expect(places.region).toBeNull();
        const view = planWithLegs(
            { nowMs: now, zone, start, places, atmos: trade(Math.floor(now / H) * H), tides: null },
            SE_TRADE,
            { from: Math.floor(now / H) * H },
        );
        expect(view.top.map((row) => row.name)).toEqual(expect.arrayContaining(['Baie fictive']));
        for (const row of view.top) expect(row.parks).toBe(false);
    });
});

// ── 15. The departure-score extraction ─────────────────────────

describe('departureScore and compactWindow (shared with the passage HUD)', () => {
    const at = (h: number, over: Partial<ScoredDeparture> = {}): ScoredDeparture => ({
        departureMs: NOW + h * H,
        maxWindKts: 10,
        maxHeadwindKts: 4,
        maxGustKts: 20,
        maxWaveM: 1,
        gustComplete: true,
        waveComplete: true,
        ...over,
    });

    it('scores wind, headwind, gust and wave, but gust and wave only when every candidate has them', () => {
        expect(departureScore(at(0), { gusts: true, waves: true })).toBeCloseTo(10 + 1.4 + 5 + 5, 9);
        expect(departureScoreTerms([at(0), at(1)])).toEqual({ gusts: true, waves: true });
        const terms = departureScoreTerms([at(0), at(1, { gustComplete: false })]);
        expect(terms).toEqual({ gusts: false, waves: true });
        expect(departureScore(at(0), terms)).toBeCloseTo(10 + 1.4 + 5, 9);
    });

    it('a window is hourly, contiguous, within 10 % of the best and at most three hours', () => {
        const list = [at(0, { maxWindKts: 10.5 }), at(1), at(2, { maxWindKts: 10.6 }), at(3, { maxWindKts: 13 })];
        const terms = departureScoreTerms(list);
        const score = (c: ScoredDeparture) => departureScore(c, terms);
        expect(compactWindow(list, 1, score).map((c) => c.departureMs)).toEqual([NOW, NOW + H, NOW + 2 * H]);
        // A gap breaks it.
        const gappy = [at(0), at(2, { maxWindKts: 10.1 })];
        expect(compactWindow(gappy, 0, score)).toHaveLength(1);
        // Never more than three hours.
        const flat = [0, 1, 2, 3, 4, 5].map((h) => at(h));
        expect(compactWindow(flat, 0, score)).toHaveLength(4);
    });

    it('the headline is the chart’s model when it answered, else the first that did, named', () => {
        const coords = [MARINA, { lat: -20.265, lon: 148.8254 }];
        const from = Math.floor(NOW / H) * H;
        const icon = routeForecast('dwd_icon', coords, SE_TRADE, from);
        const ukmo = routeForecast('ukmo_global_deterministic_10km', coords, SE_TRADE, from);
        const spread: RouteSpread = {
            asked: [...ROUTE_MODELS],
            members: { ukmo_global_deterministic_10km: ukmo, dwd_icon: icon },
            missing: ['ecmwf_ifs025', 'ecmwf_aifs025_single', 'jma_gsm'],
            fetchedAt: from,
        };
        expect(pickHeadlineMember(spread, 'ukmo_global_deterministic_10km', ROUTE_MODELS)).toEqual({
            forecast: ukmo,
            model: 'ukmo_global_deterministic_10km',
            substituted: false,
        });
        expect(pickHeadlineMember(spread, 'ecmwf_ifs025', ROUTE_MODELS)).toEqual({
            forecast: icon,
            model: 'dwd_icon',
            substituted: true,
        });
        expect(pickHeadlineMember(null, 'ecmwf_ifs025', ROUTE_MODELS)).toBeNull();
    });
});
