import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RouteEstimateSummary } from '../components/passage/RouteEstimateSummary';
import { estimateRouteFuel, sailingStatsForNodes } from '../services/isochrone/routeStats';
it('renders unknown propulsion honestly and labels an all-engine fuel scenario separately', () => {
    const fuel = estimateRouteFuel(null, 6, { fuelBurn: 4, fuelCapacity: 20, fuelReservePct: 20 });
    render(
        <RouteEstimateSummary stats={{ ...sailingStatsForNodes([]), totalHours: 6, unknownHours: 6 }} fuel={fuel} />,
    );
    const card = screen.getByLabelText('Route sailing and fuel estimates');
    expect(card).toHaveTextContent('Motor unknown');
    expect(card).toHaveTextContent('24.0 L if motoring all 6.0 h');
    expect(card).toHaveTextContent('Confirm actual fuel aboard');
});
it('shows the relaxed wave limit, encountered place and unknown coverage beside beta comfort', () => {
    render(
        <RouteEstimateSummary
            comfort={{
                maxWaveM: 2.8,
                maxWaveAt: { lat: -24, lon: 153 },
                knownHours: 4,
                unknownHours: 2,
                coverage: 'partial',
                level: 2,
                word: 'Uncomfortable',
                genericBoat: false,
                relaxedFromM: 2.5,
                usedLimitM: 2.875,
            }}
        />,
    );
    const card = screen.getByLabelText('Route sailing and fuel estimates');
    expect(card).toHaveTextContent('Wave coverage partial');
    expect(card).toHaveTextContent('needs 2.8 m seas near 24.000° S, 153.000° E; your limit is 2.5 m');
    expect(card).toHaveTextContent('Beta comfort 2/3: Uncomfortable');
    expect(card).toHaveTextContent('2.0 h unchecked');
});
