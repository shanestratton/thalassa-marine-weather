/**
 * Plan Your Day, build 127 (127-PYD-4): different places, picked for a reason.
 *
 * Shane, 2026-10-10: "plan your day?? why does it only ever show the same 3
 * destinations. ??? it needs another good clean up claude." The investigation
 * (10 winds x 3 days x 4 stays at Coral Sea Marina, on the real Whitsundays
 * atlas) found Cid Harbour in 109 of 120 cards and the exact same three in 66:
 * shelter reads "very sheltered" in almost any wind under 18 kn, so the
 * reviewed-first tie-break chose the nearest three reviewed stops every time.
 *
 * Now every place in reach is planned on the area wind (zero requests), ranked
 * on its level, its stay and a four-term composite, and the card shows the
 * best fit, the best the other way and one somewhere different, each tagged
 * with a fact that is true for it. Five are route-checked so a ✕ can be
 * replaced by a checked backup that fits.
 *
 * Real atlas tiles (public/anchorages/qld, OpenStreetMap ODbL, shipped);
 * synthetic point blocks and route legs (no live weather); fictional voyage
 * ends; fictional places outside the atlas (Nouméa, Tromsø).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRUISING_POLAR } from '../services/defaultPolar';
import { cardTags, comfortScore, scorePlaces, type PickPlace } from '../services/dayPlanner/pick';
import { gatherPlaces, type AtlasFeature, type GatheredPlaces, type LatLon } from '../services/dayPlanner/places';
import * as today from '../services/dayPlanner/today';
import {
    pickHeadlineMember,
    planDay,
    resolveDayPlanLimits,
    type DayPlanInput,
    type DayPlanView,
    type StayOption,
    type StopLegs,
    type StopRow,
} from '../services/dayPlanner/today';
import { departureScore, departureScoreTerms, type ScoredDeparture } from '../services/passageDepartureSuggestion';
import type { PassageSpeedModel } from '../services/passagePlan';
import type { RouteForecast } from '../services/routeForecastSampler';
import type { RouteSea } from '../services/routeSeaSampler';
import type { RouteSpread } from '../services/routeForecastSpread';
import { pointAlongRoute, routeLengthNm } from '../services/routeProgress';
import { DEFAULT_VESSEL } from '../utils/defaultVessel';
import { calculateBearing, calculateDistance } from '../utils/navigationCalculations';
import { osmAnchorage, pointBlock } from './helpers/dayPlanFixtures';

const H = 3_600_000;
/** 06:30 on Saturday 10 October 2026 at Airlie Beach (AEST = UTC+10). */
const NOW = Date.UTC(2026, 9, 9, 20, 30);
const ZONE = 'Australia/Brisbane';
const START = { lat: -20.265, lon: 148.719, name: 'Coral Sea Marina' };
const ROUTE_MODELS = ['ecmwf_ifs025', 'dwd_icon', 'ecmwf_aifs025_single', 'ukmo_global_deterministic_10km', 'jma_gsm'];
const SAIL: PassageSpeedModel = {
    mode: 'polar',
    cruiseKts: 6,
    isSail: true,
    polar: DEFAULT_CRUISING_POLAR,
    closeHauledDeg: 40,
};
const LIMITS = resolveDayPlanLimits(undefined, DEFAULT_VESSEL, true);
const DATES = ['2026-10-10', '2026-10-11', '2026-10-12'];
const STAYS: StayOption[] = ['1h', '2h', '4h', 'overnight'];

/** The six reviewed Whitsundays stops (destinations.ts), by anchorage id. */
const REVIEWED = new Set([
    'osm-node2982151597',
    'osm-node13823198736',
    'osm-node8925547809',
    'osm-node3020491514',
    'osm-node2838871153',
    'osm-node2838870585',
]);
const CID = 'osm-node3020491514';

type Wind = (t: number) => { kts: number; dir: number };
const steady =
    (kts: number, dir: number): Wind =>
    () => ({ kts, dir });

function block(from: number, wind: Wind) {
    return pointBlock(from, (m, t) => {
        const w = wind(t);
        return { kts: Math.max(0, w.kts + (m % 5) - 2), dir: (w.dir + (m - 3) * 3 + 360) % 360 };
    });
}

