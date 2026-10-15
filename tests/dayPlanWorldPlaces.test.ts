/**
 * Plan Your Day, places worldwide (131-PYD-10).
 *
 * Planned in 127 as 127-PYD-10 and moved up to 131 so Plan Your Day works
 * outside Queensland: in Tromsø the named bays within reach instead of "No
 * anchorages mapped near here"; an unnamed anchorage takes the nearest named
 * bay ("Anchorage off Baie du Dervin"); an anchorage area counts ("area: pick
 * your spot"); and the start has a name instead of a latitude. Queensland is
 * unchanged: its atlas holds its bays, and no names are asked for there.
 *
 * Fixtures only (tests/fixtures/pydWorldPlaces.ts): invented Overpass answers
 * round Tromsø and southern Brittany. Nothing here touches the network.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    CrowdedCellError,
    NAMED_PLACES_MAX,
    SETTLEMENTS_MAX,
    namedPlacesQuery,
    parseNamedPlaces,
    parseOsmReferences,
    type NamedPlace,
} from '../services/anchorages/cruisingReference';
import { DEFAULT_CRUISING_POLAR } from '../services/defaultPolar';
import {
    BAY_LIMIT,
    PLACE_LIMIT,
    SETTLEMENT_NM,
    crossesCoastline,
    gatherPlaces,
    landFetchTableNm,
    marinaNear,
    nameStart,
    type AtlasFeature,
    type GatherPlacesInput,
    type LatLon,
} from '../services/dayPlanner/places';
import { assessFetch, indexCoastline, type Segment } from '../services/weather/shelter/shelterGeometry';
import { planDay, resolveDayPlanLimits, type DayPlanInput } from '../services/dayPlanner/today';
import { loadToday } from '../services/dayPlanner/todayLoader';
import type { PassageSpeedModel } from '../services/passagePlan';
import { DEFAULT_VESSEL } from '../utils/defaultVessel';
import {
    BRITTANY,
    BRITTANY_ANCHORAGES,
    BRITTANY_NAMES,
    TROMSO,
    TROMSO_ANCHORAGES,
    TROMSO_NAMES,
    offset,
} from './fixtures/pydWorldPlaces';
import { fakeTodayDeps, pointBlock } from './helpers/dayPlanFixtures';

const H = 3_600_000;
/** 06:00 UTC on 21 June 2026: the midnight sun at Tromsø, a summer morning in Brittany. */
const NOW = Date.UTC(2026, 5, 21, 6);
const RETRIEVED = new Date(NOW - H).toISOString();
const SAIL: PassageSpeedModel = {
    mode: 'polar',
    cruiseKts: 6,
    isSail: true,
    polar: DEFAULT_CRUISING_POLAR,
    closeHauledDeg: 40,
};

const tromsoNames = parseNamedPlaces(TROMSO_NAMES);
const brittanyNames = parseNamedPlaces(BRITTANY_NAMES);
const brittanyAnchorages = parseOsmReferences(BRITTANY_ANCHORAGES, RETRIEVED);

function gather(start: LatLon, over: Partial<GatherPlacesInput> = {}) {
    return gatherPlaces({ start, nowMs: NOW, radiusNm: 30, atlas: [], osm: [], coastline: null, ...over });
}

function day(start: LatLon & { name: string }, zone: string, places: DayPlanInput['places']): DayPlanInput {
    return {
        nowMs: NOW,
        zone,
        start,
        stay: '2h',
        limits: resolveDayPlanLimits(undefined, DEFAULT_VESSEL, true),
        speed: SAIL,
        usingDefaultVessel: true,
        atmos: pointBlock(Math.floor(NOW / H) * H, () => ({ kts: 10, dir: 200 })),
        weather: 'ok',
        places,
        placesStatus: 'ok',
        tides: null,
        date: null,
    };
}

const bay = (n: number, name: string, at: LatLon): NamedPlace => ({ id: `osm-node${n}`, kind: 'bay', name, ...at });

// ── The Overpass answer ────────────────────────────────────────

