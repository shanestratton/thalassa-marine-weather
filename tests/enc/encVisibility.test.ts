/**
 * Visibility state machine (closing audit): five writers used to compose
 * via a BCNLAT probe + last-writer-wins. These tests drive the ONE
 * composer through a stub map and pin the documented precedence.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/enc/EncCellMetadata', () => ({
    listCells: vi.fn(() => []),
    getCell: vi.fn(),
    getVersion: vi.fn(() => 1),
    subscribe: vi.fn(() => () => {}),
}));
vi.mock('../../services/enc/EncCellStore', () => ({
    loadCellGeoJSON: vi.fn(async () => null),
    readCellRaw: vi.fn(async () => ({ kind: 'missing', notFound: true })),
    parseAndCacheCellText: vi.fn(() => null),
    parseAndCacheCellTextAsync: vi.fn(async () => null),
}));

import {
    applyEncVisibility,
    setEncChartDetail,
    setEncRouteFocusMode,
    setEncVectorVisibility,
} from '../../components/map/EncVectorLayer';
import { ENC_VEC_LAYERS } from '../../components/map/encLayerIds';
import type mapboxgl from 'mapbox-gl';

/** Stub map: every layer exists; records the last visibility per layer. */
function stubMap(): { map: mapboxgl.Map; vis: Map<string, string> } {
    const vis = new Map<string, string>();
    const map = {
        getLayer: () => ({}),
        setLayoutProperty: (id: string, _p: string, v: string) => void vis.set(id, v),
        setPaintProperty: () => {},
        setFilter: () => {},
        getLayoutProperty: () => 'visible',
    } as unknown as mapboxgl.Map;
    return { map, vis };
}

describe('ENC visibility state machine', () => {
    beforeEach(() => localStorage.clear());

    it('master OFF hides everything; master ON restores', () => {
        const { map, vis } = stubMap();
        setEncVectorVisibility(map, false);
        expect(vis.get(ENC_VEC_LAYERS.BCNLAT)).toBe('none');
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('none');
        setEncVectorVisibility(map, true);
        expect(vis.get(ENC_VEC_LAYERS.BCNLAT)).toBe('visible');
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('visible');
    });

    it('route-focus hides the bulk fills but keeps the marks', () => {
        const { map, vis } = stubMap();
        setEncRouteFocusMode(map, true);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('none');
        expect(vis.get(ENC_VEC_LAYERS.LNDARE)).toBe('none');
        expect(vis.get(ENC_VEC_LAYERS.BCNLAT)).toBe('visible'); // marks survive
        expect(vis.get(ENC_VEC_LAYERS.WRECKS)).toBe('visible'); // hazards survive
    });

    it('ORDER-INDEPENDENT: master toggle no longer stomps an active focus mode', () => {
        const { map, vis } = stubMap();
        setEncRouteFocusMode(map, true);
        setEncVectorVisibility(map, false);
        setEncVectorVisibility(map, true); // the old writer force-showed EVERYTHING here
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('none'); // focus survives the round trip
        expect(vis.get(ENC_VEC_LAYERS.BCNLAT)).toBe('visible');
    });

    it('clean-chart and route-focus compose (union of hides), and unwind independently', () => {
        const { map, vis } = stubMap();
        setEncChartDetail(map, false); // clean chart
        setEncRouteFocusMode(map, true);
        expect(vis.get(ENC_VEC_LAYERS.DEPCNT_LINE)).toBe('none'); // clean's cut
        expect(vis.get(ENC_VEC_LAYERS.COALNE)).toBe('none'); // focus's cut
        setEncRouteFocusMode(map, false);
        expect(vis.get(ENC_VEC_LAYERS.COALNE)).toBe('visible'); // focus unwound
        expect(vis.get(ENC_VEC_LAYERS.DEPCNT_LINE)).toBe('none'); // clean still holds
    });

    it('applyEncVisibility is idempotent for a fresh map (defaults visible)', () => {
        const { map, vis } = stubMap();
        applyEncVisibility(map);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('visible');
    });
});
