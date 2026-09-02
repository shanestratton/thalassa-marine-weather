/**
 * The barometer breakout's controls — Shane's spec was "make sure the
 * buttons are easy to click when it is open", and easy-to-click buttons
 * that do nothing are worse than small ones. These pin the handlers.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const baro = vi.hoisted(() => ({
    unit: 'hPa' as 'hPa' | 'inHg',
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
    getOffset: () => ({ offsetHpa: null }),
    calibrateTo: baro.calibrateTo,
    clearCalibration: baro.clearCalibration,
}));

import { BarometerModal } from '../components/dashboard/hero/BarometerModal';

beforeEach(() => {
    baro.unit = 'hPa';
    vi.clearAllMocks();
});

const hourly = Array.from({ length: 13 }, (_, i) => ({
    time: new Date(Date.now() + i * 3_600_000).toISOString(),
    pressure: 1013 + i * 0.2,
}));

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
        expect(screen.getByText(/Buys Ballot/i)).toBeInTheDocument();
    });

    it('the close control is ModalSheet-sized (44px), and closing works', () => {
        const onClose = vi.fn();
        render(<BarometerModal isOpen onClose={onClose} hourly={hourly as never} forecastPressure={1013.4} />);
        const close = screen.getByRole('button', { name: /close modal/i });
        expect(close.className).toContain('w-11 h-11');
        fireEvent.click(close);
        expect(onClose).toHaveBeenCalled();
    });
});