describe('the named places query (one coarse cell, as the anchorages are asked)', () => {
    const query = namedPlacesQuery({ key: '69:18', south: 69, west: 18, north: 70, east: 19 });

    it("asks for the cell's bays and marinas, then its towns and villages, each layer with its own cap", () => {
        expect(query).toBe(
            '[out:json][timeout:25];' +
                '(nw["natural"="bay"](69,18,70,19);nw["leisure"="marina"](69,18,70,19););' +
                `out tags center ${NAMED_PLACES_MAX + 1};` +
                '(node["place"="city"](69,18,70,19);node["place"="town"](69,18,70,19);node["place"="village"](69,18,70,19););' +
                `out tags center ${SETTLEMENTS_MAX + 1};`,
        );
    });

    it('asks only by key and value: no bare ["name"] filter, no regex, no hamlets (they took Overpass 51 s)', () => {
        expect(query).not.toContain('["name"]');
        expect(query).not.toContain('~');
        expect(query).not.toContain('hamlet');
    });

    it('keeps named bays, marinas, towns and villages; drops unnamed, relations, hamlets and other places', () => {
        expect(tromsoNames.map((p) => [p.kind, p.name])).toEqual([
            ['city', 'Tromsø'],
            ['marina', 'Fixture Båthavn'],
            ['bay', 'Fixture Vika'],
            ['bay', 'Fixture Bukta'],
            ['bay', 'Fixture Hamna'],
            ['bay', 'Fixture Kjosen'],
            ['bay', 'Fixture Sundet'],
            ['bay', 'Fixturfjorden'],
            ['bay', 'Fixture Langtvekk'],
        ]);
        expect(tromsoNames.find((p) => p.name === 'Fixture Kjosen')?.id).toBe('osm-way990000006');
    });

    const bayAt = (id: number) => ({
        type: 'node',
        id,
        lat: 69.7,
        lon: 18.9,
        tags: { natural: 'bay', name: `Vik ${id}` },
    });
    const villageAt = (id: number) => ({
        type: 'node',
        id,
        lat: 69.6,
        lon: 18.8,
        tags: { place: 'village', name: `By ${id}` },
    });
    const range = (count: number, from: number) => Array.from({ length: count }, (_, i) => from + i);

    it('never takes a cut-short answer as the whole cell: more bays than the cap is a crowded cell', () => {
        expect(() => parseNamedPlaces({ elements: [], remark: 'runtime error: timeout' })).toThrow(/Incomplete/);
        expect(() => parseNamedPlaces(null)).toThrow();
        expect(parseNamedPlaces({ elements: range(NAMED_PLACES_MAX, 1).map(bayAt) })).toHaveLength(NAMED_PLACES_MAX);
        expect(() => parseNamedPlaces({ elements: range(NAMED_PLACES_MAX + 1, 1).map(bayAt) })).toThrow(
            CrowdedCellError,
        );
        // The same bay twice is one bay.
        const twice = range(NAMED_PLACES_MAX, 1).map(bayAt);
        expect(parseNamedPlaces({ elements: [...twice, twice[0]] })).toHaveLength(NAMED_PLACES_MAX);
    });

    it('a dense layer of towns and villages can never sink the bays: cut short, the towns are left out whole', () => {
        const bays = range(5, 1).map(bayAt);
        const atCap = parseNamedPlaces({ elements: [...bays, ...range(SETTLEMENTS_MAX, 100).map(villageAt)] });
        expect(atCap).toHaveLength(5 + SETTLEMENTS_MAX);
        const over = parseNamedPlaces({ elements: [...bays, ...range(SETTLEMENTS_MAX + 1, 100).map(villageAt)] });
        expect(over.map((p) => p.kind)).toEqual(['bay', 'bay', 'bay', 'bay', 'bay']);
        // A bay that is also a village comes back in both layers, and counts in each once.
        const both = { ...bayAt(9), tags: { natural: 'bay', place: 'village', name: 'Vik og By' } };
        const villages = range(SETTLEMENTS_MAX - 1, 100).map(villageAt);
        expect(parseNamedPlaces({ elements: [both, ...villages, both] })).toHaveLength(SETTLEMENTS_MAX);
    });
});

// ── Tromsø ─────────────────────────────────────────────────────

