import { describe, expect, it } from 'vitest';
import { encNavaidIconId, TOPMARK_SHAPES, S57_BUOY_BEACON_CLASSES } from '../../services/enc/types';
import { getSeamarkIconDefs } from '../../components/map/seamarkIcons';
import { ENC_VEC_LAYERS, ALL_LAYER_IDS } from '../../components/map/encLayerIds';
import { S52_STANDARD_NAVAID_LAYERS } from '../../components/map/encDetailScrubber';

describe('schema3 navaids', () => {
    const classes = ['LITFLT', 'LITVES', 'BOYINB', 'MORFAC', 'FOGSIG', 'TOPMAR', 'DAYMAR'] as const;
    it('every new class has a registered icon, render order and S52 Standard protection', () => {
        const icons = new Set(getSeamarkIconDefs().map((d) => d.id));
        for (const kind of classes) {
            expect(S57_BUOY_BEACON_CLASSES).toContain(kind);
            expect(icons.has(encNavaidIconId(kind, {}, 'A'))).toBe(true);
            expect(ALL_LAYER_IDS).toContain(ENC_VEC_LAYERS[kind]);
            expect(S52_STANDARD_NAVAID_LAYERS).toContain(ENC_VEC_LAYERS[kind]);
        }
        expect(ALL_LAYER_IDS).toContain(ENC_VEC_LAYERS.MORFAC_GEOMETRY);
        expect(S52_STANDARD_NAVAID_LAYERS).toContain(ENC_VEC_LAYERS.MORFAC_GEOMETRY);
    });
    it('only a charted CATMOR7 becomes a mooring buoy', () => {
        expect(encNavaidIconId('MORFAC', { catmor: 7 }, 'A')).toBe('sm-mooring-buoy');
        for (const value of [undefined, 0, 1, 2, 3, 4, 5, 6, 8])
            expect(encNavaidIconId('MORFAC', { CATMOR: value }, 'A')).toBe('sm-mooring-facility');
    });
    it('renders known topmark shapes and refuses to invent a shape or safe side', () => {
        const icons = new Set(getSeamarkIconDefs().map((d) => d.id));
        for (const kind of ['TOPMAR', 'DAYMAR'] as const) {
            for (const shape of TOPMARK_SHAPES)
                expect(icons.has(encNavaidIconId(kind, { TOPSHP: shape }, 'A'))).toBe(true);
            for (const shape of [undefined, 0, 9, 33, 999, 'bad'])
                expect(encNavaidIconId(kind, { TOPSHP: shape }, 'B')).toBe('sm-mark-unknown');
        }
    });
});
