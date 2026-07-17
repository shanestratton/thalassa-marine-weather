/**
 * Pure click/popup logic extracted from EncVectorLayer (burn-down
 * 2026-07-16: "EncVectorLayer logic tests — fillDepareTideWindow, click
 * routing"). These functions ARE the wiring the map handler runs; the
 * handler itself only maps queryRenderedFeatures hits into them.
 */
import { describe, expect, it } from 'vitest';

import { ENC_VEC_LAYERS } from '../../components/map/encLayerIds';
import { needsTideWindow, pickAreaTap, type AreaTapHit } from '../../components/map/encPopup';

const hit = (layerId: string, properties: Record<string, unknown> = {}): AreaTapHit => ({ layerId, properties });

describe('pickAreaTap — area-tap precedence', () => {
    it('returns null for no hits (tap on nothing answers nothing)', () => {
        expect(pickAreaTap([])).toBeNull();
    });

    it('topmost hit answers by default', () => {
        const pick = pickAreaTap([hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 2 }), hit(ENC_VEC_LAYERS.LNDARE)]);
        expect(pick).toEqual({ index: 0, cautionsUnder: [] });
    });

    it('caution wash over charted water: the WATER answers, caution rides along', () => {
        const caution = { _caution: 1, cls: 'RESARE', RESTRN: '7' };
        const pick = pickAreaTap([
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, caution),
            hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 5 }),
        ]);
        expect(pick?.index).toBe(1);
        expect(pick?.cautionsUnder).toEqual([caution]);
    });

    it('STACKED caution washes ALL fold in (closing audit: only the first rode along)', () => {
        const resare = { _caution: 'RESARE', RESTRN: '7' };
        const cblare = { _caution: 'CBLARE' };
        const pick = pickAreaTap([
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, resare),
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, cblare),
            hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 5 }),
        ]);
        expect(pick?.index).toBe(2);
        expect(pick?.cautionsUnder).toEqual([resare, cblare]);
    });

    it('caution wash with water deeper in the stack still finds it', () => {
        const pick = pickAreaTap([
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, { cls: 'ACHARE' }),
            hit(ENC_VEC_LAYERS.LNDARE),
            hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 3 }),
        ]);
        expect(pick?.index).toBe(2);
        expect(pick?.cautionsUnder).toEqual([{ cls: 'ACHARE' }]);
    });

    it('caution wash with NO water beneath answers as the caution itself', () => {
        const pick = pickAreaTap([hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, { cls: 'CTNARE' })]);
        expect(pick).toEqual({ index: 0, cautionsUnder: [] });
    });

    it('water on TOP of a caution needs no fold — topmost already answers', () => {
        // The fold-in only rescues a caution-first stack; water-first keeps
        // the plain path (the caution is invisible to the popup, by design —
        // it did not intercept the tap).
        const pick = pickAreaTap([
            hit(ENC_VEC_LAYERS.DEPARE, { DRVAL1: 8 }),
            hit(ENC_VEC_LAYERS.CAUTION_AREA_FILL, { cls: 'RESARE' }),
        ]);
        expect(pick).toEqual({ index: 0, cautionsUnder: [] });
    });
});

describe('needsTideWindow — DEPARE tide-window fetch gate', () => {
    it('fires for a keel-limited band with no live tide', () => {
        expect(needsTideWindow(1.5, 2.5, null)).toBe(true);
        expect(needsTideWindow(1.5, 2.5, undefined)).toBe(true);
    });

    it('drying bank (negative DRVAL1) below safety depth fires', () => {
        expect(needsTideWindow(-0.5, 2.5, null)).toBe(true);
    });

    it('band at or above safety depth never fires', () => {
        expect(needsTideWindow(2.5, 2.5, null)).toBe(false);
        expect(needsTideWindow(10, 2.5, null)).toBe(false);
    });

    it('live tide already clearing the keel suppresses the fetch', () => {
        // 1.5 m band + 1.2 m tide = 2.7 ≥ 2.5 safety — floating right now.
        expect(needsTideWindow(1.5, 2.5, 1.2)).toBe(false);
        // Boundary: exactly clearing counts as clear.
        expect(needsTideWindow(1.5, 2.5, 1.0)).toBe(false);
    });

    it('live tide NOT clearing the keel still fires', () => {
        expect(needsTideWindow(1.5, 2.5, 0.5)).toBe(true);
        // Negative tide (below datum) can never rescue a shallow band.
        expect(needsTideWindow(1.5, 2.5, -0.3)).toBe(true);
    });

    it('unknown or missing DRVAL1 never fires', () => {
        expect(needsTideWindow(undefined, 2.5, null)).toBe(false);
        expect(needsTideWindow('not-a-depth', 2.5, null)).toBe(false);
        expect(needsTideWindow(NaN, 2.5, null)).toBe(false);
    });

    it('no safety depth (no vessel context) never fires', () => {
        expect(needsTideWindow(1.5, null, null)).toBe(false);
        expect(needsTideWindow(1.5, undefined, null)).toBe(false);
        expect(needsTideWindow(1.5, 0, null)).toBe(false);
        expect(needsTideWindow(1.5, -1, null)).toBe(false);
    });

    it('numeric-string DRVAL1 (vector-tile property) coerces', () => {
        expect(needsTideWindow('1.5', 2.5, null)).toBe(true);
    });
});