describe('Tromsø: the named bays within reach, where no anchorage is charted', () => {
    const places = gather(TROMSO, {
        osm: [{ points: parseOsmReferences(TROMSO_ANCHORAGES, RETRIEVED), stale: false }],
        names: [{ points: tromsoNames }],
    });

    it('lists the bays in reach, never a sound, a fjord or one out of reach', () => {
        expect(places.candidates.map((c) => c.name)).toEqual([
            'Fixture Vika',
            'Fixture Bukta',
            'Fixture Hamna',
            'Fixture Kjosen',
        ]);
        expect(places.candidates.every((c) => c.kind === 'bay' && c.source === 'osm' && !c.reviewed)).toBe(true);
        expect(places.excluded).toEqual([]);
        // No coastline in the fixture: shelter is not known, never invented.
        expect(places.candidates.every((c) => c.fetchLandNM === null)).toBe(true);
    });

    it('names the start "Tromsø" instead of a latitude, and finds the marina beside it', () => {
        expect(nameStart(TROMSO, places.named, [])).toBe('Tromsø');
        expect(nameStart(TROMSO, [], [])).toBe('69.65°N 18.96°E');
        expect(marinaNear(TROMSO, places.marinas)?.name).toBe('Fixture Båthavn');
    });

    it('plans the day on them: never "No anchorages mapped near here"', () => {
        const view = planDay(day({ ...TROMSO, name: 'Tromsø' }, 'Europe/Oslo', places));
        expect(view.state).not.toBe('no-places');
        expect(view.headline.text).not.toMatch(/No anchorages mapped/);
        expect(view.ranked.map((p) => p.candidate.name)).toEqual(
            expect.arrayContaining(['Fixture Vika', 'Fixture Bukta', 'Fixture Hamna']),
        );
        const row = view.rows.get(places.candidates[0].id)!;
        expect(row.kind).toBe('Mapped bay · not reviewed');
        expect(row.shelter).toBe('Shelter not known');
        expect(view.top.every((r) => r.level !== 'inside')).toBe(true);
    });

    it('with nothing mapped at all, still says "No anchorages mapped near here"', () => {
        const view = planDay(day({ ...TROMSO, name: 'Tromsø' }, 'Europe/Oslo', gather(TROMSO)));
        expect(view.state).toBe('no-places');
        expect(view.headline.text).toBe('No anchorages mapped near here in OpenStreetMap.');
    });
});

// ── Southern Brittany ──────────────────────────────────────────

describe('a French bay: unnamed anchorages, anchorage areas and the start', () => {
    const places = gather(BRITTANY, {
        osm: [{ points: brittanyAnchorages, stale: false }],
        names: [{ points: brittanyNames }],
    });
    const byName = (name: string) => places.candidates.find((c) => c.name === name);

    it('an unnamed anchorage takes the nearest named bay: "Anchorage off Baie du Dervin"', () => {
        const off = byName('Anchorage off Baie du Dervin');
        expect(off?.id).toBe('osm-node991100001');
        expect(off?.kind).toBeUndefined();
        // The bay it is off is that anchorage's place, not a second row beside it.
        expect(byName('Baie du Dervin')).toBeUndefined();
    });

    it('with no bay within a mile, a village; with nothing named near, it stays a mapped anchorage', () => {
        expect(byName('Anchorage off Bourg Fixture')?.id).toBe('osm-node991100004');
        expect(byName('Mapped anchorage')?.id).toBe('osm-node991100005');
    });

    it('an anchorage area counts, at its centre, and its page says to pick your spot', () => {
        const area = byName('Zone de mouillage Fixture')!;
        expect(area.id).toBe('osm-way991100002');
        expect(area.kind).toBe('area');
        const view = planDay(day({ ...BRITTANY, name: 'Fixture-sur-Mer' }, 'Europe/Paris', places));
        const row = view.rows.get(area.id)!;
        expect(row.kind).toBe('Mapped anchorage · area: pick your spot · not reviewed');
        expect(row.place).toMatch(/^Mapped anchorage · area: pick your spot · not reviewed/);
        expect(view.rows.get('osm-node991100001')!.kind).toBe('Mapped anchorage · not reviewed');
    });

    it('a bay with nothing charted near is a place; one beside a no-anchoring point or named a passage is not', () => {
        expect(byName('Anse de Fixture')?.kind).toBe('bay');
        expect(places.excluded.map((e) => [e.name, e.reason])).toEqual([
            ['Mouillage Interdit Fixture', 'no anchoring here'],
        ]);
        const all = [...places.candidates, ...places.excluded].map((p) => p.name);
        expect(all).not.toContain('Baie Interdite');
        expect(all).not.toContain('Passage du Fixture');
    });

    it('names the start from the village 0.8 NM off, instead of a latitude', () => {
        expect(nameStart(BRITTANY, places.named, [])).toBe('Fixture-sur-Mer');
        expect(marinaNear(BRITTANY, places.marinas)).toBeNull();
    });
});

