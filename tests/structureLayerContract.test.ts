/**
 * Part B (inshore router, 2026-09-30): one structure-layer contract across
 * the three packages that cannot import each other at runtime.
 *
 *   • the SENC extractor (tools/senc-extractor) — ALWAYS_EMITTED_CLASSES;
 *   • the Pi's ogr2ogr converter (pi-cache) — ENC_ALWAYS_EMITTED_LAYERS;
 *   • the app's lead review — LEAD_REQUIRED_STRUCTURE_LAYERS: a cell without
 *     one of these keys is "not extracted", and no lead over it is clear.
 *
 * If a pipeline stopped emitting a required layer, every lead would silently
 * go back to 'bridges not in chart data'; if the app required a layer no
 * pipeline emits, nothing could ever be clear. And both converters must
 * record the same schema, or a re-install could not replace an older
 * conversion of the same chart revision.
 */
import { describe, expect, it } from 'vitest';
import { LEAD_REQUIRED_STRUCTURE_LAYERS } from '../services/routing/leadReview';
import { CLEARANCE_STRUCTURE_LAYERS } from '../services/routing/overheadClearance';
import { ALWAYS_EMITTED_CLASSES, EXTRACTOR_SCHEMA, ROUTING_CLASSES } from '../tools/senc-extractor/src/s57Classes';
import { ENC_ALWAYS_EMITTED_LAYERS, ENC_CONVERSION_SCHEMA } from '../pi-cache/src/encLayerContract';
import { LOCAL_ENC_PACK_LAYER_NAMES, validateLocalEncPack } from '../services/enc/localEncPackImport';

describe('the structure-layer contract', () => {
    it('both pipelines always emit exactly the layers the lead review requires', () => {
        const required = [...LEAD_REQUIRED_STRUCTURE_LAYERS].sort();
        expect([...ALWAYS_EMITTED_CLASSES].sort()).toEqual(required);
        expect([...ENC_ALWAYS_EMITTED_LAYERS].sort()).toEqual(required);
    });

    // Round 2 (2026-09-30): the overhead conveyor joined before anything
    // deployed, so the schema stays 2.
    it('CONVYR (overhead conveyor) is in the contract everywhere; the schema stays 2', () => {
        expect(ALWAYS_EMITTED_CLASSES.has('CONVYR')).toBe(true);
        expect(ENC_ALWAYS_EMITTED_LAYERS as readonly string[]).toContain('CONVYR');
        expect(LEAD_REQUIRED_STRUCTURE_LAYERS as readonly string[]).toContain('CONVYR');
        expect(CLEARANCE_STRUCTURE_LAYERS).toContain('CONVYR');
        expect(LOCAL_ENC_PACK_LAYER_NAMES.has('CONVYR')).toBe(true);
        expect(EXTRACTOR_SCHEMA).toBe(2);
    });

    it('every layer the router reads for clearance is extracted', () => {
        for (const layer of CLEARANCE_STRUCTURE_LAYERS) {
            expect(ROUTING_CLASSES.has(layer), layer).toBe(true);
            expect(ENC_ALWAYS_EMITTED_LAYERS as readonly string[]).toContain(layer);
        }
    });

    it('the two converters record the same output schema', () => {
        expect(ENC_CONVERSION_SCHEMA).toBe(EXTRACTOR_SCHEMA);
    });
});

/**
 * The PHONE is the third end of the contract (Phase 2a review, 2026-09-30).
 * Its import allowlist fails closed: one layer it does not know rejects the
 * whole cell ("unsupported chart layer; nothing was imported"). Once either
 * pipeline re-extracts at schema 2, every cell carries the four structure
 * layers — so a phone without them in its allowlist would reject every new
 * and updated chart (Notices to Mariners included), from the Pi, the cloud
 * and the personal library alike. NAVLNE missing from this list once blocked
 * 153 of Shane's cells.
 */
