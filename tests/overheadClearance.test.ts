/**
 * Part B (inshore router, 2026-09-30): bridges and overhead clearance.
 *
 * Owner decisions: a bridge, overhead cable or overhead pipe whose charted
 * clearance is below the vessel's air draft plus a margin BLOCKS; so does one
 * with no charted clearance; and with no air draft set, every one of them
 * blocks (its clearance cannot be checked). Serene Summer's air draft is
 * 18 m (masthead with antennas); the margin is 1 m, so 19 m is needed.
 *
 * Opening bridges (CATBRG opening / swing / lifting / bascule / pontoon /
 * draw / transporter) block unless their CLOSED clearance already clears:
 * the app cannot know an opening schedule, notice period or whether the
 * bridge is staffed, so the open clearance (VERCOP) never passes a mast.
 */
import type { Feature, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
    chartClearanceBars,
    chartStructureClearance,
    clearanceBlock,
    clearanceRefusalMessage,
    CLEARANCE_MARGIN_M,
    CLEARANCE_STRUCTURE_LAYERS,
    curatedClearanceBars,
    polylineCrossesClearanceBar,
} from '../services/routing/overheadClearance';
import { pointInGeometry } from '../services/engine/geometry';

const SERENE_SUMMER_AIR_DRAFT_M = 18;

const across = (props: Record<string, unknown>, lon = 150.01): Feature => ({
    type: 'Feature',
    properties: { acronym: 'BRIDGE', rcid: 7, ...props },
    geometry: {
        type: 'LineString',
        coordinates: [
            [lon, -30.002],
            [lon, -29.998],
        ],
    },
});

describe('the clearance verdict (owner decisions, 2026-09-29/30)', () => {
    const bridge = (props: Record<string, unknown>) => chartStructureClearance('BRIDGE', props);

    it('uses a 1 m margin over the air draft', () => {
        expect(CLEARANCE_MARGIN_M).toBe(1);
    });

    it('a 16 m bridge blocks an 18 m mast; 25 m passes', () => {
        expect(clearanceBlock(bridge({ VERCLR: 16 }), SERENE_SUMMER_AIR_DRAFT_M)).toBe('too-low');
        expect(clearanceBlock(bridge({ VERCLR: 25 }), SERENE_SUMMER_AIR_DRAFT_M)).toBeNull();
    });

    it('the margin is inclusive at air draft + 1 m and blocks just under it', () => {
        expect(clearanceBlock(bridge({ VERCLR: 19 }), SERENE_SUMMER_AIR_DRAFT_M)).toBeNull();
        expect(clearanceBlock(bridge({ VERCLR: 18.9 }), SERENE_SUMMER_AIR_DRAFT_M)).toBe('too-low');
        // Exactly the air draft is not enough: the margin is the point.
        expect(clearanceBlock(bridge({ VERCLR: 18 }), SERENE_SUMMER_AIR_DRAFT_M)).toBe('too-low');
    });

    it('no charted clearance blocks, however tall the bridge may really be', () => {
        expect(clearanceBlock(bridge({}), SERENE_SUMMER_AIR_DRAFT_M)).toBe('clearance-unknown');
        expect(clearanceBlock(bridge({ VERCLR: 'n/a' }), SERENE_SUMMER_AIR_DRAFT_M)).toBe('clearance-unknown');
        expect(clearanceBlock(bridge({ VERCLR: -3 }), SERENE_SUMMER_AIR_DRAFT_M)).toBe('clearance-unknown');
        // A numeric string (the ogr2ogr path) is read like a number.
        expect(clearanceBlock(bridge({ VERCLR: '25' }), SERENE_SUMMER_AIR_DRAFT_M)).toBeNull();
    });

    it('an unset air draft blocks every bridge and overhead line, even a tall one', () => {
        for (const air of [null, undefined, 0, -1, Number.NaN]) {
            expect(clearanceBlock(bridge({ VERCLR: 60 }), air)).toBe('air-draft-unset');
            expect(clearanceBlock(chartStructureClearance('CBLOHD', { VERCSA: 40 }), air)).toBe('air-draft-unset');
        }
    });

    it('an estimated clearance counts as unknown', () => {
        expect(clearanceBlock({ clearanceM: 30, opening: false, estimated: true }, 18)).toBe('clearance-unknown');
    });

    it('opening bridges block unless the CLOSED clearance clears; the open clearance never counts', () => {
        for (const CATBRG of [2, 3, 4, 5, 6, 7, 8, '4', '1,4', ['4']]) {
            const c = bridge({ CATBRG, VERCCL: 5, VERCOP: 40 });
            expect(c.opening, String(CATBRG)).toBe(true);
            expect(clearanceBlock(c, 18), String(CATBRG)).toBe('opening-bridge');
        }
        // Opening, but nothing charted for it closed: still blocked.
        expect(clearanceBlock(bridge({ CATBRG: 4, VERCOP: 40 }), 18)).toBe('opening-bridge');
        // Closed, it already clears the mast: no opening needed.
        expect(clearanceBlock(bridge({ CATBRG: 3, VERCCL: 22, VERCOP: 40 }), 18)).toBeNull();
        // Phase 2a round-2 review (2026-09-30): an opening span charted with
        // VERCLR alone may be giving its OPEN clearance — only VERCCL (and a
        // power line's VERCSA) says what it clears closed, so it still blocks.
        const verclrOnly = bridge({ CATBRG: 4, VERCLR: 30 });
        expect(verclrOnly.opening).toBe(true);
        expect(verclrOnly.clearanceM).toBeNull();
        expect(clearanceBlock(verclrOnly, 18)).toBe('opening-bridge');
        // …and a VERCLR never lifts a lower closed clearance.
        expect(bridge({ CATBRG: 4, VERCLR: 30, VERCCL: 5 }).clearanceM).toBe(5);
        expect(clearanceBlock(bridge({ CATBRG: 4, VERCLR: 30, VERCCL: 22 }), 18)).toBeNull();
        // Fixed (1), suspension (12) and footbridge (9) are not opening bridges.
        for (const CATBRG of [1, 9, 12]) expect(bridge({ CATBRG, VERCLR: 25 }).opening).toBe(false);
    });

    it('the governing clearance is the lowest charted one; a cable reads its safe clearance', () => {
        expect(bridge({ VERCLR: 25, VERCCL: 20 }).clearanceM).toBe(20);
        const cable = chartStructureClearance('CBLOHD', { VERCLR: 30, VERCSA: 17 });
        expect(cable.clearanceM).toBe(17);
        expect(clearanceBlock(cable, 18)).toBe('too-low');
        expect(clearanceBlock(chartStructureClearance('PIPOHD', { VERCLR: 25 }), 18)).toBeNull();
        expect(clearanceBlock(chartStructureClearance('PIPOHD', {}), 18)).toBe('clearance-unknown');
    });
});

