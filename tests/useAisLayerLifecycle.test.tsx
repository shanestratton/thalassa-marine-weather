import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAisLayer } from '../components/map/useAisLayer';

const mocks = vi.hoisted(() => ({
    subscribe: vi.fn(() => vi.fn()),
}));

vi.mock('../services/AisStore', () => ({
    AisStore: { subscribe: mocks.subscribe },
}));

function makeMap() {
    const sourceIds = ['ais-targets', 'ais-predicted-tracks', 'ais-guard-zone'] as const;
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
        map.setLayoutProperty.mockClear();

        rerender({ visible: false });

        expect(map.setLayoutProperty.mock.calls).toEqual([
            ['ais-targets-glow', 'visibility', 'none'],
            ['ais-targets-circle', 'visibility', 'none'],
            ['ais-targets-heading', 'visibility', 'none'],
            ['ais-targets-label', 'visibility', 'none'],
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