// ── Naming the start ───────────────────────────────────────────

describe('naming the start (131-PYD-10)', () => {
    const at = { lat: 47.585, lon: -3.03 };
    const named = [
        { name: 'Fixture City', lat: offset(at, 2.5, 0).lat, lon: at.lon, withinNm: 3 },
        { name: 'Fixture Village', lat: offset(at, 1.3, 0).lat, lon: at.lon, withinNm: 1 },
    ];

    it("a town's name reaches further than half a mile; a village's only a mile", () => {
        expect(nameStart(at, named, [])).toBe('Fixture City');
        expect(nameStart(at, named.slice(1), [])).toBe('47.59°N 3.03°W');
        expect(SETTLEMENT_NM).toEqual({ city: 3, town: 2, village: 1 });
    });

    it('anything named within half a mile, then a saved place, still come first', () => {
        const bayNear = { name: 'Fixture Cove', lat: offset(at, 0.3, 0).lat, lon: at.lon };
        expect(nameStart(at, [...named, bayNear], [])).toBe('Fixture Cove');
        expect(nameStart(at, named, [{ name: 'Her Mooring', lat: at.lat, lon: at.lon + 0.001 }])).toBe('Her Mooring');
    });

    // Review fix: an unnamed anchorage 0.3 NM off, the city 1.5 NM off, said "Plan from: Mapped anchorage".
    describe('in Tromsø harbour, an unnamed anchorage close by never beats the town', () => {
        const anchorage = (type: 'node' | 'way', id: number, at: LatLon) =>
            parseOsmReferences(
                {
                    elements: [
                        type === 'node'
                            ? { type, id, ...at, tags: { 'seamark:type': 'anchorage' } }
                            : { type, id, center: at, tags: { 'seamark:type': 'anchorage' } },
                    ],
                },
                RETRIEVED,
            );
        const city: NamedPlace = { id: 'osm-node996000001', kind: 'city', name: 'Tromsø', ...offset(TROMSO, -1.5, 0) };
        const vik = bay(996000002, 'Fixture Havnevik', offset(TROMSO, 1.2, 0));
        const near = offset(TROMSO, 0.3, 0);
        const startName = (osm: ReturnType<typeof anchorage>, names: NamedPlace[]) =>
            nameStart(
                TROMSO,
                gather(TROMSO, { osm: [{ points: osm, stale: false }], names: [{ points: names }] }).named,
                [],
            );

        it('"Mapped anchorage" names nothing: the start is Tromsø, for a charted point or an area', () => {
            expect(startName(anchorage('node', 996100001, near), [city])).toBe('Tromsø');
            expect(startName(anchorage('way', 996100002, near), [city])).toBe('Tromsø');
            expect(startName(anchorage('node', 996100001, near), [])).toBe('69.65°N 18.96°E');
        });

        it('"Anchorage off …" gives way to the town, and names the start only before a latitude', () => {
            const osm = anchorage('node', 996100003, near);
            expect(startName(osm, [city, vik])).toBe('Tromsø');
            expect(startName(osm, [vik])).toBe('Anchorage off Fixture Havnevik');
        });

        it('an anchorage with its own name, half a mile off, is still where she is', () => {
            const own = parseOsmReferences(
                {
                    elements: [
                        {
                            type: 'node',
                            id: 996100004,
                            ...near,
                            tags: { 'seamark:type': 'anchorage', name: 'Fixture Ankerplass' },
                        },
                    ],
                },
                RETRIEVED,
            );
            expect(startName(own, [city])).toBe('Fixture Ankerplass');
        });
    });
});

