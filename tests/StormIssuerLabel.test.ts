/**
 * The issuer's label at the forecast track's end (129-13): "NHC official
 * forecast" was drawn with text-allow-overlap and printed over the chosen
 * place's name at zoom 2 (Shane, 14 Oct). It now takes the first free of
 * eight spots, and the spots clear of the HTML markers there (the place pin
 * and its name, the storm's badge), which Mapbox cannot see, come first.
 * components/map/issuerLabelPlacement.ts, placeIssuerLabel in useCycloneLayer.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
    ISSUER_ANCHORS,
    issuerAnchorOrder,
    issuerLabelBox,
    issuerLabelRect,
    type Box,
} from '../components/map/issuerLabelPlacement';
import { placeIssuerLabel } from '../components/map/useCycloneLayer';

const END = { x: 200, y: 300 };
const SIZE = issuerLabelBox('NHC official forecast\n13 Oct 21:00 UTC');
const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe('the issuer label’s spots', () => {
    it('is sized as Mapbox lays it out: two lines of 10 px type, 14 em at most', () => {
        expect(SIZE.width).toBeCloseTo(21 * 6, 0);
        expect(SIZE.height).toBeCloseTo(26, 0);
        expect(issuerLabelBox('x'.repeat(80)).width).toBe(140);
    });

    it('keeps the usual order with nothing near', () => {
        expect(issuerAnchorOrder(END, SIZE, [])).toEqual([...ISSUER_ANCHORS]);
        expect(ISSUER_ANCHORS[0]).toBe('left');
    });

    it('goes left of the end when the place pin’s name sits to its right', () => {
        // The chosen place's chip ("那覇", Naha), right of a West Pacific track's end.
        const pin: Box = { left: 230, top: 288, right: 300, bottom: 312 };
        const order = issuerAnchorOrder(END, SIZE, [pin]);
        expect(order[0]).toBe('right');
        expect(overlaps(issuerLabelRect(order[0], END, SIZE), pin)).toBe(false);
        // The blocked spots are kept, last, for Mapbox to fall back on.
        expect(order).toHaveLength(8);
        expect(order.slice(-1)).not.toContain('right');
    });

    it('goes under the end when both sides and above it are taken', () => {
        // A storm's badge to the left, a place's name to the right, both reaching above the end.
        const left: Box = { left: 40, top: 250, right: 195, bottom: 302 };
        const right: Box = { left: 205, top: 250, right: 380, bottom: 302 };
        const order = issuerAnchorOrder(END, SIZE, [left, right]);
        // Mapbox's 'top' anchor: the label's top at the point, the words below it.
        expect(order[0]).toBe('top');
        for (const box of [left, right]) expect(overlaps(issuerLabelRect(order[0], END, SIZE), box)).toBe(false);
        for (const side of ['left', 'right', 'bottom'] as const) expect(order.indexOf(side)).toBeGreaterThan(0);
    });
});

describe('placeIssuerLabel on the chart', () => {
    it('is a no-op on a map with no issuer label drawn', () => {
        const setLayoutProperty = vi.fn();
        placeIssuerLabel({ getLayer: () => undefined, setLayoutProperty } as unknown as mapboxgl.Map);
        expect(setLayoutProperty).not.toHaveBeenCalled();
    });
});