function routeForecast(model: string, coords: LatLon[], wind: Wind, from: number, off: number): RouteForecast {
    const total = routeLengthNm(coords);
    const n = Math.max(2, Math.ceil(total / 4) + 1);
    const times = Array.from({ length: 96 }, (_, h) => from + h * H);
    return {
        model,
        fetchedAt: from,
        totalNm: total,
        stations: Array.from({ length: n }, (_, i) => {
            const alongNm = (total * i) / (n - 1);
            const at = pointAlongRoute(coords, alongNm)!;
            const w = times.map((t) => wind(t));
            return {
                alongNm,
                lat: at.lat,
                lon: at.lon,
                timesMs: [...times],
                speedKts: w.map((x) => Math.max(0, x.kts + off)),
                dirDeg: w.map((x) => x.dir),
                gustKts: w.map((x) => x.kts + off + 5),
                precipMm: times.map(() => 0),
                precipProb: times.map(() => 0),
            };
        }),
    };
}

function routeSea(coords: LatLon[], wind: Wind, from: number): RouteSea {
    const total = routeLengthNm(coords);
    const n = Math.max(4, Math.ceil(total / 4) + 1);
    const times = Array.from({ length: 96 }, (_, h) => from + h * H);
    return {
        fetchedAt: from,
        totalNm: total,
        stations: Array.from({ length: n }, (_, i) => {
            const alongNm = (total * i) / (n - 1);
            const at = pointAlongRoute(coords, alongNm)!;
            const inshore = i === 0 || i === n - 1;
            return {
                alongNm,
                lat: at.lat,
                lon: at.lon,
                snapKm: inshore ? 9 : 3,
                inshore,
                timesMs: [...times],
                waveM: times.map((t) => (inshore ? null : Math.min(1.2, 0.2 + wind(t).kts * 0.03))),
                wavePeriodS: times.map(() => 5),
                waveFromDeg: times.map((t) => wind(t).dir),
                currentKts: times.map(() => 0.2),
                currentSetDeg: times.map(() => 300),
            };
        }),
    };
}

function legsOf(coords: LatLon[], wind: Wind, from: number): StopLegs {
    const members: Record<string, RouteForecast> = {};
    ROUTE_MODELS.forEach((m, i) => (members[m] = routeForecast(m, coords, wind, from, (i - 2) * 0.5)));
    const spread: RouteSpread = { asked: [...ROUTE_MODELS], members, missing: [], fetchedAt: from };
    const pickd = pickHeadlineMember(spread, 'ecmwf_ifs025', ROUTE_MODELS)!;
    return {
        headline: pickd.forecast,
        headlineModel: 'ECMWF',
        substituted: false,
        spread,
        sea: routeSea(coords, wind, from),
    };
}

// ── The real atlas ─────────────────────────────────────────────

function atlasFeatures(ids: string[]): AtlasFeature[] {
    const seen = new Set<string>();
    const out: AtlasFeature[] = [];
    for (const id of ids) {
        const tile = JSON.parse(readFileSync(`public/anchorages/qld/${id}.geojson`, 'utf8')) as {
            features: AtlasFeature[];
        };
        for (const f of tile.features) {
            if (seen.has(f.properties.id)) continue;
            seen.add(f.properties.id);
            out.push(f);
        }
    }
    return out;
}

const ATLAS = atlasFeatures(['t-22e148', 't-20e148']);
/** Passages, channels, sounds and flats: the atlas itself marks them as no place to stop. */
const NAV_IDS = new Set(ATLAS.filter((f) => f.properties.likelyAnchorage === false).map((f) => f.properties.id));
const PLACES: GatheredPlaces = gatherPlaces({
    start: START,
    nowMs: NOW,
    radiusNm: 30,
    atlas: ATLAS,
    osm: [],
    coastline: null,
});

/** Two fictional voyage ends of hers: one in Cid Harbour, one off the Whitsunday Island ramp. */
const VISITED: LatLon[] = [
    { lat: -20.2452, lon: 148.9484 },
    { lat: -20.1373, lon: 148.9121 },
];

function base(wind: Wind, over: Partial<DayPlanInput> = {}): DayPlanInput {
    return {
        nowMs: NOW,
        zone: ZONE,
        start: START,
        stay: '2h',
        limits: LIMITS,
        speed: SAIL,
        usingDefaultVessel: true,
        atmos: block(Math.floor(NOW / H) * H, wind),
        weather: 'ok',
        places: PLACES,
        placesStatus: 'ok',
        tides: null,
        visited: VISITED,
        ...over,
    };
}

