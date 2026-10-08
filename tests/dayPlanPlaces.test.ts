/**
 * Plan Your Day, build 124: where the stops come from (services/dayPlanner/places.ts).
 *
 * Worldwide first: OpenStreetMap anchorages everywhere, the Queensland atlas
 * where it exists (it wins the dedupe), the reviewed Whitsundays stops joined
 * on top, and the skipper's own saved routes for real distances. Fictional
 * names only outside the published atlas and reviewed records.
 */
import { describe, expect, it } from 'vitest';
import type { AnchorageProps } from '../services/anchorages/AnchorageService';
import type { CruisingPoint } from '../services/anchorages/cruisingReference';
import type { Segment } from '../services/weather/shelter/shelterGeometry';
import { SHARED_DESTINATION_NOTES } from '../services/dayPlanner/destinations';
import {
    DISTANCE_FACTORS,
    closureOn,
    crossesCoastline,
    dayPlanTiles,
    distanceEstimate,
    formatLatLon,
    gatherPlaces,
    landFetchTableNm,
    matchSavedRoute,
    nameStart,
    reachRadiusNm,
    splitClosed,
    type AtlasFeature,
} from '../services/dayPlanner/places';

const NOW = Date.UTC(2026, 9, 7, 20, 30);
const AIRLIE = { lat: -20.265, lon: 148.719 };

const LAND = (nm: number) => new Array(36).fill(nm);

function atlas(id: string, name: string, lat: number, lon: number, over: Partial<AnchorageProps> = {}): AtlasFeature {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
            id,
            name,
            kind: 'anchorage',
            source: 'OpenStreetMap',
            noAnchoring: false,
            noAnchoringName: null,
            notes: null,
            fetchLandNM: LAND(0.4),
            fetchReefNM: LAND(0.3),
            ...over,
        },
    };
}

function osm(node: number, name: string, lat: number, lon: number, over: Partial<CruisingPoint> = {}): CruisingPoint {
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
        retrievedAt: new Date(NOW - 3_600_000).toISOString(),
        approximate: false,
        restrictionNotes: [],
        ...over,
    };
}

/** A square island of side `km` centred on a point, as coastline segments. */
function island(lat: number, lon: number, halfKm: number): Segment[] {
    const dLat = halfKm / 110.54;
    const dLon = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
    const c: [number, number][] = [
        [lon - dLon, lat - dLat],
        [lon + dLon, lat - dLat],
        [lon + dLon, lat + dLat],
        [lon - dLon, lat + dLat],
    ];
    return c.map((p, i) => [p, c[(i + 1) % 4]] as Segment);
}

const CID = atlas('osm-node3020491514', 'Cid Harbour', -20.24511, 148.94836);
const NARA = atlas('osm-node2838871153', 'Nara Inlet', -20.1374, 148.91214);
const MARINA = atlas('osm-way245930150', 'Coral Sea Marina Resort', -20.2659, 148.7111, { kind: 'marina' });

