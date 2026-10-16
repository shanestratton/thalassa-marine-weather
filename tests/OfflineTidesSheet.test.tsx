import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    remove: vi.fn(),
    discover: vi.fn(),
    prefetch: vi.fn(),
    settings: {
        savedLocations: ['Public place'],
        savedLocationCoords: { 'Public place': { lat: 1, lon: 2 } },
        satelliteMode: false,
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (select: (state: unknown) => unknown) => select({ settings: mocks.settings }),
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => mocks.settings.satelliteMode }));
vi.mock('../services/savedTraceStore', () => ({
    loadSavedTraces: () => [
        {
            id: 'route',
            name: 'Public route',
            points: [
                { lat: 1, lon: 2 },
                { lat: 3, lon: 4 },
            ],
        },
    ],
}));
vi.mock('../services/tides/offlineTideStore', () => ({
    listSavedTideTables: mocks.list,
    removeSavedTideTable: mocks.remove,
}));
vi.mock('../services/tides/tidePrefetch', () => ({
    discoverTideStations: mocks.discover,
    prefetchTideTable: mocks.prefetch,
    tideDiscoveryPlan: () => ({
        points: [
            { lat: 1, lon: 2 },
            { lat: 3, lon: 4 },
        ],
        partial: false,
    }),
}));
import OfflineTidesSheet from '../components/map/OfflineTidesSheet';
const station = { id: 'public', name: 'Public harbour', lat: 1, lon: 2, distance: 0 };
const table = {
    id: 't',
    station,
    provider: 'WorldTides',
    datum: 'MSL',
    predictionStationName: 'Actual station',
    official: false,
    coverageStartMs: Date.parse('2026-10-15T00:00Z'),
    coverageEndMs: Date.parse('2026-11-16T00:00Z'),
    fetchedAtMs: Date.parse('2026-10-16T00:00Z'),
    savedAtMs: Date.parse('2026-10-16T01:00Z'),
    generatedAt: null,
    copyright: 'WorldTides required attribution',
    licenceUrl: 'https://www.worldtides.info/copyright',
    extremes: [{ timeMs: Date.parse('2026-10-16T01:00Z'), heightM: -0.2, type: 'Low' }],
};
beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('11111111-1111-4111-8111-111111111111');
    mocks.settings.satelliteMode = false;
    mocks.list.mockResolvedValue([]);
    mocks.remove.mockResolvedValue(undefined);
    mocks.prefetch.mockResolvedValue({ table });
    mocks.discover.mockResolvedValue({ stations: [station], partial: false, searched: 2 });
});
afterEach(() => {
    act(() => {
        setAuthIdentityScope(null);
    });
});
describe('offline tide table controls', () => {
    it('requires explicit discovery and download, passes the whole route and chosen period', async () => {
        render(<OfflineTidesSheet onClose={() => undefined} />);
        await waitFor(() => expect(mocks.list).toHaveBeenCalled());
        expect(mocks.discover).not.toHaveBeenCalled();
        expect(mocks.prefetch).not.toHaveBeenCalled();
        fireEvent.change(screen.getByRole('combobox', { name: /Find stations/ }), { target: { value: 'route:route' } });
        fireEvent.click(screen.getByRole('button', { name: /Find stations ·/ }));
        await waitFor(() =>
            expect(mocks.discover).toHaveBeenCalledWith(
                [
                    { lat: 1, lon: 2 },
                    { lat: 3, lon: 4 },
                ],
                expect.any(AbortSignal),
            ),
        );
        fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: '30' } });
        fireEvent.click(screen.getByRole('button', { name: 'Download table' }));
        await waitFor(() => expect(mocks.prefetch).toHaveBeenCalledWith(station, 30, expect.any(AbortSignal)));
        expect(await screen.findByText('Saved and verified on this device.')).toBeInTheDocument();
    });
    it('shows saved coverage, real datum, age and copyright while Satellite Mode disables WAN controls', async () => {
        mocks.list.mockResolvedValue([table]);
        mocks.settings.satelliteMode = true;
        render(<OfflineTidesSheet station={station} onClose={() => undefined} />);
        expect(await screen.findByText(/Saved WorldTides prediction/)).toHaveTextContent('Datum: MSL');
        expect(screen.getByText(/Table covers/)).toHaveTextContent('2026-11-16');
        expect(screen.getByText(/Retrieved 2026/)).toHaveTextContent('saved 2026-10-16 01:00 UTC');
        expect(screen.getByText('WorldTides required attribution')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Download table' })).toBeDisabled();
        expect(mocks.prefetch).not.toHaveBeenCalled();
        expect(mocks.discover).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Remove saved table' }));
        await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('t'));
    });
    it('hides late old-account tables and disables further work on an identity change', async () => {
        let resolve!: (v: unknown) => void;
        mocks.list.mockReturnValue(
            new Promise((r) => {
                resolve = r;
            }),
        );
        render(<OfflineTidesSheet station={station} onClose={() => undefined} />);
        await act(async () => {
            setAuthIdentityScope('22222222-2222-4222-8222-222222222222');
            resolve([table]);
        });
        await screen.findByText(/Account changed/);
        expect(screen.queryByText('WorldTides required attribution')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Download table' })).toBeDisabled();
    });
    it('offers an explicitly station-only NOAA reconstruction offline without a network call', async () => {
        mocks.settings.satelliteMode = true;
        render(<OfflineTidesSheet onClose={() => undefined} />);
        await screen.findByText(/San Francisco · NOAA 9414290 only/);
        fireEvent.change(screen.getByLabelText('NOAA reconstruction UTC date'), { target: { value: '2026-10-16' } });
        expect(screen.getByText(/Hourly reconstructed heights · 2026-10-16 UTC/)).toBeInTheDocument();
        expect(screen.getByText(/37 NOAA harmonic constituents/)).toBeInTheDocument();
        expect(mocks.prefetch).not.toHaveBeenCalled();
    });
});