/** Plan, route-check what it names, plan again: as the sheet does. */
function plan(input: DayPlanInput, wind: Wind, legs: (id: string, coords: LatLon[]) => StopLegs | null = () => null) {
    const from = Math.floor(input.nowMs / H) * H;
    const first = planDay(input);
    const map = new Map<string, StopLegs>();
    for (const n of first.needsLegs)
        map.set(n.id, legs(n.id, n.coords as LatLon[]) ?? legsOf(n.coords as LatLon[], wind, from));
    return { first, view: planDay({ ...input, legs: map }) };
}

const WINDS: Record<string, Wind> = {
    'SE 15': steady(15, 135),
    'SE 20': steady(20, 135),
    'E 12': steady(12, 90),
    'NE 10': steady(10, 45),
    'N 14': steady(14, 0),
    'NW 10': steady(10, 315),
    'W 8': steady(8, 270),
    'SW 15': steady(15, 225),
    'S 18': steady(18, 180),
    'calm 5': steady(5, 100),
};

/** This weekend's shape (ECMWF, ICON, AIFS, UKMO and JMA agreed): NE early, E by the afternoon, 4 to 10 kn. */
const LIGHT_NE_E: Wind = (t) => {
    const h = (new Date(t).getUTCHours() + 10) % 24;
    const day = h >= 6 && h <= 18 ? Math.sin((Math.PI * (h - 6)) / 12) : 0;
    return { kts: 4 + 6 * day, dir: 50 + 40 * Math.min(1, Math.max(0, (h - 6) / 10)) };
};

const short = (row: Pick<StopRow, 'name'>) => row.name.split(' · ')[0];
const bearing = (p: LatLon, from: LatLon = START) => calculateBearing(from.lat, from.lon, p.lat, p.lon);
const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const nm = (a: LatLon, b: LatLon) => calculateDistance(a.lat, a.lon, b.lat, b.lon);

/** A card row's tag, checked against the fact it claims, relative to the best fit. */
function tagIssues(view: DayPlanView, visited: readonly LatLon[] | null, start: LatLon = START): string[] {
    const issues: string[] = [];
    const [best, ...rest] = view.top;
    if (!best) return issues;
    const tag = (row: StopRow) => row.tag;
    if (tag(best)) issues.push(`the best fit ${short(best)} has a tag (${tag(best)})`);
    const stayScore = (row: StopRow) => (row.plan?.best?.stay ?? null)?.score ?? null;
    for (const row of rest) {
        const t = tag(row);
        const c = row.candidate;
        const who = `${short(row)} (${t})`;
        if (!t) {
            issues.push(`${short(row)} has no tag`);
            continue;
        }
        if (t === 'Closer' && !(c.distance.nm <= 0.6 * best.candidate.distance.nm + 1e-9))
            issues.push(`${who}: ${c.distance.nm} NM is not 60% of ${best.candidate.distance.nm}`);
        const turn = apart(bearing(c, start), bearing(best.candidate, start));
        if (t === 'Other way' && !(turn >= 45)) issues.push(`${who}: only ${turn}° from the best fit`);
        if (t === 'New to you' && (!visited || visited.some((v) => nm(v, c) <= 0.5)))
            issues.push(`${who}: a voyage of hers ended there`);
        if (t === 'More shelter') {
            const a = stayScore(row);
            const b = stayScore(best);
            if (a === null || b === null || !(a > b)) issues.push(`${who}: stay ${a} is not better than ${b}`);
        }
        if (t === 'Short hop') {
            const d = row.plan?.best;
            const out = d?.out.durationMs ?? Infinity;
            const home = d?.home ? (d.home.durationMs ?? Infinity) : 0;
            if (!(out <= H && home <= H)) issues.push(`${who}: ${out / 60_000} min out, ${home / 60_000} home`);
        }
        if (!['Closer', 'Other way', 'New to you', 'More shelter', 'Short hop'].includes(t))
            issues.push(`${who}: not a tag`);
    }
    return issues;
}

/** Two stops on the card closer than 3 NM: the "three different stops" broken (review 2026-10-10). */
function spacingIssues(view: DayPlanView): string[] {
    const issues: string[] = [];
    view.top.forEach((a, i) =>
        view.top.slice(i + 1).forEach((b) => {
            const d = nm(a.candidate, b.candidate);
            if (d < 3) issues.push(`${short(a)} and ${short(b)} are ${d.toFixed(2)} NM apart`);
        }),
    );
    return issues;
}

// ── 1. The matrix: 10 winds x 3 days x 4 stays ─────────────────

