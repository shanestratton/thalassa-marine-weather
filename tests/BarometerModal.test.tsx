/**
 * The barometer breakout's controls — Shane's spec was "make sure the
 * buttons are easy to click when it is open", and easy-to-click buttons
 * that do nothing are worse than small ones. These pin the handlers.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const baro = vi.hoisted(() => ({
    unit: 'hPa' as 'hPa' | 'inHg',
    offset: null as number | null,
    boat: {
        source: 'none',
        samples: [] as { t: number; hpa: number }[],
        latest: null as { t: number; hpa: number } | null,
        reason: null,
    },
    setUnit: vi.fn((u: 'hPa' | 'inHg') => {
        baro.unit = u;
    }),
    calibrateTo: vi.fn(),
    clearCalibration: vi.fn(),
}));

vi.mock('../services/native/barometer', () => ({
    subscribe: () => () => {},
    checkAvailability: () => Promise.resolve({ available: false, reason: 'no-hardware' }),
    startLogging: () => Promise.resolve(),
    getUnit: () => baro.unit,
    setUnit: baro.setUnit,
    getStationSamples: () => [],
    // Used by useBarometerSource, which the modal now consults so the boat's
    // sensor can outrank the phone. A mock missing it crashed the component
    // rather than failing an assertion — the same partial-mock trap that bit
    // utils/system on 2026-09-01.
    getSeaLevelSamples: () => [],
    getLatestSample: () => null,
    getOffset: () => ({ offsetHpa: baro.offset }),
    calibrateTo: baro.calibrateTo,
    clearCalibration: baro.clearCalibration,
}));

vi.mock('../hooks/useBarometerSource', () => ({ useBarometerSource: () => baro.boat }));
vi.mock('../services/PressureNotificationService', () => ({
    enablePressureNotifications: vi.fn().mockResolvedValue(true),
}));

import { BarometerModal } from '../components/dashboard/hero/BarometerModal';

beforeEach(() => {
    baro.unit = 'hPa';
    baro.offset = null;
    baro.boat = { source: 'none', samples: [], latest: null, reason: null };
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

const hourly = Array.from({ length: 13 }, (_, i) => ({
    time: new Date(Date.now() + i * 3_600_000).toISOString(),
    pressure: 1013 + i * 0.2,
}));
afterEach(() => vi.restoreAllMocks());

describe('BarometerModal controls', () => {
    it('shows the forecast reading with an honest source when there is no sensor', async () => {
        render(<BarometerModal isOpen onClose={() => {}} hourly={hourly as never} forecastPressure={1013.4} />);
        expect(screen.getByText('1013.4')).toBeInTheDocument();
        expect(screen.getByText('FORECAST')).toBeInTheDocument();
        expect(await screen.findByText(/no barometer/i)).toBeInTheDocument();
        // No sensor → SET must not be offered; calibrating a forecast to
        // itself is meaningless.
        expect(screen.queryByText('SET')).not.toBeInTheDocument();
    });

    it('the unit button switches hPa ↔ inHg', () => {
        render(<BarometerModal isOpen onClose={() => {}} hourly={hourly as never} forecastPressure={1013.4} />);
        fireEvent.click(screen.getByRole('button', { name: /inches of mercury/i }));
        expect(baro.setUnit).toHaveBeenCalledWith('inHg');
    });

    it('GUIDE expands the tendency explainer inline', () => {
        render(<BarometerModal isOpen onClose={() => {}} hourly={hourly as never} forecastPressure={1013.4} />);
        expect(screen.queryByText(/change over three hours/i)).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /what the tendency means/i }));
        expect(screen.getByText(/change over three hours/i)).toBeInTheDocument();
        expect(screen.getByText(/do not predict a front/i)).toBeInTheDocument();
        expect(screen.getByText(/Signal K environment.outside.pressure/i)).toBeInTheDocument();
    });

    it('the close control is ModalSheet-sized (44px), and closing works', () => {
        const onClose = vi.fn();
        render(<BarometerModal isOpen onClose={onClose} hourly={hourly as never} forecastPressure={1013.4} />);
        const close = screen.getByRole('button', { name: /^close$/i });
        expect(close.className).toContain('w-11 h-11');
        fireEvent.click(close);
        expect(onClose).toHaveBeenCalled();
    });
});

describe('BarometerModal history and calibration', () => {
    it('selects all four history windows and retains forecast MSL on the same chart', () => {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const samples = Array.from({ length: 97 }, (_, i) => ({ t: now - (96 - i) * 30 * 60_000, hpa: 1013 }));
        baro.boat = { source: 'boat', samples, latest: samples.at(-1)!, reason: null };
        baro.offset = 25; // This PHONE offset must not touch the BOAT trace.
        render(
            <BarometerModal
                isOpen
                onClose={() => {}}
                hourly={hourly.map((h) => ({ ...h, pressure: 1013 })) as never}
                forecastPressure={1013}
            />,
        );
        const path = screen.getByTestId('barometer-measured-trace');
        const initial = path.getAttribute('d')!;
        expect(initial).toContain(',37.0');
        expect(screen.getByText('1013.0')).toBeInTheDocument();
        expect(screen.queryByText('SET')).not.toBeInTheDocument();
        for (const hours of [6, 12, 24, 48]) {
            const button = screen.getByRole('button', { name: new RegExp('^' + hours + ' h$') });
            fireEvent.click(button);
            expect(button).toHaveAttribute('aria-pressed', 'true');
            expect(screen.getByRole('img', { name: new RegExp('^' + hours + ' hours') })).toBeInTheDocument();
            expect(screen.getByTestId('barometer-forecast-trace')).toBeInTheDocument();
            expect(screen.getByTestId('barometer-forecast-trace').getAttribute('d')).toContain('L');
        }
        expect(path.getAttribute('d')!.length).toBeGreaterThan(initial.length);
    });
});