describe('clearance bars: the footprint the grid hard-blocks', () => {
    it('a blocking bridge becomes low-clearance bars wide enough for the grid; a passable one none', () => {
        const low = chartClearanceBars({ BRIDGE: [across({ VERCLR: 16, OBJNAM: 'Low Bridge' })] }, 18);
        expect(low.length).toBeGreaterThan(0);
        for (const bar of low) {
            expect(bar.properties).toMatchObject({
                _class: 'low-clearance',
                _source: 'chart',
                _structure: 'bridge',
                _block: 'too-low',
                _clearanceM: 16,
                _airDraftM: 18,
                _name: 'Low Bridge',
                _rcid: 7,
            });
            expect(bar.geometry.type).toBe('Polygon');
        }
        // 30 m either side of the deck line: a 50 m grid cannot slip between.
        const g = low[0].geometry as Polygon;
        const dLon = 25 / (111_320 * Math.cos((30 * Math.PI) / 180));
        expect(pointInGeometry(150.01 + dLon, -30, g)).toBe(true);
        expect(pointInGeometry(150.01 - dLon, -30, g)).toBe(true);
        expect(chartClearanceBars({ BRIDGE: [across({ VERCLR: 25 })] }, 18)).toEqual([]);
    });

    it('unknown clearance, an unset air draft and overhead lines all produce bars', () => {
        expect(chartClearanceBars({ BRIDGE: [across({})] }, 18)[0].properties._block).toBe('clearance-unknown');
        expect(chartClearanceBars({ BRIDGE: [across({ VERCLR: 40 })] }, null)[0].properties._block).toBe(
            'air-draft-unset',
        );
        const cable = chartClearanceBars({ CBLOHD: [across({ acronym: 'CBLOHD', VERCSA: 12 })] }, 18);
        expect(cable[0].properties).toMatchObject({ _structure: 'overhead cable', _block: 'too-low' });
        const pipe = chartClearanceBars({ PIPOHD: [across({ acronym: 'PIPOHD' })] }, 18);
        expect(pipe[0].properties).toMatchObject({ _structure: 'overhead pipe', _block: 'clearance-unknown' });
    });

    // Round 2 (2026-09-30): an overhead conveyor (S-57 CONVYR — a loading
    // gantry over a wharf approach, VERCLR / VERCSA) is a span a mast passes
    // under like any bridge.
    it('an overhead conveyor is a clearance structure: too low or uncharted blocks, tall enough passes', () => {
        expect(CLEARANCE_STRUCTURE_LAYERS).toContain('CONVYR');
        const low = chartClearanceBars(
            { CONVYR: [across({ acronym: 'CONVYR', VERCLR: 15, OBJNAM: 'Coal loader' })] },
            18,
        );
        expect(low[0].properties).toMatchObject({
            _structure: 'overhead conveyor',
            _block: 'too-low',
            _clearanceM: 15,
            _name: 'Coal loader',
        });
        expect(clearanceRefusalMessage(low[0].properties, 'here')).toMatch(/overhead conveyor "Coal loader" has 15 m/);
        expect(chartClearanceBars({ CONVYR: [across({ acronym: 'CONVYR' })] }, 18)[0].properties._block).toBe(
            'clearance-unknown',
        );
        expect(chartClearanceBars({ CONVYR: [across({ acronym: 'CONVYR', VERCSA: 25 })] }, 18)).toEqual([]);
        // An ogr2ogr conveyor carries OBJL (34) and no acronym: still chart
        // data (services/enc/types.ts isS57ChartProps); a feature with neither
        // is not the chart's.
        expect(chartClearanceBars({ CONVYR: [across({ acronym: undefined, OBJL: 34, VERCLR: 12 })] }, 18)).not.toEqual(
            [],
        );
        expect(chartClearanceBars({ CONVYR: [across({ acronym: undefined, VERCLR: 12 })] }, 18)).toEqual([]);
    });

    it('an area bridge blocks its deck and a band around it; a point bridge a square', () => {
        const deck: Feature = {
            type: 'Feature',
            properties: { acronym: 'BRIDGE', VERCLR: 4 },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [150.0099, -30.002],
                        [150.0101, -30.002],
                        [150.0101, -29.998],
                        [150.0099, -29.998],
                        [150.0099, -30.002],
                    ],
                ],
            },
        };
        const bars = chartClearanceBars({ BRIDGE: [deck] }, 18);
        const inAny = (lon: number, lat: number) => bars.some((b) => pointInGeometry(lon, lat, b.geometry as Polygon));
        expect(inAny(150.01, -30)).toBe(true);
        expect(inAny(150.01 + 25 / 96_400, -30)).toBe(true);
        const point: Feature = {
            type: 'Feature',
            properties: { acronym: 'BRIDGE' },
            geometry: { type: 'Point', coordinates: [150.01, -30] },
        };
        const sq = chartClearanceBars({ BRIDGE: [point] }, 18);
        expect(sq).toHaveLength(1);
        expect(pointInGeometry(150.01 + 25 / 96_400, -30 + 25 / 110_540, sq[0].geometry as Polygon)).toBe(true);
    });

    it('non-chart features and features without geometry never produce bars', () => {
        expect(
            chartClearanceBars(
                {
                    BRIDGE: [
                        { type: 'Feature', properties: { acronym: 'BRIDGE' }, geometry: null as never },
                        { type: 'Feature', properties: {}, geometry: across({}).geometry },
                    ],
                },
                18,
            ),
        ).toEqual([]);
    });
});