describe('the card is no longer the same three (10 winds x 3 days x 4 stays at Coral Sea Marina)', () => {
    const runs: { wind: string; date: string; stay: StayOption; view: DayPlanView }[] = [];
    let top: string[][] = [];
    let freq: Record<string, number> = {};
    const count = (ids: string[][]) =>
        ids.flat().reduce<Record<string, number>>((a, id) => ((a[id] = (a[id] ?? 0) + 1), a), {});
    beforeAll(() => {
        for (const [name, wind] of Object.entries(WINDS))
            for (const date of DATES)
                for (const stay of STAYS)
                    runs.push({ wind: name, date, stay, view: plan(base(wind, { date, stay }), wind).view });
        top = runs.map((r) => r.view.top.map((row) => row.id));
        freq = count(top);
    }, 300_000);

    it('Cid Harbour is in the top three in at most 60% of runs (was 91%)', () => {
        expect(runs).toHaveLength(120);
        expect(freq[CID] ?? 0).toBeLessThanOrEqual(72);
    });

    it('no place is on the card in more than 60% of runs, and no place is the best fit in more than 40%', () => {
        for (const [id, n] of Object.entries(freq)) expect(n, id).toBeLessThanOrEqual(72);
        const firsts = count(top.map((ids) => ids.slice(0, 1)));
        for (const [id, n] of Object.entries(firsts)) expect(n, `${id} best fit`).toBeLessThanOrEqual(48);
    });

    it('the exact same three in at most 15% of runs (was 55%), and at least 15 places across them', () => {
        const sets = count(top.map((ids) => [[...ids].sort().join('+')]));
        expect(Math.max(...Object.values(sets))).toBeLessThanOrEqual(18);
        expect(Object.keys(freq).length).toBeGreaterThanOrEqual(15);
    });

    it('reviewed stops fill 30-70% of the card (was 91.4%): a bonus, not a trump', () => {
        const slots = top.flat();
        const share = slots.filter((id) => REVIEWED.has(id)).length / slots.length;
        expect(share).toBeGreaterThanOrEqual(0.3);
        expect(share).toBeLessThanOrEqual(0.7);
    });

    it('the best fit is the nearest Inside place at or past 3 NM in at most half the runs (no hop to the nearest bay)', () => {
        let nearest = 0;
        for (const { view } of runs) {
            const inside = view.ranked.filter(
                (p) => view.scores.get(p.candidate.id)?.level === 'inside' && p.candidate.straightNm >= 3,
            );
            if (!inside.length || !view.top[0]) continue;
            const closest = inside.reduce((a, b) => (b.candidate.straightNm < a.candidate.straightNm ? b : a));
            if (view.top[0].id === closest.candidate.id) nearest++;
        }
        expect(nearest).toBeLessThanOrEqual(60);
    });

    it('no card stop under 3 NM, and no passage, channel, sound or flats ever, anywhere', () => {
        for (const { view } of runs) {
            for (const row of view.top) expect(row.candidate.straightNm, short(row)).toBeGreaterThanOrEqual(3);
            for (const row of [...view.top, ...view.fits, ...view.unchecked, ...view.notToday])
                expect(NAV_IDS.has(row.id), row.name).toBe(false);
        }
    });

    it('the classic 15-22 NM stops are ranked, not "not ranked — 40 closer places checked first"', () => {
        const ranked = new Set(runs[0].view.ranked.map((p) => p.candidate.name));
        for (const name of ['Butterfly Bay', 'Blue Pearl Bay', 'Nelly Bay', 'Cateran Bay'])
            expect(ranked).toContain(name);
        for (const { view } of runs) for (const row of view.notToday) expect(row.reason).not.toMatch(/closer places/);
    });

    it('every card stop but the best fit has a tag, and every tag is true', () => {
        for (const { wind, date, stay, view } of runs)
            expect(tagIssues(view, VISITED), `${wind} ${date} ${stay}`).toEqual([]);
    });

    it('the three are three different stops: at least 3 NM apart, after any backfill (SW 15 Sun/Mon 4 h swapped one in a mile and a half off)', () => {
        for (const { wind, date, stay, view } of runs)
            expect(spacingIssues(view), `${wind} ${date} ${stay}`).toEqual([]);
    });

    it('route-checks five: the three on the card and the next two the pick rules would choose', () => {
        for (const { view } of runs) {
            expect(today.ROUTE_CHECK_STOPS).toBe(5);
            const ids = view.needsLegs.map((n) => n.id);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids.length).toBe(Math.min(5, view.ranked.filter((p) => p.candidate.straightNm >= 3).length));
            for (const row of view.top) expect(ids).toContain(row.id);
        }
    });
});

