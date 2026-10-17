import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnsembleBand from '../components/dashboard/EnsembleBand';
import { loadEnsembleForecast } from '../services/weather/ensembleForecast';
import { reduceEnsemble } from '../utils/ensembleForecast';
import { ensembleFixture, ENSEMBLE_FIXTURE_NOW as now } from './fixtures/ensemble142';
vi.mock('../services/weather/ensembleForecast', () => ({ loadEnsembleForecast: vi.fn() }));
const forecast = (product: 'ifs' | 'ec46' = 'ifs', lat = -27) =>
    reduceEnsemble(ensembleFixture(), product, lat, 153, now, 'a'.repeat(64));
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.mocked(loadEnsembleForecast).mockReset();
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});
describe('142 ensemble panel', () => {
    it('shows actual denominator, percentile band and unknown issue time without a calibrated probability claim', async () => {
        vi.mocked(loadEnsembleForecast).mockResolvedValue(forecast());
        render(<EnsembleBand latitude={-27} longitude={153} />);
        expect(await screen.findByText(/Wind ≥25 kt in 26 of 51/)).toBeTruthy();
        expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(2);
        expect(screen.getByText(/Run issue time unavailable/)).toBeTruthy();
        expect(screen.getByText(/not calibrated probabilities/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Show gusts' }));
        expect(screen.getByText(/Gusts ≥25 kt in 26 of 51/)).toBeTruthy();
    });
    it('leaves missing-member gaps in the band and names the insufficient count', async () => {
        const value = ensembleFixture(5);
        for (const [key, array] of Object.entries(value.hourly))
            if (key.startsWith('wind_speed')) (array as unknown[])[2] = null;
        vi.mocked(loadEnsembleForecast).mockResolvedValue(reduceEnsemble(value, 'ifs', -27, 153, now, 'b'.repeat(64)));
        render(<EnsembleBand latitude={-27} longitude={153} />);
        await screen.findByText(/Wind ≥25 kt/);
        expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(4);
        fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
        expect(screen.getByText(/Insufficient members: 0 of 51/)).toBeTruthy();
    });
    it('retires old coordinates/product results and ignores a late response after change or unmount', async () => {
        let late!: (value: ReturnType<typeof forecast>) => void;
        vi.mocked(loadEnsembleForecast)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        late = resolve;
                    }),
            )
            .mockResolvedValueOnce(forecast('ec46'));
        const view = render(<EnsembleBand latitude={-27} longitude={153} />);
        const firstSignal = vi.mocked(loadEnsembleForecast).mock.calls[0][3];
        fireEvent.click(screen.getByRole('button', { name: 'EC46 · 46 days' }));
        expect(firstSignal.aborted).toBe(true);
        await screen.findByText(/ECMWF EC46 ·/);
        await act(async () => late(forecast()));
        expect(screen.queryByText(/ECMWF IFS ensemble ·/)).toBeNull();
        const signal = vi.mocked(loadEnsembleForecast).mock.calls[1][3];
        view.unmount();
        expect(signal.aborted).toBe(true);
    });
    it('keeps absent services/plan refusal explicit instead of drawing mock data', async () => {
        vi.mocked(loadEnsembleForecast).mockRejectedValue(new Error('not available'));
        render(<EnsembleBand latitude={-27} longitude={153} />);
        expect(await screen.findByText(/Ensemble unavailable/)).toBeTruthy();
        expect(screen.queryByRole('img')).toBeNull();
    });
    it('expires an already-open receipt without silently renewing its truth', async () => {
        vi.useFakeTimers();
        vi.mocked(loadEnsembleForecast).mockResolvedValue(forecast());
        render(<EnsembleBand latitude={-27} longitude={153} />);
        await act(async () => {
            await Promise.resolve();
        });
        expect(screen.getByRole('img')).toBeTruthy();
        await act(async () => {
            vi.advanceTimersByTime(1800000);
        });
        expect(screen.queryByRole('img')).toBeNull();
        expect(screen.getByText(/Ensemble unavailable/)).toBeTruthy();
        expect(loadEnsembleForecast).toHaveBeenCalledTimes(1);
    });
});