describe('gatherPlaces: the merge', () => {
    it('the atlas wins the OpenStreetMap dedupe, by id, with its baked land fetch', () => {
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [CID],
            osm: [{ points: [osm(3020491514, 'Cid Harbour (OSM copy)', -20.24511, 148.94836)], stale: false }],
            coastline: null,
        });
        const cid = places.candidates.filter((c) => c.id === 'osm-node3020491514');
        expect(cid).toHaveLength(1);
        expect(cid[0].source).not.toBe('osm');
        expect(cid[0].fetchLandNM).toEqual(LAND(0.4));
    });

    it('joins the reviewed Whitsundays stop on its anchorage id: display name, Parks tag and landing tide', () => {
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [CID],
            osm: [],
            coastline: null,
        });
        const cid = places.candidates.find((c) => c.id === 'osm-node3020491514')!;
        expect(cid.name).toBe('Cid Harbour · Sawmill Beach');
        expect(cid.reviewed?.parks).toBe('Queensland Parks');
        expect(cid.reviewed?.landingTide).toBe('mid-to-high');
        expect(places.region?.id).toBe('whitsundays');
    });

    it("carries the stop's own Parks notes (the shark warning), without the catalogue's shared boilerplate", () => {
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [CID],
            osm: [],
            coastline: null,
        });
        const reviewed = places.candidates.find((c) => c.id === 'osm-node3020491514')!.reviewed!;
        expect(reviewed.accessNotes[0]).toMatch(/^Do not swim in Cid Harbour: .*dangerous sharks/);
        expect(reviewed.accessNotes.join(' ')).toMatch(/not a beach landing/);
        for (const note of [...reviewed.accessNotes, ...reviewed.uncertaintyNotes])
            expect(SHARED_DESTINATION_NOTES.has(note)).toBe(false);
        expect(reviewed.accessWinds).toBeUndefined();
    });

    it('a marina is never a destination; it names the start and feeds the marina line', () => {
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [MARINA, CID],
            osm: [],
            coastline: null,
        });
        expect(places.candidates.map((c) => c.id)).not.toContain('osm-way245930150');
        expect(places.marinas.map((m) => m.name)).toEqual(['Coral Sea Marina Resort']);
    });

    it('a no-anchoring area and a restricted OpenStreetMap point go to Not today, never to scoring', () => {
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [
                atlas('osm-node2838870586', 'Luncheon Bay', -20.06464, 148.94978, {
                    noAnchoring: true,
                    noAnchoringName: 'Luncheon Bay',
                }),
            ],
            osm: [
                {
                    points: [osm(901, 'Fictional Cove', -20.2, 148.8, { notes: 'No anchoring: seagrass' })],
                    stale: false,
                },
            ],
            coastline: null,
        });
        expect(places.candidates).toEqual([]);
        expect(places.excluded.map((e) => [e.name, e.reason])).toEqual([
            ['Fictional Cove', 'no anchoring here'],
            ['Luncheon Bay', 'no anchoring here'],
        ]);
    });

    it('drops approximate and mooring points, and anything within 1 NM of the start', () => {
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [atlas('osm-node2541206070', 'Airlie Bay', -20.26514, 148.71899)],
            osm: [
                {
                    points: [
                        osm(902, 'Fictional Way Centre', -20.2, 148.8, { approximate: true }),
                        osm(903, 'Fictional Mooring', -20.21, 148.8, { kind: 'mooring' }),
                        osm(904, 'Fictional Bight', -20.22, 148.8),
                    ],
                    stale: false,
                },
            ],
            coastline: null,
        });
        expect(places.candidates.map((c) => c.name)).toEqual(['Fictional Bight']);
    });

    it('keeps the 40 nearest and says why the rest were not ranked', () => {
        const points = Array.from({ length: 45 }, (_, i) =>
            osm(1000 + i, `Fictional Bay ${i}`, AIRLIE.lat, AIRLIE.lon + 0.03 + i * 0.005),
        );
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points, stale: false }],
            coastline: null,
        });
        expect(places.candidates).toHaveLength(40);
        expect(places.candidates[0].name).toBe('Fictional Bay 0');
        const unranked = places.excluded.filter((e) => e.reason.startsWith('not ranked'));
        expect(unranked).toHaveLength(5);
        expect(unranked[0].reason).toBe('not ranked — 40 closer places checked first');
    });

    it('always ranks the reviewed stops, even beyond the 40 nearest', () => {
        // Forty fictional bays inside 9 NM, and Cid Harbour at 13 NM.
        const near = Array.from({ length: 40 }, (_, i) =>
            atlas(`osm-node${7000 + i}`, `Fictional Bay ${i}`, AIRLIE.lat - 0.02, AIRLIE.lon + 0.03 + i * 0.003),
        );
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [...near, CID],
            osm: [],
            coastline: null,
        });
        expect(places.candidates).toHaveLength(40);
        expect(places.candidates.map((c) => c.id)).toContain('osm-node3020491514');
        expect(places.excluded.map((e) => e.name)).toEqual(['Fictional Bay 39']);
    });

    it('one place, one row: the same name within 2.5 NM is the same place mapped twice', () => {
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [
                // GBRMPA's designated anchorage, 1.1 NM from the OSM node.
                atlas('gbrmpa-80025', 'Cid Harbour', -20.2559, 148.9434, { kind: 'designated_anchorage' }),
                CID,
                // Same name, far apart: two places.
                atlas('osm-node7101', 'Turtle Bay', -20.2, 148.8),
                atlas('osm-node7102', 'Turtle Bay', -20.35, 149.1),
            ],
            osm: [],
            coastline: null,
        });
        const ids = places.candidates.map((c) => c.id);
        expect(ids).toContain('osm-node3020491514');
        expect(ids).not.toContain('gbrmpa-80025');
        expect(ids).toEqual(expect.arrayContaining(['osm-node7101', 'osm-node7102']));
    });

    it('uses OpenStreetMap places older than 24 h, dated, instead of refusing them', () => {
        const old = new Date(Date.UTC(2026, 8, 12, 3)).toISOString();
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osm(905, 'Fictional Lagoon', -20.2, 148.8, { retrievedAt: old })], stale: true }],
            coastline: null,
        });
        expect(places.candidates[0].mappedAtMs).toBe(Date.parse(old));
        expect(places.mapDataFromMs).toBe(Date.parse(old));

        const fresh = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osm(905, 'Fictional Lagoon', -20.2, 148.8)], stale: false }],
            coastline: null,
        });
        expect(fresh.candidates[0].mappedAtMs).toBeUndefined();
        expect(fresh.mapDataFromMs).toBeNull();
    });

    it('gives OpenStreetMap stops a land-only fetch table from the coastline, and none without it', () => {
        const stop = { lat: -20.2, lon: 148.8 };
        const withCoast = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osm(906, 'Fictional Haven', stop.lat, stop.lon)], stale: false }],
            coastline: island(stop.lat, stop.lon, 3.704),
        });
        // A ring of land 2 NM out on every side, from inside it.
        for (const nm of withCoast.candidates[0].fetchLandNM!) expect(nm).toBeGreaterThan(1.9);
        for (const nm of withCoast.candidates[0].fetchLandNM!) expect(nm).toBeLessThan(2.9);
        const without = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [],
            osm: [{ points: [osm(906, 'Fictional Haven', stop.lat, stop.lon)], stale: false }],
            coastline: null,
        });
        expect(without.candidates[0].fetchLandNM).toBeNull();
    });
});