describe("this weekend's light NE-E (4-10 kn)", () => {
    it('across Sat, Sun and Mon x 2 h, 4 h and overnight: at least five different stops, never the same three on all nine', () => {
        const sets: string[] = [];
        const seen = new Set<string>();
        for (const date of DATES)
            for (const stay of ['2h', '4h', 'overnight'] as StayOption[]) {
                const { view } = plan(base(LIGHT_NE_E, { date, stay }), LIGHT_NE_E);
                expect(view.top.length, `${date} ${stay}`).toBeGreaterThanOrEqual(2);
                for (const row of view.top) seen.add(row.id);
                sets.push(
                    view.top
                        .map((r) => r.id)
                        .sort()
                        .join('+'),
                );
                expect(tagIssues(view, VISITED), `${date} ${stay}`).toEqual([]);
            }
        expect(seen.size).toBeGreaterThanOrEqual(5);
        expect(new Set(sets).size).toBeGreaterThan(1);
    });
});

// ── 2. Same inputs, same card ──────────────────────────────────

describe('determinism', () => {
    it('the same input twice gives the same picks, tags and checks', () => {
        const a = plan(base(WINDS['E 12']), WINDS['E 12']).view;
        const b = plan(base(WINDS['E 12']), WINDS['E 12']).view;
        expect(b.top.map((r) => [r.id, r.tag])).toEqual(a.top.map((r) => [r.id, r.tag]));
        expect(b.needsLegs.map((n) => n.id)).toEqual(a.needsLegs.map((n) => n.id));
    });

    it('a veering breeze, opened at 06:01, 06:16 or 06:29 today: the same picks (the first departure is 07:00 for all three)', () => {
        // Review 2026-10-10: the rank's stay window ran from the unrounded earliest leave, so in a
        // breeze that veers 12° an hour a quarter hour moved it and swapped a stop on the card.
        // NNE at 06:30 with a 4 h stay, and NE with a 1 h stay, both swapped one stop between 06:01 and 06:16.
        for (const [from, stay] of [
            [30, '4h'],
            [60, '1h'],
            [90, '2h'],
        ] as [number, StayOption][]) {
            const veer: Wind = (t) => ({ kts: 12, dir: (from + (12 * (t - NOW)) / H + 720) % 360 });
            const at = (ms: number) =>
                plan(
                    base(veer, { nowMs: ms, date: null, stay, atmos: block(Math.floor(ms / H) * H, veer) }),
                    veer,
                ).view.top.map((r) => r.id);
            const first = at(Date.UTC(2026, 9, 9, 20, 1));
            expect(at(Date.UTC(2026, 9, 9, 20, 16)), `${from}° ${stay}`).toEqual(first);
            expect(at(Date.UTC(2026, 9, 9, 20, 29)), `${from}° ${stay}`).toEqual(first);
        }
    });

    it('opened at 06:01 or at 06:29 the same morning: the same picks (no shuffling by the minute)', () => {
        for (const date of DATES) {
            const at = (ms: number) =>
                plan(
                    base(WINDS['NE 10'], { nowMs: ms, date, atmos: block(Math.floor(ms / H) * H, WINDS['NE 10']) }),
                    WINDS['NE 10'],
                ).view.top.map((r) => r.id);
            expect(at(Date.UTC(2026, 9, 9, 20, 29)), date).toEqual(at(Date.UTC(2026, 9, 9, 20, 1)));
        }
    });
});

// ── 3. Route-check five, show three ────────────────────────────

