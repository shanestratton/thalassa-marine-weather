import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteForecast } from '../services/routeForecastSampler';
import PassageSailPlans from '../components/passage/PassageSailPlans';
import { sailInventoryFixture } from './helpers/sailInventoryFixture';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const data = vi.hoisted(() => ({ peek: vi.fn(), load: vi.fn() }));
vi.mock('../services/routeForecastSampler', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/routeForecastSampler')>()),
    peekRouteForecast: data.peek,
    loadRouteForecast: data.load,
}));
const epoch = Date.parse('2026-10-17T12:00:00Z');
const forecast = (): RouteForecast => ({
    model: 'gfs_global',
    fetchedAt: epoch,
    totalNm: 10,
    stations: [0, 10].map((alongNm) => ({
        alongNm,
        lat: 0,
        lon: alongNm / 60,
        timesMs: [epoch, epoch + 3_600_000],
        speedKts: [12, 20],
        dirDeg: [90, 90],
        gustKts: [null, null],
        precipMm: [0, 0],
        precipProb: [0, 0],
    })),
});
const props = () => ({
    vessel: { type: 'sail' as const, sailInventory: sailInventoryFixture() },
    vesselKey: 'boat-a',
    coords: [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 1 / 6 },
    ],
    legs: [
        { name: 'First leg', timeMs: epoch, alongNm: 0, courseDeg: 0 },
        { name: 'Later leg', timeMs: epoch + 3_600_000, alongNm: 10, courseDeg: 0 },
    ],
    model: 'gfs_global',
    provider: 'NOAA',
    nowMs: epoch,
});
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    data.peek.mockReset();
    data.load.mockReset();
    data.peek.mockReturnValue(null);
    data.load.mockResolvedValue(null);
    setAuthIdentityScope('sail-owner-a');
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setAuthIdentityScope(null);
});
describe('per-leg sail choices from covered named wind', () => {
    it('uses actual leg clocks and a fresh cached forecast without a network request', () => {
        data.peek.mockReturnValue(forecast());
        render(<PassageSailPlans {...props()} />);
        const rows = screen.getAllByTestId('leg-sail-plan');
        expect(rows[0]).toHaveTextContent('Light plan');
        expect(rows[1]).toHaveTextContent('Reduced plan');
        expect(data.load).not.toHaveBeenCalled();
    });
    it('does not fetch automatically, and permits only an explicit bounded named-model load', async () => {
        data.load.mockResolvedValue(forecast());
        render(<PassageSailPlans {...props()} />);
        expect(data.load).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Load wind for sail plans' }));
        await waitFor(() => expect(screen.getAllByTestId('leg-sail-plan')[0]).toHaveTextContent('Light plan'));
        expect(data.load).toHaveBeenCalledExactlyOnceWith(props().coords, 'gfs_global');
    });
    it('keeps Satellite Mode and an unnamed provider blend off the network', () => {
        const view = render(<PassageSailPlans {...props()} satelliteMode />);
        expect(screen.getByRole('button', { name: /Satellite Mode/ })).toBeDisabled();
        view.rerender(<PassageSailPlans {...props()} model={null} />);
        expect(screen.getByRole('button', { name: /Choose a named wind model/ })).toBeDisabled();
        expect(data.load).not.toHaveBeenCalled();
    });
    it('does not display an old, wrong-model, partially known or out-of-time forecast as a plan', () => {
        for (const value of [
            { ...forecast(), model: 'other-model' },
            { ...forecast(), fetchedAt: epoch - 3_600_001 },
        ]) {
            data.peek.mockReturnValue(value);
            const view = render(<PassageSailPlans {...props()} />);
            expect(
                screen.getAllByTestId('leg-sail-plan').every((row) => row.textContent?.includes('Unavailable')),
            ).toBe(true);
            view.unmount();
        }
        const value = forecast();
        value.stations[1].speedKts[1] = null;
        data.peek.mockReturnValue(value);
        render(<PassageSailPlans {...props()} />);
        expect(screen.getAllByTestId('leg-sail-plan')[1]).toHaveTextContent('Unavailable');
    });
    it('rejects a late request after an account/vessel change, preserving the new boat’s unavailable state', async () => {
        let resolve!: (value: RouteForecast) => void;
        data.load.mockReturnValue(
            new Promise<RouteForecast>((done) => {
                resolve = done;
            }),
        );
        const view = render(<PassageSailPlans {...props()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Load wind for sail plans' }));
        act(() => {
            setAuthIdentityScope('sail-owner-b');
        });
        view.rerender(<PassageSailPlans {...props()} vesselKey="boat-b" />);
        await act(async () => {
            resolve(forecast());
        });
        expect(screen.getAllByTestId('leg-sail-plan').every((row) => row.textContent?.includes('Unavailable'))).toBe(
            true,
        );
    });
});
