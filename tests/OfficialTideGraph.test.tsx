import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TideGUIDetails } from '../types/weather';
vi.mock('../components/dashboard/tide/TideCanvas', () => ({ TideCanvas: () => <div data-testid="tide-canvas" /> }));
vi.mock('../components/map/OfflineTidesSheet', () => ({
    default: ({ onClose }: { onClose: () => void }) => (
        <div role="dialog" aria-label="Offline tides">
            <button onClick={onClose}>Close offline tides</button>
        </div>
    ),
}));
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
    it('reserves a footer outside the plot and keeps both actions independent of the surrounding card', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW);
        const cardAction = vi.fn();
        const cardKey = vi.fn();
        render(
            <div onClick={cardAction} onKeyDown={cardKey}>
                <TideGraph
                    tides={tides}
                    unit="m"
                    unitPref={{ tideHeight: 'm' } as never}
                    guiDetails={metadata}
                    customTime={NOW}
                />
            </div>,
        );
        const plot = screen.getByTestId('tide-plot');
        const footer = screen.getByTestId('tide-source-footer');
        expect(plot).not.toContainElement(footer);
        expect(plot.nextElementSibling).toBe(footer);
        expect(footer).toHaveStyle({ height: '44px' });
        const source = screen.getByRole('button', { name: 'Source and datum' });
        expect(source).toHaveAccessibleDescription('NOAA · MLLW · Annapolis');
        fireEvent.keyDown(source, { key: 'Enter' });
        fireEvent.click(source);
        expect(screen.getByRole('dialog', { name: 'Tide source' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Licence' })).toHaveAttribute('href', metadata.licenceUrl);
        expect(cardAction).not.toHaveBeenCalled();
        expect(cardKey).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        fireEvent.click(screen.getByRole('button', { name: 'Offline tides' }));
        expect(await screen.findByRole('dialog', { name: 'Offline tides' })).toBeInTheDocument();
        expect(cardAction).not.toHaveBeenCalled();
        expect(cardKey).not.toHaveBeenCalled();
    });
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
