/**
 * Plan Your Day, build 124 — "Today on the water" (services/dayPlanner/today.ts).
 *
 * Pure engine, synthetic 7-model point blocks and route forecasts. Shane's
 * own case first (Coral Sea Marina, Airlie Beach, 8 October 2026, a south-east
 * trade), then the honesty rules: a missing gust never passes, the end of the
 * forecast is never Inside, times are the PLACE's, and a rough day still
 * lists every place with a reason. Non-Australian fixtures alongside: Marseille
 * on a 25-hour day, Tromsø under the midnight sun, Nouméa with no atlas.
 *
 * Build 127 (127-PYD-1, "say why"): a ✕ stop says why on its own row, the
 * stop page opens on its verdict, thunder is in the headline, the day chips
 * speak her limits, and VoiceOver says each thing once, swept over every mode
 * the layout fixture draws (e2e/fixtures/day-planner.tsx).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CruisingPoint } from '../services/anchorages/cruisingReference';
import { DEFAULT_CRUISING_POLAR } from '../services/defaultPolar';
import {
    gatherPlaces,
    type AtlasFeature,
    type DistanceEstimate,
    type GatheredPlaces,
} from '../services/dayPlanner/places';
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
    stopTimes,
    type StopDetailArgs,
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
import { loadStopLegs, loadToday, todayInput, type RouteWindModels } from '../services/dayPlanner/todayLoader';
import * as fixture from './helpers/dayPlanFixtures';

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
        for (const row of view.top) expect(row.line2).toMatch(/^\d\d:\d\d → \d\d:\d\d · back \d\d:\d\d$/);
        // Near rows keep their times on line 2 (127-PYD-1): only a ✕ or ? row says why there.
        for (const row of view.top) expect([row.level, row.line2Reason]).toEqual(['near', null]);
        // The trade's members spread a little: the headline says so, in the app's own words.
        expect(view.headline.text).toBe('Near your limits at best: SE 14 kn, gusts 21. Some spread.');
    });

    // 126-17c (Shane, offered the shorter times line so they can grow: "your pick").
    it('says its times short, from the same numbers VoiceOver reads in words, never "right arrow"', () => {
        for (const row of view.top) {
            const best = row.plan!.best!;
            const [leave, arrive, home] = [best.departureMs, best.arriveMs!, best.homeMs!].map((ms) =>
                hhmm(ms, BRISBANE),
            );
            expect(row.line2).toBe(`${leave} → ${arrive} · back ${home}`);
            expect(row.line2Spoken).toBe(`Leave ${leave}, arrive ${arrive}, back home ${home}`);
            expect(row.ariaLabel.startsWith(`${row.line1}. ${row.line2Spoken}. `)).toBe(true);
            expect(row.ariaLabel).not.toMatch(/→/);
        }
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
            expect(row.line2).toMatch(/^\d\d:\d\d → \d\d:\d\d · about \d+ NM$/);
            expect(row.line2Spoken).toMatch(/^Leave \d\d:\d\d, arrive \d\d:\d\d, about \d+ nautical miles$/);
            expect(row.ariaLabel).not.toMatch(/→| NM\b/);
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
        // 127-PYD-1: the bolt, not ≈, when thunder is what holds the part at Near.
        expect(cell.glyph).toBe('⚡');
        expect(cell.ariaLabel).toMatch(/, near your wind limits, thunder in 3 of 7 models$/);
    });

    it("stays out of a split day's headline, which keeps its line budget (it ran to five lines at 320 px)", () => {
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
        // 127-PYD-1: each day chip carries that day's best part in her limits' glyph, not the models' agreement.
        expect(view.chips.map((c) => [c.label, c.best, c.glyph])).toEqual([
            ['Today', 'over', '✕'],
            ['Fri', 'over', '✕'],
            ['Sat', 'inside', '✓'],
        ]);
        expect(view.chips[2].ariaLabel).toBe('Saturday 10 October, inside your wind limits at best, Models agree');
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
            // 127-PYD-1: the reason is kept without its prefix, shown on the row, said once.
            expect(row.reason).toMatch(/^SE \d+ kn on the way$/);
            expect(row.line2Reason).toBe(row.reason);
            expect(row.ariaLabel).toBe(`${row.line1}. over your limits: ${row.reason}`);
            expect(view.notToday.find((r) => r.id === row.id)?.reason).toBe(`over your limits: ${row.reason}`);
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
        expect(best.reason).toBe('SE 28 kn in the area');
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
            expect(row.line2Spoken).toBe(row.line2);
            expect(row.glyph).toBe('?');
            // 127-PYD-1: the row says why, and VoiceOver hears it once.
            expect(row.line2Reason).toBe("Weather didn't load");
            expect(row.ariaLabel).toBe(`${row.line1}. not known: weather didn't load`);
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
        expect(areaVerdict(far, view.window, '4h', hours, DEFAULT_LIMITS)).toBe('SE 30 kn in the area');
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
        expect(view.top[0].line2Reason).toBe('Past the end of the forecast');
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

// ── 10b. The times line worldwide, on the place's 24 h clock (126-17c) ──

describe('a stop’s times at Horta and Tromsø: short to read, whole to hear, on a 24 h clock', () => {
    /** The place's own 24 h clock, worked out apart from hhmm. */
    const clock = (ms: number, zone: string) =>
        new Intl.DateTimeFormat('en-GB', {
            timeZone: zone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(ms);
    const places = [
        {
            // 08:00 AZOST (Azores summer time, UTC+0) on Thursday 8 October 2026, until the clocks go back on the 25th.
            zone: 'Atlantic/Azores',
            start: { lat: 38.533, lon: -28.627, name: 'Marina da Horta' },
            now: Date.UTC(2026, 9, 8, 8),
            stop: [9201, 'Baía Fictícia', 38.47, -28.53] as const,
        },
        {
            // 08:00 CEST on Sunday 21 June 2026, under the midnight sun.
            zone: 'Europe/Oslo',
            start: { lat: 69.65, lon: 18.96, name: 'Tromsø' },
            now: Date.UTC(2026, 5, 21, 6),
            stop: [9301, 'Fiktiv Vik', 69.74, 19.18] as const,
        },
    ];
    const plan = (place: (typeof places)[number], stay: DayPlanInput['stay']) => {
        const { zone, start, now } = place;
        const [node, name, lat, lon] = place.stop;
        return planWithLegs(
            {
                nowMs: now,
                zone,
                start,
                stay,
                atmos: trade(Math.floor(now / H) * H),
                tides: null,
                places: gatherPlaces({
                    start,
                    nowMs: now,
                    radiusNm: 30,
                    atlas: [],
                    osm: [{ points: [osmPoint(node, name, lat, lon)], stale: false }],
                    coastline: null,
                }),
            },
            SE_TRADE,
            { from: Math.floor(now / H) * H },
        );
    };

    for (const place of places) {
        it(`a day trip from ${place.start.name}: "leave → arrive · back home", heard in words`, () => {
            const view = plan(place, '4h');
            expect(view.top.map((row) => row.name)).toEqual([place.stop[1]]);
            const row = view.top[0];
            const best = row.plan!.best!;
            const [leave, arrive, home] = [best.departureMs, best.arriveMs!, best.homeMs!].map((ms) =>
                clock(ms, place.zone),
            );
            expect(row.line2).toBe(`${leave} → ${arrive} · back ${home}`);
            expect(row.line2Spoken).toBe(`Leave ${leave}, arrive ${arrive}, back home ${home}`);
            expect(
                row.ariaLabel.startsWith(`${row.line1}. Leave ${leave}, arrive ${arrive}, back home ${home}. `),
            ).toBe(true);
            expect(row.ariaLabel).not.toMatch(/→/);
            // Four hours ashore from 09:00 at the earliest: home in the afternoon, on the 24 h clock (never "pm").
            expect(leave >= '09:00').toBe(true);
            expect(Number(home.slice(0, 2))).toBeGreaterThanOrEqual(13);
            expect(row.line2).not.toMatch(/[ap]\.?m\b/i);
        });

        it(`an overnight stay from ${place.start.name}: "leave → arrive · about N NM", heard in words`, () => {
            const view = plan(place, 'overnight');
            const row = view.top[0];
            const best = row.plan!.best!;
            const [leave, arrive] = [best.departureMs, best.arriveMs!].map((ms) => clock(ms, place.zone));
            const nm = Math.round(row.candidate.distance.nm);
            expect(row.line2).toBe(`${leave} → ${arrive} · about ${nm} NM`);
            expect(row.line2Spoken).toBe(`Leave ${leave}, arrive ${arrive}, about ${nm} nautical miles`);
            expect(row.ariaLabel).not.toMatch(/→| NM\b/);
        });
    }

    it('a home time not known reads "back --:--", and is said in words', () => {
        const zone = 'Atlantic/Azores';
        const [leave, arrive] = [Date.UTC(2026, 9, 8, 9), Date.UTC(2026, 9, 8, 10, 40)];
        expect(stopTimes(leave, arrive, null, zone, null)).toEqual([
            '09:00 → 10:40 · back --:--',
            'Leave 09:00, arrive 10:40, home time not known',
        ]);
        expect(stopTimes(leave, arrive, Date.UTC(2026, 9, 8, 16, 20), zone, null)).toEqual([
            '09:00 → 10:40 · back 16:20',
            'Leave 09:00, arrive 10:40, back home 16:20',
        ]);
        // An overnight on a saved route keeps the route's own length, to the tenth.
        const saved: DistanceEstimate = {
            basis: 'saved',
            factor: 1,
            straightNm: 11.2,
            nm: 12.34,
            route: { name: 'Horta → Fictícia', points: [], lengthNm: 12.34 },
        };
        expect(stopTimes(leave, arrive, null, 'Europe/Oslo', saved)).toEqual([
            '11:00 → 12:40 · 12.3 NM',
            'Leave 11:00, arrive 12:40, 12.3 nautical miles',
        ]);
    });

    it('an overnight just across the bay is "about 1 nautical mile", never "1 nautical miles"', () => {
        const zone = 'Atlantic/Azores';
        const [leave, arrive] = [Date.UTC(2026, 9, 8, 9), Date.UTC(2026, 9, 8, 9, 20)];
        // 1.1 NM straight, stretched by the clear-water factor: rounds to 1.
        const near: DistanceEstimate = { basis: 'clear', factor: 1.15, straightNm: 1.1, nm: 1.265 };
        expect(stopTimes(leave, arrive, null, zone, near)).toEqual([
            '09:00 → 09:20 · about 1 NM',
            'Leave 09:00, arrive 09:20, about 1 nautical mile',
        ]);
        // Two and up, and a saved route's tenths ("1.0", "0.8"), keep the plural.
        for (const [nm, said] of [
            [1.6, 'about 2 nautical miles'],
            [11.4, 'about 11 nautical miles'],
        ] as const)
            expect(stopTimes(leave, arrive, null, zone, { ...near, nm })[1]).toBe(`Leave 09:00, arrive 09:20, ${said}`);
        const saved = (nm: number): DistanceEstimate => ({
            basis: 'saved',
            factor: 1,
            straightNm: nm,
            nm,
            route: { name: 'Horta → Fictícia', points: [], lengthNm: nm },
        });
        expect(stopTimes(leave, arrive, null, zone, saved(1))[1]).toBe('Leave 09:00, arrive 09:20, 1.0 nautical miles');
        expect(stopTimes(leave, arrive, null, zone, saved(0.8))[1]).toBe(
            'Leave 09:00, arrive 09:20, 0.8 nautical miles',
        );
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
            // Said once (127-PYD-1): never "… weather not checked. weather not checked".
            expect(row.line2Reason).toBeNull();
            expect(row.ariaLabel).toBe(`${row.line1}. ${row.line2}`);
        }
        // Reviewed stops come first, so the order is not simply by distance: the headline never says it is.
        expect(view.headline.text).toBe('No forecast for today: places shown, weather not checked.');
        expect(view.chips.map((c) => [c.best, c.glyph])).toEqual([
            ['none', ''],
            ['none', ''],
            ['none', ''],
        ]);
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

// ── 16. Say why (build 127, 127-PYD-1) ─────────────────────────

/**
 * Shane, 2026-10-10: "plan your day?? … it needs another good clean up claude
 * … once you have made it pop a little more". The engine already knew why a
 * stop is ✕; the sheet only told VoiceOver. Now line 2 of a ✕ or ? row is the
 * reason, the stop page opens on its verdict, thunder is in the headline in
 * place of the clause it causes, the day chips carry her limits' glyph, and
 * every reason is kept once, without its "over your limits: " prefix, which
 * is added where words need it (VoiceOver, Not today, the stop page).
 */
const WIND: RouteWindModels = { ids: ROUTE_MODELS, preferred: 'ecmwf_ifs025', labels: { ecmwf_ifs025: 'ECMWF' } };
const FIXTURE_MODES = ['normal', 'split', 'over', 'offline', 'thunder', 'too-late', 'tromso', 'noumea'] as const;
type FixtureMode = (typeof FIXTURE_MODES)[number];

/** A day as the layout fixture draws it (e2e/fixtures/day-planner.tsx): its sources, boat, limits and legs. */
async function fixtureView(mode: FixtureMode, stay: DayPlanInput['stay'] = '2h'): Promise<DayPlanView> {
    const nowMs =
        mode === 'too-late' ? Date.UTC(2026, 9, 8, 6) : mode === 'tromso' ? Date.UTC(2026, 5, 21, 6) : fixture.NOW;
    const start =
        mode === 'noumea' ? fixture.NOUMEA : mode === 'tromso' ? { lat: 69.6496, lon: 18.956 } : fixture.MARINA;
    const worldwide = mode === 'noumea' || mode === 'tromso';
    const deps = fixture.fakeTodayDeps({
        scenario: mode === 'too-late' || worldwide ? 'normal' : mode,
        nowMs,
        atlas: worldwide ? [] : QLD_TILE.features,
        osm:
            mode === 'noumea'
                ? [
                      fixture.osmAnchorage(910001, 'Fixture Anse', { lat: -22.33, lon: 166.42 }),
                      fixture.osmAnchorage(910002, 'Fixture Baie', { lat: -22.36, lon: 166.55 }),
                      fixture.osmAnchorage(910003, 'Fixture Îlot', { lat: -22.41, lon: 166.38 }),
                  ]
                : mode === 'tromso'
                  ? [
                        fixture.osmAnchorage(920001, 'Fixture Vika', { lat: 69.7, lon: 18.83 }, nowMs - 72 * H),
                        fixture.osmAnchorage(920002, 'Fixture Sund', { lat: 69.6, lon: 19.1 }, nowMs - 72 * H),
                        fixture.osmAnchorage(920003, 'Fixture Hamna', { lat: 69.76, lon: 19.12 }, nowMs - 72 * H),
                    ]
                  : [],
        ...(mode === 'tromso' ? { tides: null } : {}),
    });
    const signal = new AbortController().signal;
    const base = await loadToday({ start, cruiseKts: 6 }, { signal, deps });
    const defaultBoat = mode === 'thunder';
    const vessel = defaultBoat ? DEFAULT_VESSEL : { ...DEFAULT_VESSEL, length: 40, draft: 7.87, cruisingSpeed: 6 };
    const comfort = mode === 'split' ? { maxWindKts: 30, maxGustKts: 40 } : undefined;
    const args = {
        stay,
        limits: resolveDayPlanLimits(comfort, vessel, defaultBoat),
        speed: SAIL,
        usingDefaultVessel: defaultBoat,
    };
    const first = planDay(todayInput(base, args));
    const legs = await loadStopLegs(first.needsLegs, WIND, { signal, deps });
    return planDay(todayInput(base, { ...args, legs }));
}

/** Today's longest headline, the window's (the thunder fixture's before 127): a headline never grows past it. */
const LONGEST_HEADLINE =
    "Afternoon's your window: inside your wind limits until about 16:00. Evening gets near your limits.";

describe('say why (127-PYD-1): a ✕ stop says why on its own row', () => {
    it('an Over stop shows its reason in place of its times: "Home after dark (18:28)"', () => {
        // 18 NM east of the marina and four hours ashore, close-hauled out in a light south-easterly: past last light.
        const limits = resolveDayPlanLimits({ maxWindKts: 30, maxGustKts: 40, maxWaveM: 3 }, null, false);
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osmPoint(9401, 'Fictional Long Reach', -20.265, 148.969)], stale: false }],
            coastline: null,
        });
        const light = atmos(Math.floor(NOW / H) * H, (m) => ({ kts: 9 + (m % 2), dir: 135, gust: 13 }));
        const view = planWithLegs({ limits, places, stay: '4h', atmos: light }, () => ({ kts: 9, dir: 135, gust: 13 }));
        const row = view.top[0];
        const last = hhmm(view.window.lastLightMs!, BRISBANE);
        expect(row.level).toBe('over');
        expect(row.reason).toBe(`home after dark (${last})`);
        expect(row.line2Reason).toBe(`Home after dark (${last})`);
        // The times move to the stop page; the row and VoiceOver say why, once.
        expect(row.line2Reason).not.toMatch(/→/);
        expect(row.ariaLabel).toBe(
            `Fictional Long Reach · Shelter not known. over your limits: home after dark (${last})`,
        );
        expect(view.notToday.find((r) => r.id === row.id)?.reason).toBe(`over your limits: home after dark (${last})`);
    });

    it('a thunder stop: "⚡ Thunder on the way home" on the row; the models are counted where it is said in full', async () => {
        const view = await fixtureView('thunder');
        expect(view.top.length).toBeGreaterThanOrEqual(2);
        for (const row of view.top) {
            expect(row.level).toBe('over');
            expect(row.reason).toBe('thunder in 3 of 7 models on the way home');
            expect(row.line2Reason).toBe('⚡ Thunder on the way home');
            expect(row.ariaLabel).toBe(`${row.line1}. over your limits: thunder in 3 of 7 models on the way home`);
        }
        const detail = stopDetail({
            plan: view.top[0].plan!,
            stay: '2h',
            window: view.window,
            speed: SAIL,
            polarIsOwn: false,
            leavingMarina: true,
        });
        expect(detail.rows[0]).toBe('✕ Over your limits: thunder in 3 of 7 models on the way home');
    });

    it('VoiceOver says each thing once, in every mode the layout fixture draws', async () => {
        for (const mode of FIXTURE_MODES) {
            const view = await fixtureView(mode);
            const labels = [
                ...[...view.top, ...view.fits, ...view.unchecked].map((row) => row.ariaLabel),
                ...view.chips.map((chip) => chip.ariaLabel),
                ...view.parts.map((part) => partCell(part, 7).ariaLabel),
                ...view.notToday.map((row) => row.reason),
                view.facts.ariaLabel,
            ];
            for (const label of labels) {
                expect(label, mode).not.toMatch(/over your limits: over your limits/i);
                expect(label, mode).not.toMatch(/weather not checked\. weather not checked/i);
                for (const words of ['over your limits', 'not checked', 'not known'])
                    expect(label.split(words).length - 1, `${mode}: "${label}"`).toBeLessThanOrEqual(1);
            }
        }
    });

    it('the stop page opens on its verdict, with the reason, for Over and Near; an Inside stop opens on its times', async () => {
        const detail = (view: DayPlanView, at = 0) =>
            stopDetail({
                plan: view.top[at].plan!,
                stay: '2h',
                window: view.window,
                speed: SAIL,
                polarIsOwn: false,
                leavingMarina: false,
            }).rows;
        const over = await fixtureView('over');
        expect(detail(over)[0]).toMatch(/^✕ Over your limits: SE \d+ kn on the way$/);
        const near = await fixtureView('normal');
        expect(near.top[0].level).toBe('near');
        expect(detail(near)[0]).toMatch(/^≈ Near your limits: SE \d+ kn on the way$/);
        expect(detail(near)[1]).toMatch(/^Leave \d\d:\d\d → there /);
        // Worldwide: Nouméa's OpenStreetMap stops, no Queensland data, the same verdict first.
        const noumea = await fixtureView('noumea');
        for (const at of noumea.top.keys()) expect(detail(noumea, at)[0]).toMatch(/^≈ Near your limits: \S/);
        const limits = resolveDayPlanLimits({ maxWindKts: 30, maxGustKts: 40, maxWaveM: 3 }, null, false);
        const calm = atmos(Math.floor(NOW / H) * H, (m) => ({ kts: 7 + (m % 2), dir: 135, gust: 11 }));
        const cid = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: QLD_TILE.features.filter((f) => f.properties.id === 'osm-node3020491514'),
            osm: [],
            coastline: null,
        });
        const inside = planWithLegs({ limits, atmos: calm, places: cid }, () => ({ kts: 8, dir: 135, gust: 12 }));
        expect(inside.top[0].level).toBe('inside');
        expect(detail(inside)[0]).toMatch(/^Leave \d\d:\d\d → there /);
    });

    it('a reviewed stop says its landing tide once: the note names it, the row gives the window', () => {
        const view = planWithLegs({}, SE_TRADE);
        const cid = view.top.find((row) => row.id === 'osm-node3020491514')!;
        const rows = (landing: StopDetailArgs['landing']) =>
            stopDetail({
                plan: cid.plan!,
                stay: '2h',
                window: view.window,
                speed: SAIL,
                polarIsOwn: false,
                leavingMarina: false,
                landing,
            }).rows;
        const window = { fromMs: Date.UTC(2026, 9, 7, 23, 10), toMs: Date.UTC(2026, 9, 8, 3, 40) };
        for (const [landing, line] of [
            ['no-curve', 'Landing window: no tide prediction here.'],
            [window, 'Landing window ≈ 09:10–13:40 (approx.)'],
        ] as const) {
            const said = rows(landing);
            expect(said.join(' ').match(/mid to high tide/g)).toHaveLength(1);
            // The note that says it stays whole ("not a beach landing" is a caution), and the window follows it.
            const note = said.findIndex((r) => /^Queensland Parks describes shore access at mid to high tide/.test(r));
            expect(note).toBeGreaterThan(-1);
            expect(said.indexOf(line)).toBeGreaterThan(note);
        }
    });
});

