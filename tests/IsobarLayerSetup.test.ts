import { afterEach, describe, expect, it, vi } from 'vitest';

import { initIsobarLayers } from '../components/map/isobarLayerSetup';

describe('isobar layer setup', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('gives major contours and sparse H/L centres visual priority', () => {
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

        initIsobarLayers(map as never);

        const minor = layers.find((layer) => layer.id === 'isobar-lines');
        const major = layers.find((layer) => layer.id === 'isobar-major-lines');
        const labels = layers.find((layer) => layer.id === 'isobar-labels');
        const centers = layers.find((layer) => layer.id === 'isobar-center-labels');

        expect(minor?.filter).toEqual(['==', ['get', 'isMajor'], false]);
        expect(major?.filter).toEqual(['==', ['get', 'isMajor'], true]);
        expect((major?.paint as Record<string, number>)['line-width']).toBeGreaterThan(
            (minor?.paint as Record<string, number>)['line-width'],
        );
        expect(labels?.filter).toEqual(['==', ['get', 'isMajor'], true]);
        expect((centers?.layout as Record<string, boolean>)['text-allow-overlap']).toBe(true);
    });
});