describe('backfill: a ✕ on the card is replaced by a checked backup that fits', () => {
    for (const name of ['E 12', 'NE 10', 'NW 10', 'SW 15']) {
        it(`${name}: the second pick's route is over her limits, a backup fits, so no ✕ on the card`, () => {
            const wind = WINDS[name];
            const input = base(wind);
            const first = planDay(input);
            expect(first.needsLegs).toHaveLength(5);
            const bad = first.top[1].id;
            const from = Math.floor(NOW / H) * H;
            const blow = (id: string, coords: LatLon[]) => (id === bad ? legsOf(coords, steady(30, 135), from) : null);
            const { view } = plan(input, wind, blow);
            expect(view.top.map((r) => r.glyph)).not.toContain('✕');
            expect(view.top.map((r) => r.id)).not.toContain(bad);
            const backups = first.needsLegs.map((n) => n.id).filter((id) => !first.top.some((r) => r.id === id));
            expect(backups).toContain(view.top[1].id);
            // Its slot keeps a true tag, worked out again for the stop that took it, and the three stay apart.
            expect(tagIssues(view, VISITED)).toEqual([]);
            expect(spacingIssues(view)).toEqual([]);
            // The ✕ is still listed, with its reason.
            expect(view.notToday.find((r) => r.id === bad)?.reason).toMatch(/^over your limits: /);
        });
    }

    it('any one pick blown in turn (E 12, NE 10, NW 10, SW 15 x Sat, Sun x 2 h, 4 h): no ✕ when a backup fits, and never two stops under 3 NM apart', () => {
        const from = Math.floor(NOW / H) * H;
        for (const name of ['E 12', 'NE 10', 'NW 10', 'SW 15'])
            for (const date of DATES.slice(0, 2))
                for (const stay of ['2h', '4h'] as StayOption[]) {
                    const wind = WINDS[name];
                    const input = base(wind, { date, stay });
                    const first = planDay(input);
                    for (const row of first.top) {
                        const blow = (id: string, coords: LatLon[]) =>
                            id === row.id ? legsOf(coords, steady(30, 135), from) : null;
                        const { view } = plan(input, wind, blow);
                        const who = `${name} ${date} ${stay}, ${short(row)} blown`;
                        expect(spacingIssues(view), who).toEqual([]);
                        expect(tagIssues(view, VISITED), who).toEqual([]);
                        const fits = [...view.rows.values()].some(
                            (r) => !view.top.includes(r) && (r.level === 'inside' || r.level === 'near'),
                        );
                        if (fits)
                            expect(
                                view.top.map((r) => r.glyph),
                                who,
                            ).not.toContain('✕');
                    }
                }
    }, 120_000);

    it('a stop whose page is open is pinned to its slot: never swapped out from under her', () => {
        const wind = WINDS['E 12'];
        const first = planDay(base(wind));
        const bad = first.top[1].id;
        const from = Math.floor(NOW / H) * H;
        const blow = (id: string, coords: LatLon[]) => (id === bad ? legsOf(coords, steady(30, 135), from) : null);
        const { view } = plan(base(wind, { pinned: bad }), wind, blow);
        expect(view.top[1].id).toBe(bad);
        expect(view.top[1].glyph).toBe('✕');
        // Found by id, whatever the card shows.
        expect(view.rows.get(bad)?.level).toBe('over');
        // Closed again, the backfill applies.
        const closed = plan(base(wind), wind, blow).view;
        expect(closed.top.map((r) => r.id)).not.toContain(bad);
    });

    it('on a rough day the least-bad three still show, with their reasons', () => {
        const blow = steady(30, 135);
        const { view } = plan(base(blow), blow);
        expect(view.state).toBe('stay-put');
        expect(view.top).toHaveLength(3);
        for (const row of view.top) {
            expect(row.level).toBe('over');
            expect(row.line2Reason).toMatch(/kn on the way$/);
        }
    });
});

describe('cardTags: one true tag a row, and not the same one twice when another is true', () => {
    const place = (id: string, lat: number, lon: number, visited: boolean): PickPlace => ({
        id,
        lat,
        lon,
        estNm: calculateDistance(START.lat, START.lon, lat, lon),
        bearingDeg: calculateBearing(START.lat, START.lon, lat, lon),
        stayScore: 80,
        hopMs: 2 * H,
        visited,
    });
    it('the second shows "New to you" (it is not the other way); the third, new AND the other way, says "Other way"', () => {
        const best = place('a', -20.1, 148.95, true);
        const second = place('b', -20.05, 148.98, false);
        const third = place('c', -20.4, 148.95, false);
        expect(cardTags([best, second, third])).toEqual([null, 'new', 'other']);
    });
});

// ── 4. The composite (critic 2026-10-10) ───────────────────────