// ── Bays have their own forty ──────────────────────────────────

describe('a fjord full of bays never crowds out its charted anchorages', () => {
    it(`ranks the ${BAY_LIMIT} nearest bays and says why the rest were not ranked`, () => {
        const bays = Array.from({ length: BAY_LIMIT + 5 }, (_, i) =>
            bay(992000000 + i, `Fixture Bay ${i}`, offset(TROMSO, 1.5 + i * 0.1, 0)),
        );
        const far = parseOsmReferences(
            {
                elements: [
                    {
                        type: 'node',
                        id: 992100001,
                        ...offset(TROMSO, 0, -20),
                        tags: { 'seamark:type': 'anchorage', name: 'Fixture Far Anchorage' },
                    },
                ],
            },
            RETRIEVED,
        );
        const places = gather(TROMSO, { osm: [{ points: far, stale: false }], names: [{ points: bays }] });
        expect(places.candidates).toHaveLength(BAY_LIMIT + 1);
        expect(places.candidates.map((c) => c.name)).toContain('Fixture Far Anchorage');
        const unranked = places.excluded.filter((e) => e.reason.startsWith('not ranked'));
        expect(unranked.map((e) => e.name)).toEqual([40, 41, 42, 43, 44].map((i) => `Fixture Bay ${i}`));
        expect(unranked[0].reason).toBe(`not ranked — ${BAY_LIMIT} closer bays checked first`);
        expect(PLACE_LIMIT).toBe(40);
    });
});

// ── Shelter speed ──────────────────────────────────────────────

