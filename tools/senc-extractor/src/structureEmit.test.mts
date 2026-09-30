import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SencFeature } from './featureParser.js';
import { emitCell } from './geojsonEmitter.js';
import { ALWAYS_EMITTED_CLASSES, EXTRACTOR_SCHEMA, ROUTING_CLASSES } from './s57Classes.js';

/**
 * Part B (inshore router, 2026-09-30): bridges and overhead clearance.
 *
 * The app's lead review (services/routing/leadReview.ts,
 * LEAD_REQUIRED_STRUCTURE_LAYERS) can only say "nothing on this lead" when a
 * cell's data CARRIES the structure layers: an empty collection means
 * "extracted, none charted"; a missing key means "not extracted", and then no
 * lead is ever clear. The router blocks a bridge or overhead line whose
 * clearance a mast cannot make, so the extractor has to emit them — VERCLR,
 * VERCCL, VERCOP, VERCSA and CATBRG ride along as ordinary attributes.
 */

const header = { sencVersion: 201, cellEdition: 2, update: 1, publishDate: '20260920' };
const line = (acronym: string, attributes: SencFeature['attributes'], rcid = 1): SencFeature => ({
    classCode: 11,
    acronym,
    rcid,
    primitive: 2,
    attributes,
    geometry: {
        type: 'Line',
        coordinates: [
            [153.1, -27.2],
            [153.1, -27.21],
        ],
    } as SencFeature['geometry'],
});

describe('structure layers (BRIDGE, PONTON, CBLOHD, PIPOHD, CONVYR)', () => {
    it('are routing classes, and the always-emitted set is exactly the five the lead review requires', () => {
        // CONVYR (overhead conveyor) joined in round 2 (2026-09-30), before
        // anything deployed: the schema stays 2.
        assert.deepEqual([...ALWAYS_EMITTED_CLASSES].sort(), ['BRIDGE', 'CBLOHD', 'CONVYR', 'PIPOHD', 'PONTON']);
        assert.equal(EXTRACTOR_SCHEMA, 2);
        for (const c of ALWAYS_EMITTED_CLASSES) assert.ok(ROUTING_CLASSES.has(c), c);
    });

    it('a cell that charts none of them still carries all five, empty: extracted, none charted', () => {
        const cell = emitCell(header, [], { cellId: 'AU530150', sourceHO: 'AU' });
        for (const c of ALWAYS_EMITTED_CLASSES) {
            assert.deepEqual(cell.layers[c], { type: 'FeatureCollection', features: [] }, c);
        }
    });

    it('a charted bridge and overhead cable are emitted with their clearance attributes', () => {
        const cell = emitCell(
            header,
            [
                line('BRIDGE', { VERCLR: 16.2, CATBRG: '2', VERCCL: 5, VERCOP: 30, OBJNAM: 'Test Bridge' }, 7),
                line('CBLOHD', { VERCSA: 12, VERCLR: 15 }, 8),
            ],
            { cellId: 'AU530150', sourceHO: 'AU' },
        );
        assert.equal(cell.layers.BRIDGE.features.length, 1);
        assert.deepEqual(
            {
                VERCLR: cell.layers.BRIDGE.features[0].properties.VERCLR,
                CATBRG: cell.layers.BRIDGE.features[0].properties.CATBRG,
                VERCCL: cell.layers.BRIDGE.features[0].properties.VERCCL,
                VERCOP: cell.layers.BRIDGE.features[0].properties.VERCOP,
                acronym: cell.layers.BRIDGE.features[0].properties.acronym,
            },
            { VERCLR: 16.2, CATBRG: '2', VERCCL: 5, VERCOP: 30, acronym: 'BRIDGE' },
        );
        assert.equal(cell.layers.CBLOHD.features[0].properties.VERCSA, 12);
        assert.deepEqual(cell.layers.PONTON.features, []);
        assert.deepEqual(cell.layers.PIPOHD.features, []);
        assert.deepEqual(cell.layers.CONVYR.features, []);
    });

    it('a charted overhead conveyor is emitted with its clearance; one only partly built is UNKNOWN', () => {
        const cell = emitCell(header, [line('CONVYR', { VERCLR: 14, VERCSA: 13, OBJNAM: 'Coal loader' }, 9)], {
            cellId: 'AU530150',
            sourceHO: 'AU',
        });
        assert.equal(cell.layers.CONVYR.features.length, 1);
        assert.equal(cell.layers.CONVYR.features[0].properties.VERCLR, 14);
        assert.equal(cell.layers.CONVYR.features[0].properties.VERCSA, 13);
        const broken: SencFeature = { ...line('CONVYR', { VERCLR: 3 }, 10), geometry: null };
        const partial = emitCell(header, [line('CONVYR', { VERCLR: 14 }, 9), broken], {
            cellId: 'AU530150',
            sourceHO: 'AU',
        });
        assert.equal(partial.layers.CONVYR, undefined);
    });

    it('a structure the chart has but whose geometry could not be built leaves its layer UNKNOWN, never empty', () => {
        const broken: SencFeature = { ...line('BRIDGE', { VERCLR: 3 }), geometry: null };
        const cell = emitCell(header, [broken], { cellId: 'AU530150', sourceHO: 'AU' });
        assert.equal(cell.layers.BRIDGE, undefined);
        assert.deepEqual(cell.layers.CBLOHD.features, []);
    });

    // Phase 2a review (2026-09-30): a cell charting three bridges, one of
    // which failed to build, emitted a BRIDGE layer of two — read downstream
    // as "extracted, complete". The router drew no bar for the missing bridge
    // and the lead review trusted the layer.
    it('a structure class only PARTLY built is UNKNOWN (absent), never a short "complete" list', () => {
        const broken: SencFeature = { ...line('BRIDGE', { VERCLR: 3 }, 3), geometry: null };
        const cell = emitCell(
            header,
            [line('BRIDGE', { VERCLR: 30 }, 1), line('BRIDGE', { VERCLR: 31 }, 2), broken, line('CBLOHD', {}, 4)],
            { cellId: 'AU530150', sourceHO: 'AU' },
        );
        assert.equal(cell.layers.BRIDGE, undefined);
        // A class wholly built is unaffected.
        assert.equal(cell.layers.CBLOHD.features.length, 1);
        assert.deepEqual(cell.layers.PONTON.features, []);
    });

    it('a caller asking for other classes gets no structure layers stamped; "all" gets them', () => {
        const only = emitCell(header, [], { cellId: 'AU530150', sourceHO: 'AU', classes: new Set(['DEPARE']) });
        for (const c of ALWAYS_EMITTED_CLASSES) assert.equal(only.layers[c], undefined, c);
        const all = emitCell(header, [], { cellId: 'AU530150', sourceHO: 'AU', classes: 'all' });
        for (const c of ALWAYS_EMITTED_CLASSES) assert.deepEqual(all.layers[c]?.features, [], c);
    });

    it('every cell records the extractor schema that produced it', () => {
        assert.ok(Number.isSafeInteger(EXTRACTOR_SCHEMA) && EXTRACTOR_SCHEMA >= 2);
        assert.equal(emitCell(header, [], { cellId: 'AU530150', sourceHO: 'AU' }).extractorSchema, EXTRACTOR_SCHEMA);
    });
});
