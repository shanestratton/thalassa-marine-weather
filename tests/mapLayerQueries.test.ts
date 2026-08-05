import { describe, expect, it, vi } from 'vitest';
import { existingMapLayerIds } from '../components/map/mapLayerQueries';

describe('existingMapLayerIds', () => {
    it('keeps only mounted layers so optional ENC and AIS queries stay quiet', () => {
        const getLayer = vi.fn((id: string) =>
            id === 'enc-depare' || id === 'ais-targets-circle' ? { id } : undefined,
        );

        expect(
            existingMapLayerIds({ getLayer } as never, [
                'enc-boylat',
                'enc-depare',
                'enc-wrecks',
                'ais-targets-circle',
            ]),
        ).toEqual(['enc-depare', 'ais-targets-circle']);
    });

    it('treats a style-swap lookup failure as an absent layer', () => {
        const getLayer = vi.fn((id: string) => {
            if (id === 'mid-swap') throw new Error('Style is not done loading');
            return id === 'ready' ? { id } : undefined;
        });

        expect(existingMapLayerIds({ getLayer } as never, ['mid-swap', 'ready'])).toEqual(['ready']);
    });
});
