import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TideGUIDetails } from '../types/weather';
vi.mock('../components/dashboard/tide/TideCanvas', () => ({ TideCanvas: () => <div data-testid="tide-canvas" /> }));
import { TideGraph } from '../components/dashboard/tide/TideGraph';

const NOW = Date.UTC(2026, 9, 16, 0);
const metadata: TideGUIDetails = {
    source: 'official',
    provider: 'NOAA',
    stationId: '8575512',
    stationName: 'Annapolis',
    isSecondary: false,
    datumId: 'noaa:8575512:MLLW',
    datumLabel: 'MLLW',
    rawDatum: 'MLLW',
    attribution: 'Tide predictions: NOAA CO-OPS (public domain).',
    sourceUrl: 'https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=8575512',
    licenceUrl: 'https://tidesandcurrents.noaa.gov/disclaimers.html',
    generatedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
};
const tides = [
    { time: new Date(NOW - 3 * 3_600_000).toISOString(), type: 'Low' as const, height: 0.2 },
    { time: new Date(NOW + 3 * 3_600_000).toISOString(), type: 'High' as const, height: 0.8 },
];
afterEach(() => vi.restoreAllMocks());
describe('official tide display provenance', () => {
    it('labels persisted official extrema as a saved table without reviving publisher freshness or observations', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        render(
            <TideGraph
                tides={tides}
                unit="m"
                unitPref={{ tideHeight: 'm' } as never}
                guiDetails={{
                    ...metadata,
                    source: 'saved-official',
                    expiresAt: undefined,
                    savedAt: new Date(NOW - 86400000).toISOString(),
                    coverageStart: tides[0].time,
                    coverageEnd: tides[1].time,
                }}
                customTime={NOW}
            />,
        );
        expect(screen.getByTestId('tide-station-name')).toHaveTextContent('Saved NOAA table · MLLW · Annapolis');
        expect(screen.queryByTestId('tide-observed')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Source and datum' }));
        expect(screen.getByText(/Saved table · downloaded/)).toHaveTextContent('does not establish a fresh publisher');
    });
    it('names station and datum, labels interpolation, and offers source/licence attribution', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        render(
            <TideGraph
                tides={tides}
                unit="m"
                unitPref={{ tideHeight: 'm' } as never}
                guiDetails={metadata}
                customTime={NOW}
            />,
        );
        expect(screen.getByTestId('tide-station-name')).toHaveTextContent('NOAA · MLLW · Annapolis');
        expect(screen.getByText('Est. height')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Source and datum' }));
        expect(screen.getByText(/Tide predictions: NOAA CO-OPS/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Source table' })).toHaveAttribute('href', metadata.sourceUrl);
        expect(screen.getByRole('link', { name: 'Licence' })).toHaveAttribute('href', metadata.licenceUrl);
    });
    it('hides expired official predictions rather than retaining an unlabelled height', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW + 2 * 86_400_000);
        render(
            <TideGraph
                tides={tides}
                unit="m"
                unitPref={{ tideHeight: 'm' } as never}
                guiDetails={metadata}
                customTime={NOW}
            />,
        );
        expect(screen.getByText(/Tide predictions expired/)).toBeInTheDocument();
        expect(screen.queryByTestId('tide-canvas')).not.toBeInTheDocument();
        expect(screen.queryByText(/Annapolis/)).not.toBeInTheDocument();
    });
});
