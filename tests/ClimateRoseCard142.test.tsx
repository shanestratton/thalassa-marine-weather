import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClimateRoseCard from '../components/passage/ClimateRoseCard';
import { readEra5Climate } from '../services/climatology/era5ClimateReader';
import { fetchRoutesAndTracks } from '../services/shiplog/RoutesAndTracks';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { climateCellFixture } from './fixtures/climate142';
import type { TripLegLike } from '../services/climatology/tcClimatology';
vi.mock('../services/climatology/era5ClimateReader', () => ({ readEra5Climate: vi.fn() }));
vi.mock('../services/shiplog/RoutesAndTracks', () => ({ fetchRoutesAndTracks: vi.fn() }));
const route = [
    {
        points: [
            { lat: -27, lon: 153 },
            { lat: -27, lon: 153.1 },
        ],
    },
];
const source = () => ({
    cells: new Map([['-27,153', climateCellFixture()]]),
    generatedAt: '2026-10-17T00:00:00Z',
    generation: 'a'.repeat(64),
});
const leg: TripLegLike = {
    id: 'fictional-leg',
    departure_port: 'A',
    destination_port: 'B',
    departure_time: null,
    eta: null,
};
beforeEach(() => {
    setAuthIdentityScope('fictional-owner-a');
    vi.mocked(readEra5Climate).mockReset();
    vi.mocked(fetchRoutesAndTracks).mockReset();
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
});
describe('142 explicit route climate card', () => {
    it('does no read while collapsed; shows actual period, units, coverage, both roses and climate limits', async () => {
        vi.mocked(readEra5Climate).mockResolvedValue(source());
        render(<ClimateRoseCard routeLegs={route} />);
        expect(readEra5Climate).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button'));
        expect(await screen.findByText(/100% of route length/)).toBeTruthy();
        expect(screen.getAllByRole('img')).toHaveLength(2);
        expect(screen.getByText(/1991–2020/)).toBeTruthy();
        expect(screen.getByText(/not a forecast or a safe-passage/)).toBeTruthy();
        expect(screen.getByText(/not independent observations/)).toBeTruthy();
        expect(screen.getByText(/CC BY 4.0/)).toBeTruthy();
        fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('1');
    });
    it('never invents geometry from matching route labels or a straight line between ports', async () => {
        vi.mocked(fetchRoutesAndTracks).mockResolvedValue({ routes: [], tracks: [] });
        render(<ClimateRoseCard legs={[leg]} />);
        fireEvent.click(screen.getByRole('button'));
        expect(await screen.findByText(/Climate unavailable/)).toBeTruthy();
        expect(readEra5Climate).not.toHaveBeenCalled();
        expect(screen.queryByText(/Lower historical exposure/)).toBeNull();
    });
    it('does not rank a route with missing original-year coverage', async () => {
        const data = source();
        data.cells.get('-27,153')!.months.forEach((month) => {
            month.waveYears = 0;
        });
        vi.mocked(readEra5Climate).mockResolvedValue(data);
        render(<ClimateRoseCard routeLegs={route} />);
        fireEvent.click(screen.getByRole('button'));
        expect(await screen.findByText(/No fully covered month/)).toBeTruthy();
        expect(screen.getByText(/Missing ocean or land-mask cells are not calm/)).toBeTruthy();
        expect(screen.queryAllByRole('img')).toHaveLength(0);
    });
    it('hides an already completed climate immediately when the actual route changes', async () => {
        let later!: (value: ReturnType<typeof source>) => void;
        vi.mocked(readEra5Climate)
            .mockResolvedValueOnce(source())
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        later = resolve;
                    }),
            );
        const view = render(<ClimateRoseCard routeLegs={route} />);
        fireEvent.click(screen.getByRole('button'));
        await screen.findByText(/100% of route length/);
        view.rerender(
            <ClimateRoseCard
                routeLegs={[
                    {
                        points: [
                            { lat: 0, lon: 0 },
                            { lat: 0, lon: 0.1 },
                        ],
                    },
                ]}
            />,
        );
        expect(screen.queryByText(/100% of route length/)).toBeNull();
        expect(screen.queryByText(/Lower historical exposure/)).toBeNull();
        await act(async () => later(source())); // No returned cells belong to the new route.
        expect(await screen.findByText(/No fully covered month/)).toBeTruthy();
        expect(screen.getByText(/0% of route length/)).toBeTruthy();
    });
    it('retires changed routes and A/B/A account transitions, ignores late native settlement', async () => {
        let late!: (value: ReturnType<typeof source>) => void;
        vi.mocked(readEra5Climate).mockImplementation(
            () =>
                new Promise((resolve) => {
                    late = resolve;
                }),
        );
        const view = render(<ClimateRoseCard routeLegs={route} />);
        fireEvent.click(screen.getByRole('button'));
        const originalSignal = vi.mocked(readEra5Climate).mock.calls[0][1];
        act(() => {
            setAuthIdentityScope('fictional-owner-b');
            setAuthIdentityScope('fictional-owner-a');
        });
        expect(originalSignal.aborted).toBe(true);
        await act(async () => late(source()));
        expect(screen.queryByText(/100% of route length/)).toBeNull();
        expect(screen.getByText(/Climate unavailable/)).toBeTruthy();
        view.rerender(
            <ClimateRoseCard
                routeLegs={[
                    {
                        points: [
                            { lat: 0, lon: 0 },
                            { lat: 0, lon: 0.1 },
                        ],
                    },
                ]}
            />,
        );
        expect(screen.queryByText(/100% of route length/)).toBeNull();
        const nextSignal = vi.mocked(readEra5Climate).mock.calls.at(-1)![1];
        view.unmount();
        expect(nextSignal.aborted).toBe(true);
    });
});