describe('the rank: level, stay grade, then four named terms and no time term', () => {
    const at = (over: Partial<ScoredDeparture> = {}): ScoredDeparture => ({
        departureMs: NOW,
        maxWindKts: 10,
        maxHeadwindKts: 4,
        maxGustKts: 15,
        maxWaveM: 0.5,
        gustComplete: true,
        waveComplete: true,
        ...over,
    });

    it('comfort is departureScore mapped to 0-100 against her limits: 0 at her limits, 100 in a flat calm', () => {
        const terms = { gusts: true, waves: true };
        const atLimits = at({
            maxWindKts: LIMITS.wind.poor,
            maxHeadwindKts: LIMITS.wind.poor,
            maxGustKts: LIMITS.gust.poor,
            maxWaveM: LIMITS.wave.poor,
        });
        expect(comfortScore(atLimits, terms, LIMITS)).toBe(0);
        expect(comfortScore(at({ maxWindKts: 0, maxHeadwindKts: 0, maxGustKts: 0, maxWaveM: 0 }), terms, LIMITS)).toBe(
            100,
        );
        const d = at();
        const expected = 100 * (1 - departureScore(d, terms) / departureScore(atLimits, terms));
        expect(comfortScore(d, terms, LIMITS)).toBeCloseTo(expected, 9);
        // Past her limits it stops at 0, never below.
        expect(comfortScore(at({ maxWindKts: 40, maxHeadwindKts: 40 }), terms, LIMITS)).toBe(0);
    });

    it('the gust and wave terms switch off for every place when any ranked place lacks them', () => {
        const items = [
            { level: 'inside' as const, stayScore: 90, best: at(), estNm: 8, reviewed: false },
            { level: 'inside' as const, stayScore: 90, best: at({ gustComplete: false }), estNm: 8, reviewed: false },
        ];
        const scores = scorePlaces(items, LIMITS);
        const terms = departureScoreTerms(items.map((i) => i.best));
        expect(terms).toEqual({ gusts: false, waves: true });
        const limit = departureScore(
            at({
                maxWindKts: LIMITS.wind.poor,
                maxHeadwindKts: LIMITS.wind.poor,
                maxGustKts: LIMITS.gust.poor,
                maxWaveM: LIMITS.wave.poor,
            }),
            terms,
        );
        expect(scores[0].comfort).toBeCloseTo(100 * (1 - departureScore(items[0].best, terms) / limit), 9);
        expect(scores[0].comfort).toBe(scores[1].comfort);
    });

    it('the day-out credit is the only distance term, reported on its own; reviewed is a bonus of 10', () => {
        const one = (estNm: number, reviewed = false) =>
            scorePlaces([{ level: 'inside', stayScore: 80, best: at(), estNm, reviewed }], LIMITS)[0];
        const near = one(5);
        const far = one(10);
        expect(far.stay).toBe(near.stay);
        expect(far.comfort).toBe(near.comfort);
        expect(far.dayOut).toBeGreaterThan(near.dayOut);
        expect(far.total - near.total).toBeCloseTo(far.dayOut - near.dayOut, 9);
        // Capped at 12 NM; a hop under 4 NM pays for it.
        expect(one(20).dayOut).toBe(one(12).dayOut);
        expect(one(3.5).dayOut).toBeLessThan(0);
        expect(one(10, true).reviewed).toBe(10);
        expect(one(10, true).total - far.total).toBeCloseTo(10, 9);
        for (const s of [near, far]) expect(s.total).toBeCloseTo(s.stay + s.comfort + s.dayOut + s.reviewed, 9);
    });

    it('in a constant wind, two places alike but for their passage hours get the same comfort', () => {
        // Two fictional coves due north of a fictional start, 6 and 12 NM: the same course, the same wind.
        const start = { lat: -20.5, lon: 149.5, name: 'Fixture Start' };
        const places = gatherPlaces({
            start,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [
                {
                    points: [
                        osmAnchorage(930001, 'Fixture Near Cove', { lat: -20.4, lon: 149.5 }),
                        osmAnchorage(930002, 'Fixture Far Cove', { lat: -20.3, lon: 149.5 }),
                    ],
                    stale: false,
                },
            ],
            coastline: null,
        });
        const wind = steady(12, 90);
        const view = planDay(base(wind, { start, places, visited: null }));
        const scores = view.scores;
        const a = scores.get('osm-node930001')!;
        const b = scores.get('osm-node930002')!;
        expect(a.comfort).toBeGreaterThan(0);
        expect(b.comfort).toBeCloseTo(a.comfort, 9);
        expect(b.dayOut).toBeGreaterThan(a.dayOut);
    });
});

// ── 5. Cost ────────────────────────────────────────────────────

describe('the area sweep is cheap enough for every chip tap', () => {
    it('plans every Airlie place on the area wind: median well inside 150 ms (fails only past 600 ms)', () => {
        const times: number[] = [];
        let planned = 0;
        for (let i = 0; i < 5; i++) {
            // A fresh block each run, so nothing is remembered from the run before.
            const input = base(WINDS['E 12'], { stay: '1h', atmos: block(Math.floor(NOW / H) * H, WINDS['E 12']) });
            const t0 = performance.now();
            const view = planDay(input);
            times.push(performance.now() - t0);
            planned = view.ranked.length;
        }
        times.sort((a, b) => a - b);
        const median = times[2];
        console.info(
            `127-PYD-4 area sweep: ${planned} places, median ${median.toFixed(1)} ms (runs ${times.map((t) => t.toFixed(0)).join(', ')})`,
        );
        expect(planned).toBeGreaterThan(40);
        expect(median).toBeLessThan(600);
    });
});