describe('say why (127-PYD-1): thunder is in the headline, which grows no longer', () => {
    it("the fixture's thunder day: the thunder clause takes the place of the one it causes", async () => {
        const view = await fixtureView('thunder');
        expect(view.headline.text).toBe(
            "Morning's your window: inside your wind limits until about 12:00, then thunder in 3 of 7 models.",
        );
        expect(view.headline.text).not.toMatch(/gets near your limits/);
        expect(view.headline.text.length).toBeLessThanOrEqual(LONGEST_HEADLINE.length);
        // The tiles it falls in carry the bolt as well as the word.
        expect(view.parts.map((part) => partCell(part, 7)).map((cell) => [cell.glyph, cell.word])).toEqual([
            ['✓', 'Inside'],
            ['⚡', 'Thunder'],
            ['⚡', 'Thunder'],
        ]);
    });

    it('thunder that starts after the window has closed for wind follows it, within the same length', () => {
        // The morning Inside; from noon 14-15 kn (near the default boat's 13), thunder in three models from 13:00.
        // "… 12:00. Thunder from about 13:00 in 3 of 7 models." was 108 characters: a fourth line at 390 and
        // 320 px, and the stops clipped under the fade on a notice day (review, 2026-10-10).
        const noon = Date.UTC(2026, 9, 8, 2);
        const at13 = Date.UTC(2026, 9, 8, 3);
        const block = atmos(Math.floor(NOW / H) * H, (m, t) =>
            t < noon
                ? { kts: 8 + (m % 3), dir: 120 }
                : { kts: 14 + (m % 2), dir: 120, code: t >= at13 && m < 3 ? 95 : 3 },
        );
        const view = planDay(input({ atmos: block }));
        expect(view.headline.text).toBe(
            "Morning's your window: inside your wind limits until about 12:00, then thunder in 3 of 7 models.",
        );
        expect(view.headline.text.length).toBeLessThanOrEqual(LONGEST_HEADLINE.length);
    });

    it("the afternoon's window and the evening's thunder: the longest window headline is no longer than before", () => {
        // A blow all morning (over the default boat's limits), the afternoon Inside, thunder in three models from 16:00.
        const noon = Date.UTC(2026, 9, 8, 2);
        const four = Date.UTC(2026, 9, 8, 6);
        const block = atmos(Math.floor(NOW / H) * H, (m, t) =>
            t < noon
                ? { kts: 30 + (m % 2), dir: 120 }
                : t < four
                  ? { kts: 8 + (m % 3), dir: 120 }
                  : { kts: 9, dir: 120, code: m < 3 ? 95 : 3 },
        );
        const view = planDay(input({ atmos: block }));
        expect(view.headline.text).toBe(
            "Afternoon's your window: inside your wind limits until about 16:00, then thunder in 3 of 7 models.",
        );
        expect(view.headline.text.length).toBeLessThanOrEqual(LONGEST_HEADLINE.length);
    });

    it('a Near day with no gust forecast and a wide wind keeps its thunder within the same length', () => {
        // 18-24 kn from the south-west and no model with a gust: "Thunder from about …" would make 99.
        const limits = resolveDayPlanLimits({ maxWindKts: 30, maxGustKts: 40 }, null, false);
        const noon = Date.UTC(2026, 9, 8, 2);
        const block = atmos(Math.floor(NOW / H) * H, (m, t) => ({
            kts: 18 + (Math.round((t - NOW) / H) % 7),
            dir: 225,
            gust: null,
            code: t >= noon && m < 3 ? 95 : 3,
        }));
        const view = planDay(input({ limits, atmos: block }));
        expect(view.headline.text).toMatch(
            /^Near your limits at best: SW \d+–\d+ kn, no gust forecast\. Thunder from 12:00 in 3 of 7 models\.$/,
        );
        expect(view.headline.text.length).toBeLessThanOrEqual(LONGEST_HEADLINE.length);
    });

    it('a day near her limits at best names its thunder once, after the wind', () => {
        const limits = resolveDayPlanLimits({ maxWindKts: 25, maxGustKts: 35 }, null, false);
        const noon = Date.UTC(2026, 9, 8, 2);
        const block = atmos(Math.floor(NOW / H) * H, (m, t) => ({
            kts: 21,
            dir: 135,
            gust: 26,
            code: t >= noon && m < 4 ? 95 : 3,
        }));
        const view = planDay(input({ limits, atmos: block }));
        expect(view.headline.text).toBe(
            'Near your limits at best: SE 21 kn, gusts 26. Thunder from about 12:00 in 4 of 7 models.',
        );
        expect(view.headline.text.match(/[Tt]hunder/g)).toHaveLength(1);
    });
});