describe('closures come before anything is scored', () => {
    it('Nara Inlet is closed on 8 October and open again on the 16th', () => {
        const places = gatherPlaces({
            start: AIRLIE,
            nowMs: NOW,
            radiusNm: 30,
            atlas: [CID, NARA],
            osm: [],
            coastline: null,
        });
        const on8 = splitClosed(places.candidates, '2026-10-08');
        expect(on8.closed).toEqual([
            expect.objectContaining({ id: 'osm-node2838871153', reason: 'closed 6–15 Oct (Queensland Parks)' }),
        ]);
        expect(on8.open.map((c) => c.id)).toEqual(['osm-node3020491514']);
        const on16 = splitClosed(places.candidates, '2026-10-16');
        expect(on16.closed).toEqual([]);
        expect(on16.open).toHaveLength(2);
        expect(closureOn(places.candidates.find((c) => c.id === 'osm-node2838871153')!, '2026-10-15')).toBe(
            'closed 6–15 Oct (Queensland Parks)',
        );
    });
});

describe('shelter tables', () => {
    it('converts km to NM and caps open water at 15 NM', () => {
        const open = landFetchTableNm(-20.2, 148.8, []);
        expect(open).toHaveLength(36);
        for (const nm of open!) expect(nm).toBe(15);
        const boxed = landFetchTableNm(-20.2, 148.8, island(-20.2, 148.8, 1.852));
        // 1 NM to the north, east, south and west walls.
        expect(boxed![0]).toBeCloseTo(1, 1);
        expect(boxed![9]).toBeCloseTo(1, 1);
        expect(landFetchTableNm(-20.2, 148.8, null)).toBeNull();
    });
});

