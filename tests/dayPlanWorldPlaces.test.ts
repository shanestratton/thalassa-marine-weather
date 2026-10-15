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
    NAMED_PLACES_MAX,
    namedPlacesQuery,
    parseNamedPlaces,
    parseOsmReferences,
    type NamedPlace,
} from '../services/anchorages/cruisingReference';
import { DEFAULT_CRUISING_POLAR } from '../services/defaultPolar';
import {
    BAY_LIMIT,
    PLACE_LIMIT,
    gatherPlaces,
    marinaNear,
    nameStart,
    type AtlasFeature,
    type GatherPlacesInput,
    type LatLon,
} from '../services/dayPlanner/places';
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
    it("asks for the cell's named bays, marinas and settlements, centres for ways, and caps the answer", () => {
        const query = namedPlacesQuery({ key: '69:18', south: 69, west: 18, north: 70, east: 19 });
        expect(query).toContain('nw["natural"="bay"]["name"](69,18,70,19)');
        expect(query).toContain('nw["leisure"="marina"]["name"](69,18,70,19)');
        expect(query).toContain('node["place"~"^(city|town|village|hamlet)$"]["name"](69,18,70,19)');
        expect(query).toContain(`out tags center ${NAMED_PLACES_MAX + 1};`);
    });

    it('keeps named bays, marinas and settlements; drops unnamed, relations and other places', () => {
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
            ['hamlet', 'Fixture Grend'],
        ]);
        expect(tromsoNames.find((p) => p.name === 'Fixture Kjosen')?.id).toBe('osm-way990000006');
    });

    it('never takes a cut-short answer as the whole cell', () => {
        expect(() => parseNamedPlaces({ elements: [], remark: 'runtime error: timeout' })).toThrow(/Incomplete/);
        const full = { elements: Array.from({ length: NAMED_PLACES_MAX + 1 }, () => TROMSO_NAMES.elements[2]) };
        expect(() => parseNamedPlaces(full)).toThrow(/Incomplete/);
        expect(() => parseNamedPlaces(null)).toThrow();
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

    it('with no bay within a mile, a hamlet; with nothing named near, it stays a mapped anchorage', () => {
        expect(byName('Anchorage off Hameau Fixture')?.id).toBe('osm-node991100004');
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
        { name: 'Fixture Hamlet', lat: offset(at, 0.8, 0).lat, lon: at.lon, withinNm: 0.5 },
    ];

    it("a town's name reaches further than half a mile; a hamlet's does not", () => {
        expect(nameStart(at, named, [])).toBe('Fixture City');
        expect(nameStart(at, named.slice(1), [])).toBe('47.59°N 3.03°W');
    });

    it('anything named within half a mile, then a saved place, still come first', () => {
        const bayNear = { name: 'Fixture Cove', lat: offset(at, 0.3, 0).lat, lon: at.lon };
        expect(nameStart(at, [...named, bayNear], [])).toBe('Fixture Cove');
        expect(nameStart(at, named, [{ name: 'Her Mooring', lat: at.lat, lon: at.lon + 0.001 }])).toBe('Her Mooring');
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