/** A seeded generator, so the synthetic coast is the same every run. */
function seeded(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** An invented fjord country round a point: jagged islands, `vertices` segments each, within half a degree. */
function islands(centre: LatLon, count: number, vertices: number, seed = 7): Segment[] {
    const r = seeded(seed);
    const cos = Math.cos((centre.lat * Math.PI) / 180);
    const segs: Segment[] = [];
    for (let k = 0; k < count; k++) {
        const at = { lat: centre.lat + (r() - 0.5), lon: centre.lon + (r() - 0.5) / cos };
        const radiusNm = 0.3 + r() * 2;
        const ring: [number, number][] = Array.from({ length: vertices }, (_, i) => {
            const a = (i / vertices) * Math.PI * 2;
            const nm = radiusNm * (0.7 + 0.3 * r());
            return [at.lon + (Math.sin(a) * nm) / 60 / cos, at.lat + (Math.cos(a) * nm) / 60];
        });
        ring.forEach((p, i) => segs.push([p, ring[(i + 1) % vertices]]));
    }
    return segs;
}

describe('shelter speed: the new places are ray-cast fast enough for the phone', () => {
    /** The table as it was worked out before 131-PYD-10: assessFetch, every segment on every bearing. */
    const before = (lat: number, lon: number, coast: Segment[]) =>
        assessFetch(lat, lon, coast, { maxKm: 15 * 1.852 }).fetchByBearingKm.map((km) =>
            Math.min(15, Math.round((km / 1.852) * 10) / 10),
        );

    it.each([
        ['Tromsø', TROMSO],
        ['Brittany', BRITTANY],
        ['the Whitsundays', { lat: -20.265, lon: 148.719 }],
    ])('gives the same land fetch table as before, at %s', (_, centre) => {
        // A long straight segment across the lot, too wide to bucket, as well as the islands.
        const coast = [
            ...islands(centre, 30, 60, 11),
            [
                [centre.lon - 1, centre.lat + 0.2],
                [centre.lon + 1, centre.lat + 0.25],
            ] as Segment,
        ];
        const index = indexCoastline(coast, centre.lat);
        const r = seeded(5);
        for (let i = 0; i < 40; i++) {
            const at = { lat: centre.lat + (r() - 0.5) * 0.8, lon: centre.lon + (r() - 0.5) * 1.5 };
            const want = before(at.lat, at.lon, coast);
            expect(landFetchTableNm(at.lat, at.lon, index), `${at.lat},${at.lon}`).toEqual(want);
            expect(landFetchTableNm(at.lat, at.lon, coast)).toEqual(want);
        }
    });

    it('says what it said before about the line crossing the coast, passing over what lies north or south', () => {
        /** The check as it was before 131-PYD-10: every segment projected, then boxed. */
        const crossedBefore = (a: LatLon, b: LatLon, coast: Segment[]) => {
            const cos = Math.cos((a.lat * Math.PI) / 180);
            const local = (lon: number, lat: number) => [(lon - a.lon) * cos, lat - a.lat];
            const [bx, by] = local(b.lon, b.lat);
            const side = (o: number[], p: number[], q: number[]) =>
                Math.sign((p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]));
            return coast.some(([p, q]) => {
                const c = local(p[0], p[1]);
                const d = local(q[0], q[1]);
                const o = [0, 0];
                const e = [bx, by];
                return side(c, d, o) * side(c, d, e) < 0 && side(o, e, c) * side(o, e, d) < 0;
            });
        };
        const coast = islands(TROMSO, 30, 60, 13);
        const r = seeded(9);
        const near = () => ({ lat: TROMSO.lat + (r() - 0.5) * 0.8, lon: TROMSO.lon + (r() - 0.5) * 1.5 });
        let crossed = 0;
        for (let i = 0; i < 80; i++) {
            const [from, to] = [near(), near()];
            const want = crossedBefore(from, to, coast);
            expect(crossesCoastline(from, to, coast)).toBe(want);
            if (want) crossed++;
        }
        expect(crossed).toBeGreaterThan(5);
        expect(crossed).toBeLessThan(75);
    });

    it('Tromsø: 1,500 bays in the cells over a 100,000-segment coastline, well inside a second (it took 40 s)', () => {
        const coastline = islands(TROMSO, 400, 250);
        expect(coastline).toHaveLength(100_000);
        const r = seeded(3);
        const cos = Math.cos((TROMSO.lat * Math.PI) / 180);
        const bays = Array.from({ length: 1500 }, (_, i) =>
            bay(994000000 + i, `Fixture Bay ${i}`, {
                lat: TROMSO.lat + (r() - 0.5) * 2,
                lon: TROMSO.lon + ((r() - 0.5) * 2) / cos,
            }),
        );
        const times: number[] = [];
        let ranked = 0;
        for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const places = gather(TROMSO, { names: [{ points: bays }], coastline });
            times.push(performance.now() - t0);
            ranked = places.candidates.length;
            expect(places.candidates.every((c) => c.fetchLandNM?.length === 36)).toBe(true);
            expect(places.candidates.every((c) => c.distance.basis !== 'unknown')).toBe(true);
        }
        times.sort((a, b) => a - b);
        console.info(
            `131-PYD-10 shelter: ${ranked} ranked of 1,500 bays, 100k segments, median ${times[1].toFixed(0)} ms (runs ${times.map((t) => t.toFixed(0)).join(', ')})`,
        );
        expect(ranked).toBe(BAY_LIMIT);
        expect(times[1]).toBeLessThan(1500);
    });
});

// ── Queensland unchanged ───────────────────────────────────────

