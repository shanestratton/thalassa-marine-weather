import { afterEach, describe, expect, it, vi } from 'vitest';

import { initIsobarLayers, showIsobarLayers, SYNOPTIC_ONLY_LAYER_IDS } from '../components/map/isobarLayerSetup';

/** Width of a line layer at the zoom-5 stop of its interpolate expression. */
function widthAtZoom5(paint: Record<string, unknown> | undefined): number {
    const expr = paint?.['line-width'] as unknown[];
    // ['interpolate', ['linear'], ['zoom'], 2, w2, 5, w5, 8, w8]
    const value = expr[6];
    return typeof value === 'number' ? value : NaN;
}

describe('isobar layer setup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const buildInitMap = () => {
        const layers: Array<Record<string, unknown>> = [];
        const map = {
            getSource: vi.fn(() => undefined),
            addSource: vi.fn(),
            getLayer: vi.fn(() => undefined),
            addLayer: vi.fn((layer: Record<string, unknown>) => layers.push(layer)),
            hasImage: vi.fn(() => false),
            addImage: vi.fn(),
        };
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,');
        return { layers, map };
    };

    it('gives major contours and sparse H/L centres visual priority', () => {
        const { layers, map } = buildInitMap();
        initIsobarLayers(map as never);

        const minor = layers.find((layer) => layer.id === 'isobar-lines');
        const major = layers.find((layer) => layer.id === 'isobar-major-lines');
        const labels = layers.find((layer) => layer.id === 'isobar-labels');
        const centers = layers.find((layer) => layer.id === 'isobar-center-labels');

        expect(minor?.filter).toEqual(['==', ['get', 'isMajor'], false]);
        expect(major?.filter).toEqual(['==', ['get', 'isMajor'], true]);
        expect(widthAtZoom5(major?.paint as Record<string, unknown>)).toBeGreaterThan(
            widthAtZoom5(minor?.paint as Record<string, unknown>),
        );
        // EVERY isobar carries its value now, not every second one — the
        // 4 hPa interval is the synoptic standard and labelling only the
        // multiples of 8 made the chart read as an 8 hPa chart (2026-08-21,
        // checked against BOM's live MSLP analysis). The major/minor WEIGHT
        // distinction above stays: heavier line every 8 hPa, value on all.
        expect(labels?.filter).toEqual(['has', 'label']);
        expect((centers?.layout as Record<string, boolean>)['text-allow-overlap']).toBe(true);
    });

    it('lays a dark blurred shadow beneath the whole contour stack and badges the centres', () => {
        const { layers, map } = buildInitMap();
        initIsobarLayers(map as never);

        const ids = layers.map((layer) => layer.id);
        // The shadow must be created FIRST so every contour renders above it.
        expect(ids.indexOf('isobar-shadow')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('isobar-shadow')).toBeLessThan(ids.indexOf('isobar-lines'));
        expect(ids.indexOf('isobar-shadow')).toBeLessThan(ids.indexOf('isobar-major-lines'));

        const shadow = layers.find((layer) => layer.id === 'isobar-shadow');
        expect((shadow?.paint as Record<string, number>)['line-blur']).toBeGreaterThan(0);

        // H/L centres carry the glass-badge icon, matched per centre type.
        const centers = layers.find((layer) => layer.id === 'isobar-center-labels');
        expect((centers?.layout as Record<string, unknown>)['icon-image']).toEqual([
            'match',
            ['get', 'type'],
            'H',
            'pressure-badge-h',
            'pressure-badge-l',
        ]);
    });

    it('hides the synoptic-only furniture and hands the basemap back in overlay mode', () => {
        const visibility = new Map<string, string>();
        const paintWrites = new Map<string, unknown>();
        const map = {
            getLayer: vi.fn((id: string) => ({ id })),
            setLayoutProperty: vi.fn((id: string, _prop: string, value: string) => visibility.set(id, value)),
            setPaintProperty: vi.fn((id: string, prop: string, value: unknown) =>
                paintWrites.set(`${id}:${prop}`, value),
            ),
            isStyleLoaded: vi.fn(() => true),
            getStyle: vi.fn(() => ({ layers: [{ id: 'place-city', type: 'symbol' }] })),
            getPaintProperty: vi.fn(() => '#123456'),
        };
        const savedLandColors = new Map<string, unknown>([['land', '#0b0b0b']]);

        showIsobarLayers(map as never, savedLandColors as never, true);

        // Contours and centres visible; heatmap/barbs/arrows/vignette stay hidden.
        expect(visibility.get('isobar-shadow')).toBe('visible');
        expect(visibility.get('isobar-lines')).toBe('visible');
        expect(visibility.get('isobar-major-lines')).toBe('visible');
        expect(visibility.get('isobar-center-labels')).toBe('visible');
        for (const id of SYNOPTIC_ONLY_LAYER_IDS) {
            expect(visibility.get(id)).toBe('none');
        }

        // The overlay never keeps the charcoal-land treatment: saved fills are
        // restored and basemap labels return to full opacity.
        expect(paintWrites.get('land:fill-color')).toBe('#0b0b0b');
        expect(paintWrites.get('place-city:text-opacity')).toBe(1.0);
    });

    it('keeps the full synoptic treatment when pressure stands alone', () => {
        const visibility = new Map<string, string>();
        const paintWrites = new Map<string, unknown>();
        const map = {
            getLayer: vi.fn((id: string) => ({ id })),
            setLayoutProperty: vi.fn((id: string, _prop: string, value: string) => visibility.set(id, value)),
            setPaintProperty: vi.fn((id: string, prop: string, value: unknown) =>
                paintWrites.set(`${id}:${prop}`, value),
            ),
            isStyleLoaded: vi.fn(() => true),
            getStyle: vi.fn(() => ({
                layers: [
                    { id: 'landcover', type: 'fill' },
                    { id: 'place-city', type: 'symbol' },
                ],
            })),
            getPaintProperty: vi.fn(() => '#123456'),
        };
        const savedLandColors = new Map<string, unknown>();

        showIsobarLayers(map as never, savedLandColors as never, false);

        expect(visibility.get('pressure-heatmap-layer')).toBe('visible');
        expect(visibility.get('wind-barb-layer')).toBe('visible');
        expect(paintWrites.get('landcover:fill-color')).toBe('rgba(20, 20, 20, 0.35)');
        expect(paintWrites.get('place-city:text-opacity')).toBe(0.3);
        expect(savedLandColors.get('landcover')).toBe('#123456');
    });
});
