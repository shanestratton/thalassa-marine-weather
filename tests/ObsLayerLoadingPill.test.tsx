import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type React from 'react';
import { getObsLayerLoadingKind, ObsLayerLoadingPill } from '../components/map/ObsLayerLoadingPill';
import type { WeatherLayer } from '../components/map/mapConstants';

function props(overrides: Partial<React.ComponentProps<typeof ObsLayerLoadingPill>> = {}) {
    return {
        activeLayers: new Set<WeatherLayer>(),
        windLoading: false,
        windReady: true,
        windHasGrid: true,
        windError: null,
        rainLoading: false,
        rainImageLoading: false,
        ...overrides,
    };
}

describe('ObsLayerLoadingPill', () => {
    it('stays absent when the active OBS layers are ready', () => {
        const { container } = render(<ObsLayerLoadingPill {...props()} />);

        expect(container).toBeEmptyDOMElement();
    });

    it('centres the loading pill while wind is still preparing', () => {
        render(<ObsLayerLoadingPill {...props({ activeLayers: new Set(['wind']), windReady: false })} />);

        expect(screen.getByRole('status', { name: 'Loading wind layer' })).toHaveTextContent('Loading');
    });

    it('keeps the pill visible until the first rain image has rendered', () => {
        const input = props({ activeLayers: new Set(['rain']), rainImageLoading: true });

        expect(getObsLayerLoadingKind(input)).toBe('rain');
        render(<ObsLayerLoadingPill {...input} />);

        expect(screen.getByRole('status', { name: 'Loading rain layer' })).toBeInTheDocument();
    });

    it('does not present a loading state for a failed wind request', () => {
        expect(
            getObsLayerLoadingKind(props({ activeLayers: new Set(['wind']), windReady: false, windError: 'offline' })),
        ).toBeNull();
    });

    it('stays silent while a viewport refinement refreshes behind a live wind field', () => {
        // keepRenderedGrid: loading=true but the previous grid is still
        // rendered and animating — announcing "Loading wind layer" over a
        // live field is the bug this pins down.
        expect(
            getObsLayerLoadingKind(
                props({ activeLayers: new Set(['wind']), windLoading: true, windReady: true, windHasGrid: true }),
            ),
        ).toBeNull();
    });

    it('still centres the pill for a first load with nothing on screen', () => {
        expect(
            getObsLayerLoadingKind(
                props({ activeLayers: new Set(['wind']), windLoading: true, windReady: false, windHasGrid: false }),
            ),
        ).toBe('wind');
    });
});