describe('say why (127-PYD-1): a stay reason is short on the row, whole where words have room', () => {
    /** A fictional atlas bay about 4 NM off `start`, `fetchNm` of open water on every side. */
    const bay = (id: string, name: string, start: { lat: number; lon: number }, fetchNm: number): AtlasFeature => {
        const table = Array.from({ length: 36 }, () => fetchNm);
        return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [start.lon + 0.07, start.lat - 0.02] },
            properties: {
                id,
                name,
                kind: 'anchorage',
                source: 'OpenStreetMap',
                likelyAnchorage: true,
                noAnchoring: false,
                noAnchoringName: null,
                notes: null,
                fetchLandNM: table,
                fetchReefNM: table,
            },
        };
    };
    // Airlie Beach, and Nouméa (no Queensland data at all): her comfort limits 30/40 kn and 3 m.
    const STARTS = [
        { start: MARINA, zone: BRISBANE },
        { start: { ...fixture.NOUMEA, name: 'Fixture Port' }, zone: 'Pacific/Noumea' },
    ];
    const limits = resolveDayPlanLimits({ maxWindKts: 30, maxGustKts: 40, maxWaveM: 3 }, null, false);
    /** The day at one stop, every leg and the point block `kts` from `dir`; `swellM` long-period swell at the stop. */
    function exposedDay(at: (typeof STARTS)[number], fetchNm: number, kts: number, dir: number, swellM = 0) {
        const places = gatherPlaces({
            start: at.start,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [bay('fixture-open-bay', 'Fictional Open Bay', at.start, fetchNm)],
            osm: [],
            coastline: null,
        });
        const block = atmos(Math.floor(NOW / H) * H, (m) => ({ kts: kts + (m % 2), dir, gust: kts + 4 }));
        const over = { limits, places, atmos: block, start: at.start, zone: at.zone, tides: null };
        const first = planDay(input(over));
        const legs = legsFor(first, () => ({ kts, dir, gust: kts + 4 }));
        if (swellM)
            for (const leg of legs.values())
                for (const s of leg.sea!.stations) {
                    // The swell reaches the stop itself (the fixture's sea is inshore at both ends).
                    s.inshore = false;
                    s.waveM = s.waveM.map(() => swellM);
                    s.wavePeriodS = s.wavePeriodS.map(() => 12);
                    s.waveFromDeg = s.waveFromDeg.map(() => dir);
                }
        return planDay(input({ ...over, legs }));
    }
    const detail = (view: DayPlanView) =>
        stopDetail({
            plan: view.top[0].plan!,
            stay: '2h',
            window: view.window,
            speed: SAIL,
            polarIsOwn: false,
            leavingMarina: false,
        }).rows;
    /** A compass point broken by lowercasing ("sE 18 kn", ": e 15 kn"). */
    const BROKEN_COMPASS = /\b[a-z][A-Z]{1,2}\b|: [nesw]{1,3} \d/;

    it('exposed to the wind: "Chop for the stay (SE 22 kn)" on the row, the whole sentence in VoiceOver and on the stop page', () => {
        for (const at of STARTS)
            for (const [fetchNm, sentence] of [
                [15, /^Open to the ([NESW]{1,3}) — \1 22 kn has 15\+ NM of fetch$/],
                [9.5, /^([NESW]{1,3}) 22 kn works across 9\.5 NM — expect chop$/],
            ] as const)
                for (const dir of [0, 45, 90, 135, 180, 225, 270, 315]) {
                    const view = exposedDay(at, fetchNm, 23, dir);
                    const row = view.top[0];
                    const say = `${at.zone} ${fetchNm} NM ${dir}°`;
                    expect(row.level, say).toBe('over');
                    const whole = row.plan!.best!.stay!.reasons[0];
                    expect(whole, say).toMatch(sentence);
                    const point = whole.match(sentence)![1];
                    // The row keeps its two lines: at most 30 characters ("About 22 NM · weather not checked" is 33).
                    expect(row.line2Reason, say).toBe(`Chop for the stay (${point} 22 kn)`);
                    expect(row.line2Reason!.length, say).toBeLessThanOrEqual(30);
                    // In full, with its compass point whole, where words have room.
                    const lower = whole.startsWith('Open') ? `o${whole.slice(1)}` : whole;
                    expect(row.reason, say).toBe(lower);
                    expect(row.ariaLabel, say).toBe(`${row.line1}. over your limits: ${lower}`);
                    expect(view.notToday.find((r) => r.id === row.id)?.reason, say).toBe(`over your limits: ${lower}`);
                    const rows = detail(view);
                    expect(rows[0], say).toBe(`✕ Over your limits: ${lower}`);
                    // Said once: the stay row names the shelter, the verdict above it says why.
                    expect(
                        rows.find((r) => r.startsWith('Ashore')),
                        say,
                    ).toMatch(/^Ashore \d\d:\d\d–\d\d:\d\d · Exposed$/);
                    expect(
                        rows.filter((r) => r.includes(whole.slice(1))),
                        say,
                    ).toHaveLength(1);
                    for (const text of [row.ariaLabel, rows[0], ...view.notToday.map((r) => r.reason)])
                        expect(text, say).not.toMatch(BROKEN_COMPASS);
                }
    });

    it('a rolly stay: "Swell for the stay (1.8 m SE)" on the row', () => {
        for (const at of STARTS) {
            const view = exposedDay(at, 15, 12, 135, 1.8);
            const row = view.top[0];
            expect(row.level, at.zone).toBe('over');
            expect(row.plan!.best!.stay!.reasons[0]).toBe('1.8 m SE swell finds a way in — expect roll');
            expect(row.reason).toBe('1.8 m SE swell finds a way in — expect roll');
            expect(row.line2Reason).toBe('Swell for the stay (1.8 m SE)');
            expect(detail(view)[0]).toBe('✕ Over your limits: 1.8 m SE swell finds a way in — expect roll');
        }
    });

    it('some chop for the stay holds a stop at Near, and its verdict keeps the compass point: "SE 18 kn", never "sE 18 kn"', () => {
        for (const at of STARTS)
            for (const dir of [45, 135, 225, 315]) {
                const view = exposedDay(at, 9.5, 19, dir);
                const row = view.top[0];
                expect(row.level, `${at.zone} ${dir}°`).toBe('near');
                // A Near row keeps its times.
                expect(row.line2Reason).toBeNull();
                const rows = detail(view);
                expect(rows[0]).toMatch(/^≈ Near your limits: [NESW]{1,2} 18 kn works across 9\.5 NM — expect chop$/);
                expect(rows.find((r) => r.startsWith('Ashore'))).toMatch(/ · Some chop$/);
                expect(rows[0]).not.toMatch(BROKEN_COMPASS);
            }
    });

    it('home after dark is said once on the stop page: the verdict, not a second light row', () => {
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osmPoint(9401, 'Fictional Long Reach', -20.265, 148.969)], stale: false }],
            coastline: null,
        });
        const light = atmos(Math.floor(NOW / H) * H, (m) => ({ kts: 9 + (m % 2), dir: 135, gust: 13 }));
        const view = planWithLegs({ limits, places, stay: '4h', atmos: light }, () => ({ kts: 9, dir: 135, gust: 13 }));
        const last = hhmm(view.window.lastLightMs!, BRISBANE);
        const rows = stopDetail({
            plan: view.top[0].plan!,
            stay: '4h',
            window: view.window,
            speed: SAIL,
            polarIsOwn: false,
            leavingMarina: false,
        }).rows;
        expect(rows[0]).toBe(`✕ Over your limits: home after dark (${last})`);
        expect(rows.filter((r) => /after dark/i.test(r))).toHaveLength(1);
    });

    it('in every mode the layout fixture draws, no stop page says its verdict twice, nor breaks a compass point', async () => {
        for (const mode of FIXTURE_MODES) {
            const view = await fixtureView(mode);
            for (const row of view.top) {
                const d = row.plan?.best;
                if (!row.plan?.weatherLoaded || !d) continue;
                const rows = stopDetail({
                    plan: row.plan,
                    stay: '2h',
                    window: view.window,
                    speed: SAIL,
                    polarIsOwn: false,
                    leavingMarina: false,
                }).rows;
                if (d.reason) {
                    const words = d.reason.slice(1);
                    expect(
                        rows.filter((r) => r.includes(words)),
                        `${mode}: ${rows.join(' | ')}`,
                    ).toHaveLength(1);
                }
                for (const text of [rows[0], row.ariaLabel]) expect(text, mode).not.toMatch(BROKEN_COMPASS);
            }
            for (const r of view.notToday) expect(r.reason, mode).not.toMatch(BROKEN_COMPASS);
        }
    });
});