describe('Queensland is unchanged', () => {
    const QLD = JSON.parse(readFileSync('public/anchorages/qld/t-22e148.geojson', 'utf8')) as {
        features: AtlasFeature[];
    };
    const MARINA = { lat: -20.265, lon: 148.719 };

    it('where the atlas answers, no names are asked for, and the places are the atlas’s', async () => {
        const deps = fakeTodayDeps({ atlas: QLD.features, nowMs: Date.UTC(2026, 9, 7, 20, 30) });
        let asked = 0;
        deps.loadNamedPlaces = async () => {
            asked++;
            return { points: [bay(993000001, 'Fixture Atlas Bay', offset(MARINA, 0, 6))], stale: false };
        };
        const base = await loadToday({ start: MARINA, cruiseKts: 6 }, { signal: new AbortController().signal, deps });
        expect(asked).toBe(0);
        const atlasOnly = gatherPlaces({
            start: MARINA,
            nowMs: Date.UTC(2026, 9, 7, 20, 30),
            radiusNm: base.radiusNm,
            atlas: QLD.features,
            osm: [],
            coastline: null,
        });
        expect(base.places?.candidates.map((c) => c.id)).toEqual(atlasOnly.candidates.map((c) => c.id));
        expect(base.places?.candidates.some((c) => c.kind)).toBe(false);
        expect(base.start.name).toBe('Airlie Bay');
    });

    it('an atlas place keeps its own table, and one without is still not ray-cast', () => {
        const atlasBay = (id: string, at: LatLon, fetchLandNM?: number[]): AtlasFeature => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [at.lon, at.lat] },
            properties: {
                id,
                name: id,
                kind: 'anchorage',
                source: 'OpenStreetMap',
                ...(fetchLandNM ? { fetchLandNM } : {}),
            },
        });
        const places = gatherPlaces({
            start: MARINA,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [
                atlasBay('osm-node995000001', offset(MARINA, 0, 5), new Array(36).fill(0.4)),
                atlasBay('osm-node995000002', offset(MARINA, 0, 8)),
            ],
            osm: [],
            coastline: islands(MARINA, 30, 60),
        });
        expect(places.candidates.map((c) => c.fetchLandNM?.[0] ?? null)).toEqual([0.4, null]);
    });

    it("away from the atlas, the same cells are asked for their names, with the sheet's signal", async () => {
        const deps = fakeTodayDeps({ nowMs: NOW });
        const cells: string[] = [];
        let signal: AbortSignal | null = null;
        deps.loadNamedPlaces = async (tile, s) => {
            cells.push(tile.key);
            signal = s;
            return { points: tromsoNames, stale: false };
        };
        const asked: string[] = [];
        const reference = deps.loadReferenceTile;
        deps.loadReferenceTile = async (tile, s) => {
            asked.push(tile.key);
            return reference(tile, s);
        };
        const base = await loadToday({ start: TROMSO, cruiseKts: 6 }, { signal: new AbortController().signal, deps });
        expect(cells.sort()).toEqual(asked.sort());
        expect(cells.length).toBeGreaterThan(0);
        expect(cells.length).toBeLessThanOrEqual(4);
        expect(signal).not.toBeNull();
        expect(base.start.name).toBe('Tromsø');
        expect(base.placesStatus).toBe('ok');
        expect(base.places?.candidates.map((c) => c.name)).toContain('Fixture Vika');
    });

    it("names that don't load leave the list short, said so; names alone are still places", async () => {
        const failing = fakeTodayDeps({ nowMs: NOW });
        failing.loadNamedPlaces = async () => {
            throw new Error("Today's allowance of place names is used up");
        };
        const short = await loadToday(
            { start: TROMSO, cruiseKts: 6 },
            { signal: new AbortController().signal, deps: failing },
        );
        expect(short.placesStatus).toBe('partial');
        expect(short.start.name).toBe('69.65°N 18.96°E');

        const namesOnly = fakeTodayDeps({ nowMs: NOW, names: tromsoNames });
        namesOnly.loadReferenceTile = async () => {
            throw new Error('Worldwide reference providers unavailable');
        };
        const base = await loadToday(
            { start: TROMSO, cruiseKts: 6 },
            { signal: new AbortController().signal, deps: namesOnly },
        );
        expect(base.placesStatus).toBe('partial');
        expect(base.places?.candidates.map((c) => c.name)).toContain('Fixture Vika');

        // A town alone says nothing about anchorages: unknown, never "No anchorages mapped".
        const townOnly = fakeTodayDeps({ nowMs: NOW, names: tromsoNames.filter((p) => p.kind === 'city') });
        townOnly.loadReferenceTile = namesOnly.loadReferenceTile;
        const unknown = await loadToday(
            { start: TROMSO, cruiseKts: 6 },
            { signal: new AbortController().signal, deps: townOnly },
        );
        expect(unknown.placesStatus).toBe('failed');
        expect(unknown.places).toBeNull();
    });
});