describe('distance basis', () => {
    const stop = { lat: -20.265, lon: 148.9 };
    it('× 1.3 when the coastline is unknown, × 1.15 clear of it, × 1.4 when the line crosses it', () => {
        expect(DISTANCE_FACTORS).toEqual({ clear: 1.15, crosses: 1.4, unknown: 1.3 });
        const unknown = distanceEstimate(AIRLIE, stop, null);
        expect(unknown.basis).toBe('unknown');
        expect(unknown.nm).toBeCloseTo(unknown.straightNm * 1.3, 6);

        const clear = distanceEstimate(AIRLIE, stop, island(-20.1, 148.8, 1));
        expect(clear.basis).toBe('clear');
        expect(clear.nm).toBeCloseTo(clear.straightNm * 1.15, 6);

        const inTheWay = island(-20.265, 148.81, 2);
        expect(crossesCoastline(AIRLIE, stop, inTheWay)).toBe(true);
        const crosses = distanceEstimate(AIRLIE, stop, inTheWay);
        expect(crosses.basis).toBe('crosses');
        expect(crosses.nm).toBeCloseTo(crosses.straightNm * 1.4, 6);
    });

    it('a saved route joining start and stop (either way round) gives its real geometry and length', () => {
        const dogleg = [AIRLIE, { lat: -20.3, lon: 148.8 }, stop];
        const routes = [
            {
                name: 'Fictional elsewhere',
                points: [
                    { lat: -27, lon: 153 },
                    { lat: -27.1, lon: 153.1 },
                ],
            },
            { name: 'Airlie → Fictional Point', points: [...dogleg].reverse() },
        ];
        const match = matchSavedRoute(AIRLIE, stop, routes)!;
        expect(match.name).toBe('Airlie → Fictional Point');
        // Oriented start → stop whichever way it was saved.
        expect(match.points[0]).toEqual(AIRLIE);
        expect(match.points[match.points.length - 1]).toEqual(stop);
        const est = distanceEstimate(AIRLIE, stop, null, match);
        expect(est.basis).toBe('saved');
        expect(est.factor).toBe(1);
        expect(est.nm).toBeCloseTo(match.lengthNm, 6);
        expect(est.nm).toBeGreaterThan(est.straightNm);
        // Half a mile out at either end is no match.
        expect(matchSavedRoute(AIRLIE, { lat: -20.265, lon: 148.92 }, routes)).toBeNull();
    });
});

describe('reach and the reference cells', () => {
    it('reach radius is clamped to 3–30 NM', () => {
        expect(reachRadiusNm(6, 11, 2)).toBeCloseTo(Math.min(30, (6 * 9) / 2 / 1.15), 6);
        expect(reachRadiusNm(6, 2, 2)).toBe(3);
        expect(reachRadiusNm(20, 14, 'overnight')).toBe(30);
        expect(reachRadiusNm(6, 5, 'overnight')).toBeCloseTo((6 * 4) / 1.15, 6);
    });

    it('asks for at most four one-degree cells, nearest first', () => {
        const { tiles } = dayPlanTiles(AIRLIE, 30);
        expect(tiles.length).toBeGreaterThan(0);
        expect(tiles.length).toBeLessThanOrEqual(4);
        expect(tiles[0].key).toBe('-21:148');
        // Nouméa: a worldwide start with no atlas.
        const noumea = dayPlanTiles({ lat: -22.28, lon: 166.44 }, 20);
        expect(noumea.tiles[0].key).toBe('-23:166');
    });
});

describe('naming the start', () => {
    it('nearest named point within 0.5 NM, else a saved place, else a position', () => {
        const named = [
            { name: 'Coral Sea Marina Resort', lat: -20.2659, lon: 148.7111 },
            { name: 'Fictional Far Bay', lat: -20.3, lon: 148.9 },
        ];
        expect(nameStart({ lat: -20.2655, lon: 148.712 }, named, [])).toBe('Coral Sea Marina Resort');
        expect(
            nameStart({ lat: -20.4, lon: 149.2 }, named, [{ name: 'Fictional Mooring', lat: -20.4, lon: 149.201 }]),
        ).toBe('Fictional Mooring');
        expect(nameStart({ lat: -20.27, lon: 148.72 }, [], [])).toBe('20.27°S 148.72°E');
        expect(formatLatLon(43.29, 5.35)).toBe('43.29°N 5.35°E');
        expect(formatLatLon(64.15, -21.94)).toBe('64.15°N 21.94°W');
    });
});
