import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAisLayer } from '../components/map/useAisLayer';
import { writeAisMapData } from '../components/map/aisPictureLayers';

const mocks = vi.hoisted(() => ({
    subscribe: vi.fn(() => vi.fn()),
}));

vi.mock('../services/AisStore', () => ({
    AisStore: { subscribe: mocks.subscribe },
}));

function makeMap() {
    const sourceIds = [
        'ais-targets',
        'ais-predicted-tracks',
        'ais-guard-zone',
        'ais-dr-estimates',
        'ais-target-trail',
    ] as const;
    const sources = Object.fromEntries(sourceIds.map((id) => [id, { setData: vi.fn() }])) as Record<
        (typeof sourceIds)[number],
        { setData: ReturnType<typeof vi.fn> }
    >;
    const map = {
        getLayer: vi.fn(() => ({})),
        setLayoutProperty: vi.fn(),
        getSource: vi.fn((id: (typeof sourceIds)[number]) => sources[id]),
    };
    return { map, sources };
}

describe('useAisLayer visibility lifecycle', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('hides every AIS layer and clears stale target, track, and guard data when disabled', () => {
        const { map, sources } = makeMap();
        const mapRef = { current: map as never };
        const { rerender } = renderHook(({ visible }) => useAisLayer(mapRef, true, visible), {
            initialProps: { visible: true },
        });
        // Populate each actual source, including the lazy DR and selected-trail sources.
        for (const id of Object.keys(sources)) {
            writeAisMapData(map as never, id, {
                type: 'FeatureCollection',
                features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [153, -27] } }],
            });
            sources[id as keyof typeof sources].setData.mockClear();
        }
        map.setLayoutProperty.mockClear();

        rerender({ visible: false });

        expect(map.setLayoutProperty.mock.calls).toEqual([
            ['ais-targets-glow', 'visibility', 'none'],
            ['ais-targets-circle', 'visibility', 'none'],
            // A distress beacon's own upright layer (127-11a): the AIS switch hides it too.
            ['ais-targets-sart', 'visibility', 'none'],
            ['ais-targets-heading', 'visibility', 'none'],
            ['ais-targets-label', 'visibility', 'none'],
            ['ais-stale-badge', 'visibility', 'none'],
            ['ais-dr-ring', 'visibility', 'none'],
            ['ais-dr-link', 'visibility', 'none'],
            ['ais-dr-ghost', 'visibility', 'none'],
            ['ais-target-trail', 'visibility', 'none'],
            ['ais-predicted-tracks-line', 'visibility', 'none'],
            ['ais-predicted-tracks-dots', 'visibility', 'none'],
            ['ais-guard-zone-fill', 'visibility', 'none'],
            ['ais-guard-zone-stroke', 'visibility', 'none'],
        ]);
        for (const source of Object.values(sources)) {
            expect(source.setData).toHaveBeenCalledOnce();
            expect(source.setData).toHaveBeenCalledWith({
                type: 'FeatureCollection',
                features: [],
            });
        }
    });
});
