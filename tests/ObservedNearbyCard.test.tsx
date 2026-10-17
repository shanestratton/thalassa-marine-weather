import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NOW, metar, ndbcLatest } from './observationFixtures';
const mocks = vi.hoisted(() => ({ load: vi.fn(), history: vi.fn() }));
vi.mock('../services/weather/observations/feed', () => ({
    loadNearbyObservations: mocks.load,
    loadObservationHistory: mocks.history,
}));
import ObservedNearbyCard from '../components/observations/ObservedNearbyCard';
import { WeatherInspectPopup } from '../components/map/WeatherInspectPopup';
import { parseAwcMetars, parseNdbcLatest } from '../services/weather/observations/parsers';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const point = { lat: 30, lon: -150 };
const rows = [
    ...parseAwcMetars(JSON.stringify([metar()]), NOW).rows,
    ...parseNdbcLatest(ndbcLatest(['ZZ001 30.02 -150 2026 10 16 11 30 90 5 8 1008 20']), NOW).rows,
];
const result = (at = point) => ({
    point: at,
    radiusNm: 50,
    rows,
    availability: { ndbc: 'available', 'awc-metar': 'available' },
    partial: false,
    cachedOnly: false,
});
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    setAuthIdentityScope('observation-display-a');
    mocks.load.mockReset().mockImplementation(async (at) => result(at));
    mocks.history.mockReset().mockResolvedValue({ rows, partial: false, cachedOnly: false });
});
afterEach(() => {
    cleanup();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});
describe('Observed nearby presentation', () => {
    it('keeps forecast independent and names both pressure conventions, clock, distance and exposure', async () => {
        render(<ObservedNearbyCard point={point} briefing />);
        expect(await screen.findByText('Observed near departure — now')).toBeInTheDocument();
        expect(await screen.findByText(/Sea-level pressure 1007.4 hPa.*Altimeter\/QNH 1010.2 hPa/)).toBeInTheDocument();
        expect(screen.getByText(/Airport \/ METAR station; exposure/)).toBeInTheDocument();
        expect(screen.getByText('Station exposure unknown')).toBeInTheDocument();
        expect(screen.getByText(/20 min ago.*2026-10-16 11:40:00 UTC/)).toBeInTheDocument();
        expect(screen.getByText(/not a forecast for your departure time/)).toBeInTheDocument();
    });
    it('shows observations even when the tapped forecast fails', async () => {
        render(
            <WeatherInspectPopup
                data={null}
                loading={false}
                error="Forecast unavailable"
                onClose={vi.fn()}
                observationPoint={point}
            />,
        );
        expect(await screen.findByText(/Synthetic airport/)).toBeInTheDocument();
        expect(screen.getByText('Forecast unavailable')).toBeInTheDocument();
    });
    it('does not let a previous point reply paint into the new point or a new login', async () => {
        const held: { at: typeof point; resolve: (value: unknown) => void; signal: AbortSignal }[] = [];
        mocks.load.mockImplementation((at, signal) => new Promise((resolve) => held.push({ at, resolve, signal })));
        const view = render(<ObservedNearbyCard point={point} />);
        const next = { lat: 31, lon: -150 };
        view.rerender(<ObservedNearbyCard point={next} />);
        expect(held[0].signal.aborted).toBe(true);
        await act(async () => held[0].resolve(result(point)));
        expect(screen.queryByText(/Synthetic airport/)).not.toBeInTheDocument();
        act(() => setAuthIdentityScope('observation-display-b'));
        await act(async () => held[1].resolve(result(next)));
        expect(screen.queryByText(/Synthetic airport/)).not.toBeInTheDocument();
        view.unmount();
        expect(held.at(-1)!.signal.aborted).toBe(true);
    });
    it('recalculates observation age and removes readings after the current-age threshold', async () => {
        render(<ObservedNearbyCard point={point} />);
        await screen.findByText(/Synthetic airport/);
        await act(async () => {
            vi.setSystemTime(NOW + 4 * 3600000);
            document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(screen.queryByText(/Synthetic airport/)).not.toBeInTheDocument();
        expect(screen.getByText(/No recent Airport METAR observation/)).toBeInTheDocument();
    });
    it('loads only requested station history with actual extent, missing values and cancellation', async () => {
        const airport = rows[0];
        mocks.history.mockResolvedValue({
            rows: [{ ...airport, observedAtMs: NOW - 5 * 3600000, windSpeedKts: null, gustKts: null }, airport],
            partial: true,
            cachedOnly: true,
        });
        const view = render(<ObservedNearbyCard point={point} />);
        await screen.findByText(/Synthetic airport/);
        fireEvent.change(screen.getByLabelText('History window'), { target: { value: '72' } });
        fireEvent.click(screen.getByRole('button', { name: 'Read ZZ01 history' }));
        expect(await screen.findByText(/2 retained samples.*cached this session/)).toBeInTheDocument();
        expect(mocks.history).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'ZZ01' }),
            72,
            expect.any(AbortSignal),
        );
        expect(screen.getByText('Gap over 2 hours')).toBeInTheDocument();
        expect(screen.getAllByRole('cell').some((cell) => cell.textContent?.startsWith('— / —'))).toBe(true);
        expect(screen.getByText(/not a complete 72-hour record/)).toBeInTheDocument();
        const signal = mocks.history.mock.calls[0][2];
        view.unmount();
        expect(signal.aborted).toBe(true);
    });
});
