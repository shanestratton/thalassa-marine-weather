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
    setEncPlottingMode,
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

/**
 * CLEAN OCEAN vs KEEL READ — the glaze is hidden while BROWSING over imagery
 * and handed straight back while PLOTTING. Two asks from the same day that
 * pull in opposite directions, so the pair is pinned together:
 *
 *   "I have lost my white areas in the water"        (planning page — needs it)
 *   "it should be a nice clean ocean"                (charts page — must not)
 *
 * Getting this backwards on either surface is a real bug: a washed-out
 * browsing chart, or a plotting surface with no depth to plot against.
 */
describe('glaze over imagery: clean while browsing, present while plotting', () => {
    beforeEach(() => localStorage.clear());

    /** satelliteBaseOn() reads this key; hybrid counts as imagery via imageryOn. */
    const imageryOn = () => localStorage.setItem('thalassa_satellite_base_v2', 'true');

    it('hides the glaze on the browsing chart — the clean ocean', () => {
        const { map, vis } = stubMap();
        imageryOn();
        applyEncVisibility(map);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE_GLAZE)).toBe('none');
    });

    it('keeps soundings and contours — only the white wash goes, not the numbers', () => {
        const { map, vis } = stubMap();
        imageryOn();
        applyEncVisibility(map);
        expect(vis.get(ENC_VEC_LAYERS.DEPCNT_SAFETY)).toBe('visible');
        expect(vis.get(ENC_VEC_LAYERS.WRECKS)).toBe('visible');
    });

    it('hands the glaze BACK the moment plotting starts', () => {
        const { map, vis } = stubMap();
        imageryOn();
        applyEncVisibility(map);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE_GLAZE)).toBe('none');
        setEncPlottingMode(map, true);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE_GLAZE)).toBe('visible');
    });

    it('goes clean again on exit from plotting', () => {
        const { map, vis } = stubMap();
        imageryOn();
        setEncPlottingMode(map, true);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE_GLAZE)).toBe('visible');
        setEncPlottingMode(map, false);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE_GLAZE)).toBe('none');
    });

    it('does NOT touch the glaze on the paper chart — this rule is imagery-only', () => {
        // With no imagery the glaze is already opacity-0 by
        // syncDepareBaseTreatment and DEPARE carries the bands, so the
        // visibility rule must not fire and confuse that arrangement.
        const { map, vis } = stubMap();
        applyEncVisibility(map);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE_GLAZE)).toBe('visible');
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('visible');
    });
});

/**
 * The PLOTTING KEEL FLOOR — previously untested, which is how it came to be
 * silently defeated (Shane 2026-07-22: "I have lost my white areas in the
 * water" on the planning page).
 *
 * The floor's whole promise is that while the tracer is up, no furniture
 * toggle may strip the depth you are plotting against. It outranks master.
 */
describe('plotting keel floor', () => {
    beforeEach(() => localStorage.clear());

    it('outranks the master toggle — depth survives a chart-off plot', () => {
        const { map, vis } = stubMap();
        setEncVectorVisibility(map, false); // "Clear All" turns the chart off
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('none');
        setEncPlottingMode(map, true);
        // On the paper chart the bands live on DEPARE; the floor forces it back.
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('visible');
        // ...along with the three that actually sink you.
        expect(vis.get(ENC_VEC_LAYERS.WRECKS)).toBe('visible');
        expect(vis.get(ENC_VEC_LAYERS.UWTROC)).toBe('visible');
        expect(vis.get(ENC_VEC_LAYERS.OBSTRN)).toBe('visible');
    });

    it('lowers again on exit, handing the chart back to the user toggles', () => {
        const { map, vis } = stubMap();
        setEncVectorVisibility(map, false);
        setEncPlottingMode(map, true);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('visible');
        setEncPlottingMode(map, false);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('none'); // master is honoured again
    });

    it('outranks clean-chart too', () => {
        const { map, vis } = stubMap();
        setEncChartDetail(map, false); // CHART_DETAIL_HIDE_LAYERS drops DEPARE
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('none');
        setEncPlottingMode(map, true);
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBe('visible');
    });

    it('CANNOT raise a layer that was never mounted — the actual regression', () => {
        // This is the shape of the bug, and the reason the floor failed while
        // every assertion above would still have passed. The composer skips
        // layers that do not exist (`if (!map.getLayer(id)) continue`), so
        // when the pipeline declined to MOUNT with the chart toggled off, the
        // floor became a silent no-op. Hiding pixels and never creating them
        // are not the same thing, and only the second breaks this promise.
        //
        // The fix is upstream in useEncVectorLayer (mount while plotting even
        // when !visible); this pins WHY that is required, so nobody
        // reintroduces the early return believing the floor still protects them.
        const vis = new Map<string, string>();
        const emptyMap = {
            getLayer: () => undefined, // nothing mounted
            setLayoutProperty: (id: string, _p: string, v: string) => void vis.set(id, v),
            setPaintProperty: () => {},
            setFilter: () => {},
            getLayoutProperty: () => 'visible',
        } as unknown as mapboxgl.Map;

        setEncPlottingMode(emptyMap, true);
        expect(vis.size).toBe(0); // no writes at all — the floor is powerless
        expect(vis.get(ENC_VEC_LAYERS.DEPARE)).toBeUndefined();
    });
});