describe('the phone accepts what the pipelines emit', () => {
    it('every always-emitted layer, from both pipelines, is in the phone import allowlist', () => {
        const missing = [...ALWAYS_EMITTED_CLASSES, ...ENC_ALWAYS_EMITTED_LAYERS].filter(
            (layer) => !LOCAL_ENC_PACK_LAYER_NAMES.has(layer),
        );
        expect(missing).toEqual([]);
    });

    it('every class the SENC extractor emits is in the phone import allowlist', () => {
        expect([...ROUTING_CLASSES].filter((layer) => !LOCAL_ENC_PACK_LAYER_NAMES.has(layer))).toEqual([]);
    });

    const depare: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { DRVAL1: 5, DRVAL2: 10, acronym: 'DEPARE', rcid: 1 },
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [153.1, -27.3],
                            [153.2, -27.3],
                            [153.2, -27.2],
                            [153.1, -27.2],
                            [153.1, -27.3],
                        ],
                    ],
                },
            },
        ],
    };
    const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });
    const schema2Cell = (layers: Record<string, GeoJSON.FeatureCollection>) => ({
        cellId: 'AU5TEST1',
        sourceHO: 'AU',
        edition: 3,
        updateNumber: 1,
        issued: '2026-09-20',
        bbox: [153.05, -27.35, 153.25, -27.15] as [number, number, number, number],
        extractorSchema: EXTRACTOR_SCHEMA,
        layers: { DEPARE: depare, ...layers },
    });

    it('a schema-2 cell that charts none of the five (empty collections) validates', () => {
        const cell = schema2Cell({
            BRIDGE: empty(),
            PONTON: empty(),
            CBLOHD: empty(),
            PIPOHD: empty(),
            CONVYR: empty(),
        });
        const out = validateLocalEncPack(cell).cells[0];
        // "Extracted, none charted" survives validation — the lead review
        // reads a missing key as "not extracted".
        for (const layer of ALWAYS_EMITTED_CLASSES) {
            expect((out.layers as Record<string, unknown>)[layer], layer).toEqual(empty());
        }
    });

    it('a schema-2 cell with a charted bridge, pontoon, overhead cable, pipe and conveyor validates', () => {
        const line = (acronym: string, props: Record<string, unknown>): GeoJSON.Feature => ({
            type: 'Feature',
            properties: { acronym, rcid: 9, ...props },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [153.12, -27.25],
                    [153.13, -27.25],
                ],
            },
        });
        const pontoon: GeoJSON.Feature = {
            type: 'Feature',
            properties: { acronym: 'PONTON', rcid: 10 },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [153.14, -27.26],
                        [153.141, -27.26],
                        [153.141, -27.259],
                        [153.14, -27.26],
                    ],
                ],
            },
        };
        const cell = schema2Cell({
            BRIDGE: { type: 'FeatureCollection', features: [line('BRIDGE', { VERCLR: 16.2, CATBRG: '2' })] },
            PONTON: { type: 'FeatureCollection', features: [pontoon] },
            CBLOHD: { type: 'FeatureCollection', features: [line('CBLOHD', { VERCSA: 12, VERCLR: 15 })] },
            PIPOHD: { type: 'FeatureCollection', features: [line('PIPOHD', { VERCLR: 20 })] },
            CONVYR: { type: 'FeatureCollection', features: [line('CONVYR', { VERCLR: 14, VERCSA: 13 })] },
        });
        const out = validateLocalEncPack({ cells: [cell], skipped: [] }).cells[0];
        expect(out.layers.BRIDGE?.features[0].properties?.VERCLR).toBe(16.2);
        expect(out.layers.PONTON?.features).toHaveLength(1);
        expect(out.layers.CBLOHD?.features[0].properties?.VERCSA).toBe(12);
        expect(out.layers.PIPOHD?.features[0].properties?.VERCLR).toBe(20);
        expect(out.layers.CONVYR?.features[0].properties?.VERCSA).toBe(13);
    });

    it('the compilation scale a blob carries survives validation (the router ranks cells by it)', () => {
        const out = validateLocalEncPack({ ...schema2Cell({}), nativeScale: 22_000 }).cells[0];
        expect(out.nativeScale).toBe(22_000);
        expect(() => validateLocalEncPack({ ...schema2Cell({}), nativeScale: 'x' })).toThrow(/nativeScale/);
        expect(() => validateLocalEncPack({ ...schema2Cell({}), nativeScale: 2e9 })).toThrow(/nativeScale/);
    });

    it('a zero or negative compilation scale is ABSENT (unknown rank), never a reason to drop the pack', () => {
        // Phase 2a round-2 review (2026-09-30): the SENC header's readUInt32
        // can be 0, and refusing threw the whole pack away — fine cells went,
        // and the router fell back to coarser, deeper bands.
        for (const nativeScale of [0, -1]) {
            const out = validateLocalEncPack({ ...schema2Cell({}), nativeScale }).cells[0];
            expect(out).toBeDefined();
            expect('nativeScale' in out).toBe(false);
        }
    });
});
