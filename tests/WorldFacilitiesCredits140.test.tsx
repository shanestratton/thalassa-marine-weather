import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ObsCreditsRollup from '../components/map/ObsCreditsRollup';
import { SAT_IR_FULL_COVERAGE } from '../components/map/satelliteImagery';
afterEach(cleanup);
it('keeps source age, ODbL, incomplete and unavailable wording inside the existing single credits row', () => {
    const props = {
        rain: null,
        wind: null,
        cmems: [],
        lightning: false,
        ais: false,
        satellite: {
            status: 'off' as const,
            frameTimeMs: null,
            frameCount: 0,
            coverage: SAT_IR_FULL_COVERAGE,
            playing: false,
            following: false,
        },
        onToggleSatellite: () => {},
    };
    const status = {
        state: 'ready' as const,
        count: 0,
        partial: true,
        cachedOnly: true,
        sourceAt: '2020-01-01T00:00:00Z',
        coverage: 'Fictional test coverage',
    };
    const view = render(<ObsCreditsRollup {...props} facilities={status} />);
    const row = screen.getByTestId('obs-credits-rollup');
    expect(row).not.toHaveTextContent('2020');
    expect(within(row).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Credits; layer status needs review' }));
    const source = screen.getByRole('region', { name: 'Facilities source' });
    expect(source).toHaveTextContent('Community data, may be incomplete');
    expect(source).toHaveTextContent('2020-01-01');
    expect(source).toHaveTextContent('Saved data');
    expect(source).toHaveTextContent('Partial area');
    expect(within(source).getByRole('link', { name: 'ODbL' })).toHaveAttribute(
        'href',
        'https://opendatacommons.org/licenses/odbl/1-0/',
    );
    view.rerender(
        <ObsCreditsRollup
            {...props}
            facilities={{ state: 'unavailable', count: 0, partial: true, cachedOnly: false }}
        />,
    );
    expect(screen.getByRole('region', { name: 'Facilities source' })).toHaveTextContent('may not be published');
    view.rerender(<ObsCreditsRollup {...props} facilities={null} />);
    expect(screen.queryByTestId('obs-credits-rollup')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
});