describe('crossing test and plain-words refusal', () => {
    const bars = chartClearanceBars({ BRIDGE: [across({ VERCLR: 16, OBJNAM: 'Low Bridge' })] }, 18);

    it('a route across the deck line crosses the bar; one beside it does not', () => {
        const hit = polylineCrossesClearanceBar(
            [
                [150.0, -30],
                [150.02, -30],
            ],
            bars,
        );
        expect(hit?.properties?._name).toBe('Low Bridge');
        expect(
            polylineCrossesClearanceBar(
                [
                    [150.0, -30],
                    [150.0095, -30],
                ],
                bars,
            ),
        ).toBeNull();
    });

    // Round-3 review (2026-09-30): the exact gate could not see a structure
    // charted as a POINT (its line is degenerate: nothing "crosses" it), nor
    // a route vertex lying exactly on the structure's line (a strict test).
    // Off-grid splices rely on this gate alone.
    it('a bridge charted as a point: passing within the bar’s half-width is under it; 100 m off is not', () => {
        const point: Feature = {
            type: 'Feature',
            properties: { acronym: 'BRIDGE', VERCLR: 5, OBJNAM: 'Point Bridge' },
            geometry: { type: 'Point', coordinates: [150.01, -30] },
        };
        const pbars = chartClearanceBars({ BRIDGE: [point] }, 18);
        const at = (dyM: number): [number, number][] => [
            [150.0, -30 + dyM / 110_540],
            [150.02, -30 + dyM / 110_540],
        ];
        expect(polylineCrossesClearanceBar(at(10), pbars)?.properties?._name).toBe('Point Bridge');
        expect(polylineCrossesClearanceBar(at(0), pbars)?.properties?._name).toBe('Point Bridge');
        expect(polylineCrossesClearanceBar(at(100), pbars)).toBeNull();
    });

    it('a route vertex exactly on the deck line is under it (touching counts)', () => {
        const line = across({}).geometry as unknown as { coordinates: [number, number][] };
        const [p0, p1] = line.coordinates;
        const onDeck: [number, number] = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
        expect(polylineCrossesClearanceBar([[150.0, -30.001], onDeck], bars)).not.toBeNull();
        expect(polylineCrossesClearanceBar([onDeck, [150.02, -29.999]], bars)).not.toBeNull();
    });

    it('says what blocks, in plain words, for every reason', () => {
        expect(clearanceRefusalMessage(bars[0].properties)).toMatch(
            /No mast-safe route: the bridge "Low Bridge" has 16(\.0)? m clearance, less than your 18(\.0)? m air draft plus a 1 m margin/,
        );
        const unknown = chartClearanceBars({ BRIDGE: [across({})] }, 18)[0].properties;
        expect(clearanceRefusalMessage(unknown)).toMatch(/gives no clearance/);
        const unset = chartClearanceBars({ BRIDGE: [across({ VERCLR: 40 })] }, null)[0].properties;
        expect(clearanceRefusalMessage(unset)).toMatch(/air draft is not set/);
        expect(clearanceRefusalMessage(unset)).toMatch(/Vessel settings/);
        const opening = chartClearanceBars({ BRIDGE: [across({ CATBRG: 4, VERCCL: 5, VERCOP: 40 })] }, 18)[0]
            .properties;
        expect(clearanceRefusalMessage(opening)).toMatch(/opening bridge/);
        expect(clearanceRefusalMessage(opening)).toMatch(/cannot know when it opens/);
        const cable = chartClearanceBars({ CBLOHD: [across({ acronym: 'CBLOHD', VERCSA: 12 })] }, 18)[0].properties;
        expect(clearanceRefusalMessage(cable)).toMatch(/overhead cable/);
        // A bar from before this change (no reason carried) keeps the old wording.
        expect(clearanceRefusalMessage(null)).toMatch(/fixed bridge with less clearance than your air draft/);
    });
});

