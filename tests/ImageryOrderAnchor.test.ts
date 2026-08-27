/**
 * Both cloud overlays must anchor against the SAME reference.
 *
 * Thalassa mounts two independent infrared cloud rasters: useSquallMap's NASA
 * GIBS layer, and the RealEarth layer useCycloneLayer mounts through
 * SatelliteImageryService. Until 2026-08-23 each guessed its own anchor, and
 * both guessed "the style's first symbol layer" — which is not a landmark
 * here. useMapInit adds the opaque satellite raster with `beforeId =
 * encBottom`, and an undefined encBottom APPENDS IT TO THE TOP. At the zoom
 * the storm view opens at, over open ocean, no `enc-vec-*` layer exists yet.
 * So the imagery could sit above the first symbol layer and the cloud went
 * under it: painting perfectly, visible to nobody — then fine on the next
 * open, once ENC had mounted and MapHub's ordering pass had demoted the
 * imagery. That is the intermittency Shane reported.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { IMAGERY_LAYER_IDS, cloudOverlayBeforeId, imageryTopIndex } from '../components/map/imageryOrder';

// Style-layer fixtures. 'place-*' / '*-label' are the style's symbol layers;
// everything else here is a raster or fill, which is what the fallback ladder
// distinguishes.
const L = (...ids: string[]) => ids.map((id) => ({ id, type: /label|^place-/.test(id) ? 'symbol' : 'raster' }));

describe('imageryTopIndex', () => {
    it('finds the HIGHEST imagery layer, not the first named one', () => {
        // Order in the style decides what covers what; the order of our own
        // id list must not.
        expect(imageryTopIndex(L('a', 'satellite-base-layer', 'b', 'hybrid-base-layer', 'c'))).toBe(3);
        expect(imageryTopIndex(L('a', 'hybrid-base-layer', 'b', 'satellite-base-layer', 'c'))).toBe(3);
    });

    it('is -1 when no imagery is lit yet', () => {
        expect(imageryTopIndex(L('background', 'water', 'place-city'))).toBe(-1);
    });

    it('covers every opaque base the map can show', () => {
        expect([...IMAGERY_LAYER_IDS]).toEqual(['satellite-base-layer', 'hybrid-base-layer', 'maptiler-ocean-layer']);
    });
});

describe('cloudOverlayBeforeId', () => {
    it('puts the cloud immediately above the imagery', () => {
        const layers = L('background', 'satellite-base-layer', 'enc-vec-depare', 'place-city');
        expect(cloudOverlayBeforeId(layers)).toBe('enc-vec-depare');
    });

    it('still lands above imagery that is the topmost layer', () => {
        // undefined => append to top, which is above the imagery. The failure
        // mode being fixed is landing BELOW it; the top is a correct answer.
        expect(cloudOverlayBeforeId(L('background', 'satellite-base-layer'))).toBeUndefined();
    });

    it('falls back to the ENC stack when no imagery is lit', () => {
        // Plain chart view: unchanged from the pre-fix behaviour, so this fix
        // cannot move the cloud on a chart that was already correct.
        const layers = L('background', 'water', 'enc-vec-depare', 'place-city');
        expect(cloudOverlayBeforeId(layers)).toBe('enc-vec-depare');
    });

    it('falls back to the first symbol layer when there is no ENC either', () => {
        expect(cloudOverlayBeforeId(L('background', 'water', 'place-city'))).toBe('place-city');
    });

    it('never returns a layer at or below the imagery', () => {
        // The one invariant that matters. An anchor at or below the opaque
        // base is what made the cloud invisible.
        const layers = L('background', 'water', 'satellite-base-layer', 'enc-vec-depare', 'place-city');
        const before = cloudOverlayBeforeId(layers);
        const ids = layers.map((l) => l.id);
        if (before !== undefined) {
            expect(ids.indexOf(before)).toBeGreaterThan(ids.indexOf('satellite-base-layer'));
        }
    });
});

describe('every overlay defers to it', () => {
    it('neither cloud layer re-derives an anchor of its own', () => {
        const squall = readFileSync('components/map/useSquallMap.ts', 'utf8');
        const cyclone = readFileSync('components/map/useCycloneLayer.ts', 'utf8');
        const service = readFileSync('services/weather/SatelliteImageryService.ts', 'utf8');

        expect(squall).toContain("from './imageryOrder'");
        expect(cyclone).toContain("from './imageryOrder'");
        expect(cyclone).toContain('cloudOverlayBeforeId(satLayers)');

        // The service takes the anchor as an argument — services/ must not
        // import components/, and a service guessing map order is what caused
        // this. Its own first-symbol lookup must be gone.
        expect(service).toContain('beforeId?: string');
        expect(service).not.toContain("layers?.find((l) => l.type === 'symbol')");
    });

    it('the squall PRECIP half carries no bare first-symbol anchor either', () => {
        // The cloud half was converted on 2026-08-23 with lightning; the
        // precip half kept its bare anchor and mounted below the opaque
        // satellite base on OBS — cells rendered, invisible, legend "Live"
        // (Shane 2026-08-27: "it is not working at all"). Squall pins the
        // camera to z3–8 where no ENC mounts, so MapHub's encBottom-gated
        // ordering self-heal can never rescue it: the anchor must be right
        // at mount, and the styledata re-assert must lift the cells too.
        const squall = readFileSync('components/map/useSquallMap.ts', 'utf8');
        expect(squall).not.toContain("find((l) => l.type === 'symbol')");
        expect(squall).toContain('const beforeId = squallBeforeId(styleLayers);');
        expect(squall).toContain('map.moveLayer(SQUALL_LAYER, squallBeforeId(layersNow));');
        // …and squallBeforeId sits one slot ABOVE the cloud: anchoring at the
        // cloud's own id would tuck the cells under its heaviest alpha,
        // which is exactly where active cells are.
        expect(squall).toContain('return layers[cloudIdx + 1]?.id;');
    });
});
