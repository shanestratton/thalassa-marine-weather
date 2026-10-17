import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ saved: vi.fn().mockResolvedValue(null), download: vi.fn() }));
vi.mock('../services/weather/synopticChartCache', () => ({
    savedSynopticChart: mocks.saved,
    downloadSynopticChart: mocks.download,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: unknown) => unknown) => selector({ settings: { satelliteMode: true } }),
}));
vi.mock('../services/externalLinks', () => ({ openExternalUrl: vi.fn() }));
import { SynopticChartSheet } from '../components/map/SynopticChartSheet';
import { LegendDock } from '../components/map/ThalassaHelixControl';
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});
describe('official chart sheet', () => {
    it('downloads only after a tap and keeps download age separate from printed valid time', async () => {
        mocks.download.mockResolvedValue({
            chart: {
                id: 'jma-analysis',
                dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
                downloadedAt: Date.now(),
                bytes: 8,
            },
            offlineSaved: false,
        });
        render(<SynopticChartSheet point={{ lat: 35, lon: 140 }} onClose={vi.fn()} />);
        expect(mocks.download).not.toHaveBeenCalled();
        expect(screen.getByText(/charts never download automatically/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Download chart/ }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('offline saving was unavailable'));
        expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({ id: 'jma-analysis' }), {
            explicit: true,
        });
        expect(screen.getByText(/Valid time: read the time printed/)).toBeTruthy();
        expect(screen.getByText(/This is the download age/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
        expect(screen.getByRole('img')).toHaveStyle({ transform: 'translate(0px,0px) scale(1.5)' });
        fireEvent.click(screen.getByRole('button', { name: 'Fit chart' }));
        expect(screen.getByRole('img')).toHaveStyle({ transform: 'translate(0px,0px) scale(1)' });
    });
    it('gives the southern model-isobar fallback without a download button', () => {
        render(<SynopticChartSheet point={{ lat: -37, lon: 174 }} onClose={vi.fn()} />);
        expect(screen.getByText(/Use the model isobars on the map/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Download chart/ })).toBeNull();
    });
    it('offers the pressure legend entry even while model pressure is unavailable', () => {
        const open = vi.fn();
        render(<LegendDock layers={['pressure']} unavailableLayers={['pressure']} onOfficialCharts={open} />);
        fireEvent.click(screen.getByRole('button', { name: 'Show weather legends' }));
        fireEvent.click(screen.getByRole('button', { name: 'Official analysis charts' }));
        expect(open).toHaveBeenCalledOnce();
    });
});