describe('the curated bridge file (bridges-au.json) goes through the same verdict', () => {
    const curated = (clearanceM: number | null, estimated = false) => ({
        id: 'au-test',
        name: 'Test Road bridge',
        clearanceM,
        estimated,
        span: [
            [150.0, -30.0],
            [150.0, -30.001],
        ] as [number, number][],
    });

    it('a null clearance blocks; before Part B it never gated', () => {
        expect(curatedClearanceBars([curated(null)], 18)).toHaveLength(1);
        expect(curatedClearanceBars([curated(null)], 18)[0].properties).toMatchObject({
            _source: 'curated',
            _block: 'clearance-unknown',
            _name: 'Test Road bridge',
            _bridgeId: 'au-test',
        });
    });

    it('an unset air draft blocks every curated bridge, even the Gateway at 54 m', () => {
        expect(curatedClearanceBars([curated(54)], null)).toHaveLength(1);
        expect(curatedClearanceBars([curated(54)], null)[0].properties._block).toBe('air-draft-unset');
    });

    it('the 1 m margin applies: 18.5 m blocks an 18 m mast, 19 m passes', () => {
        expect(curatedClearanceBars([curated(18.5)], 18)).toHaveLength(1);
        expect(curatedClearanceBars([curated(19)], 18)).toHaveLength(0);
        expect(curatedClearanceBars([curated(19)], 18)).toEqual([]);
    });

    it('an estimated clearance is unknown', () => {
        expect(curatedClearanceBars([curated(30, true)], 18)).toHaveLength(1);
    });

    it('curated bars keep the 15 m end pad the OSM ways need', () => {
        const bar = curatedClearanceBars([curated(null)], 18)[0].geometry as Polygon;
        // 10 m past the span's south end, on its line: inside the padded bar.
        expect(pointInGeometry(150.0, -30.001 - 10 / 110_540, bar)).toBe(true);
    });
});
