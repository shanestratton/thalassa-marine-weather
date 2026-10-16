import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DepartureWindowSheet } from '../components/passage/DepartureWindowSheet';
import type { DepartureScenario } from '../services/departureWindow';
const scenario: DepartureScenario = {
    departureTime: '2026-10-20T06:00:00Z',
    arrivalTime: '2026-10-21T06:00:00Z',
    durationHours: 24,
    distanceNM: 140,
    maxWindKts: 15,
    avgWindKts: 12,
    galeHours: 0,
    stormHours: 0,
    score: 20,
    verdict: 'maybe',
    routeFound: true,
    maxWaveM: 1.5,
    maxRainMmPerHour: null,
    upwindPct: 25,
    avgCurrentKts: -0.5,
    comfortLevel: 1,
    windComplete: true,
    coverage: ['rain'],
    rankedTerms: ['wind', 'headwind', 'waves'],
    tideStatus: 'unknown',
};
it('compares the extra metrics in a table, names missing coverage and refuses a no-go time', () => {
    const onAccept = vi.fn();
    render(
        <DepartureWindowSheet
            open
            onClose={vi.fn()}
            planning={false}
            onAccept={onAccept}
            scenarios={[
                scenario,
                {
                    ...scenario,
                    departureTime: '2026-10-20T12:00:00Z',
                    score: Infinity,
                    verdict: 'no-go',
                    tideStatus: 'blocked',
                },
            ]}
        />,
    );
    const table = screen.getByRole('table', { name: 'Departure weather comparison' });
    expect(within(table).getByRole('columnheader', { name: 'Rain max' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Upwind' })).toBeInTheDocument();
    expect(table).toHaveTextContent('Incomplete: rain');
    expect(table).toHaveTextContent('Tide: unknown');
    const choices = within(table).getAllByRole('button');
    fireEvent.click(choices[0]);
    expect(onAccept).toHaveBeenCalledWith(scenario);
    expect(choices[1]).toBeDisabled();
    expect(screen.getByText(/Best compared estimate/)).not.toHaveTextContent('12:00');
});