// ── 6. Worldwide ───────────────────────────────────────────────

describe('worldwide', () => {
    it('Nouméa (OpenStreetMap only, no coastline): three picks with true tags, all "Shelter not known", never Inside', () => {
        const start = { lat: -22.2758, lon: 166.4406, name: 'Port Moselle' };
        const now = Date.UTC(2026, 9, 7, 19, 30);
        const places = gatherPlaces({
            start,
            nowMs: now,
            radiusNm: 30,
            atlas: [],
            osm: [
                {
                    points: [
                        osmAnchorage(910001, 'Fixture Anse', { lat: -22.33, lon: 166.42 }, now - H),
                        osmAnchorage(910002, 'Fixture Baie', { lat: -22.36, lon: 166.55 }, now - H),
                        osmAnchorage(910003, 'Fixture Îlot', { lat: -22.41, lon: 166.38 }, now - H),
                    ],
                    stale: false,
                },
            ],
            coastline: null,
        });
        const wind = steady(14, 135);
        const visited = [{ lat: -22.36, lon: 166.551 }];
        const { view } = plan(
            base(wind, {
                nowMs: now,
                zone: 'Pacific/Noumea',
                start,
                places,
                date: null,
                atmos: block(Math.floor(now / H) * H, wind),
                visited,
            }),
            wind,
        );
        expect(view.top).toHaveLength(3);
        for (const row of view.top) {
            expect(row.shelter).toBe('Shelter not known');
            expect(row.level).not.toBe('inside');
            expect(row.parks).toBe(false);
        }
        expect(tagIssues(view, visited, start)).toEqual([]);
    });

    it('Horta with every mapped place under 3 NM (OpenStreetMap only): the hops fill the card, are route-checked and open', () => {
        // Review 2026-10-10: with nothing 3 NM out the card was empty, nothing was checked, and the
        // day read as an ordinary one. Fictional anchorages 1.2-1.5 NM from a fictional Horta start.
        const start = { lat: 38.53, lon: -28.62, name: 'Fixture Marina' };
        const now = Date.UTC(2026, 9, 10, 6, 30);
        const places = gatherPlaces({
            start,
            nowMs: now,
            radiusNm: 30,
            atlas: [],
            osm: [
                {
                    points: [
                        osmAnchorage(940001, 'Fixture Enseada', { lat: 38.555, lon: -28.62 }, now - H),
                        osmAnchorage(940002, 'Fixture Calheta', { lat: 38.53, lon: -28.59 }, now - H),
                        osmAnchorage(940003, 'Fixture Porto', { lat: 38.51, lon: -28.64 }, now - H),
                    ],
                    stale: false,
                },
            ],
            coastline: null,
        });
        const wind = steady(10, 225);
        const input = base(wind, {
            nowMs: now,
            zone: 'Atlantic/Azores',
            start,
            places,
            date: null,
            atmos: block(Math.floor(now / H) * H, wind),
            visited: null,
        });
        const { first, view } = plan(input, wind);
        expect(first.ranked.every((p) => p.candidate.straightNm < 3)).toBe(true);
        expect(view.top.length).toBe(3);
        expect(first.needsLegs.map((n) => n.id).sort()).toEqual(view.top.map((r) => r.id).sort());
        for (const row of view.top) {
            expect(view.rows.get(row.id)?.plan, row.name).toBeTruthy();
            expect(row.level).not.toBe('inside');
        }
        expect(tagIssues(view, null, start)).toEqual([]);
    });

    it('Tromsø with nothing mapped keeps "No anchorages mapped near here"', () => {
        const start = { lat: 69.6496, lon: 18.956, name: 'Tromsø' };
        const now = Date.UTC(2026, 5, 21, 6);
        const empty = gatherPlaces({ start, nowMs: now, radiusNm: 30, atlas: [], osm: [], coastline: null });
        const view = planDay(
            base(steady(10, 200), {
                nowMs: now,
                zone: 'Europe/Oslo',
                start,
                places: empty,
                date: null,
                atmos: block(Math.floor(now / H) * H, steady(10, 200)),
            }),
        );
        expect(view.state).toBe('no-places');
        expect(view.headline.text).toBe('No anchorages mapped near here in OpenStreetMap.');
        expect(view.top).toEqual([]);
        expect(view.needsLegs).toEqual([]);
    });
});
