import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MetricPinSheet } from '../components/dashboard/MetricPinSheet';
import { ModelPickerSheet, forecastCreditLine } from '../components/dashboard/ModelPickerSheet';

describe('dashboard picker sheets', () => {
    it('contains MetricPinSheet focus, closes on Escape, and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <>
                <button>Open metric picker</button>
                <MetricPinSheet
                    visible={false}
                    currentMetric="temp"
                    onPick={vi.fn()}
                    onClose={onClose}
                    locationType="coastal"
                />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Open metric picker' });
        opener.focus();

        rerender(
            <>
                <button>Open metric picker</button>
                <MetricPinSheet
                    visible
                    currentMetric="temp"
                    onPick={vi.fn()}
                    onClose={onClose}
                    locationType="coastal"
                />
            </>,
        );
        // The Glass dialog header: focus starts on its top-right close, like
        // the rain and System status dialogs; the bottom Close stays in reach.
        const headerClose = screen.getByRole('button', { name: 'Close pin a metric sheet' });
        const bottomClose = screen.getByRole('button', { name: 'Close' });
        expect(headerClose).toHaveFocus();

        fireEvent.keyDown(headerClose, { key: 'Tab', shiftKey: true });
        expect(bottomClose).toHaveFocus();
        fireEvent.keyDown(bottomClose, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Open metric picker</button>
                <MetricPinSheet
                    visible={false}
                    currentMetric="temp"
                    onPick={vi.fn()}
                    onClose={onClose}
                    locationType="coastal"
                />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('names the pin sheet by its heading and speaks plain words, not "hero slot"', () => {
        render(
            <MetricPinSheet visible currentMetric="temp" onPick={vi.fn()} onClose={vi.fn()} locationType="coastal" />,
        );
        const dialog = screen.getByRole('dialog', { name: 'Pin a metric to the top' });
        expect(dialog).toHaveTextContent('big number at the top');
        expect(dialog).not.toHaveTextContent(/hero/i);
        expect(
            screen.getByRole('button', { name: 'Show sustained wind speed as the big number at the top' }),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Show UV Index as the big number at the top' })).toBeInTheDocument();
        // Same word as the grid cell it pins.
        expect(screen.getByText('PERIOD')).toBeInTheDocument();
        expect(screen.queryByText('PER.')).toBeNull();
        expect(screen.getByText('BARO')).toBeInTheDocument();
        expect(screen.queryByText('HPA')).toBeNull();
    });

    it('names the pinned row for what it is, with a pressed state (UX scorecard run 7)', () => {
        const { rerender } = render(
            <MetricPinSheet visible currentMetric="temp" onPick={vi.fn()} onClose={vi.fn()} locationType="coastal" />,
        );
        // Not 'Reset to temperature' on the row that is already showing it.
        expect(screen.queryByRole('button', { name: 'Reset to temperature' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Temperature, pinned' })).toHaveAttribute('aria-pressed', 'true');
        expect(
            screen.getByRole('button', { name: 'Show sustained wind speed as the big number at the top' }),
        ).toHaveAttribute('aria-pressed', 'false');

        rerender(
            <MetricPinSheet visible currentMetric="wind" onPick={vi.fn()} onClose={vi.fn()} locationType="coastal" />,
        );
        // The pinned name starts with the row's visible label, 'WIND'.
        expect(screen.getByRole('button', { name: 'Wind, pinned — sustained wind speed' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(
            screen.getByRole('button', { name: 'Show air temperature as the big number at the top' }),
        ).toHaveAttribute('aria-pressed', 'false');
    });

    it('names the model sheet by its heading and gives every row one clause', () => {
        render(
            <ModelPickerSheet
                visible
                currentModel="best_match"
                onPick={vi.fn()}
                onClose={vi.fn()}
                onRefresh={vi.fn()}
            />,
        );
        const dialog = screen.getByRole('dialog', { name: 'Forecast model' });
        // A skipper's words, not a meteorologist's (UX scorecard run 7).
        expect(screen.getByText('ECMWF AI model — no gust forecast')).toBeInTheDocument();
        expect(screen.getByText('Japan — western Pacific, no gust forecast')).toBeInTheDocument();
        expect(screen.getByText('German global model — good with thunderstorms and squalls')).toBeInTheDocument();
        expect(dialog).not.toHaveTextContent(/gust field|convection|physics model/);
        // No 'ECMWF — ECMWF…' under the ECMWF row, and the clause after an
        // added dash continues in lower case like the rest.
        expect(screen.getByText('The main European global model')).toBeInTheDocument();
        expect(screen.getByText('UK Met Office — 10 km grid')).toBeInTheDocument();
        // No claim the app cannot back (UX scorecard run 9).
        expect(dialog).not.toHaveTextContent(/trusted|finest|best|professional/i);
        const helpers = dialog.querySelectorAll('button p + p');
        expect(helpers.length).toBeGreaterThan(3);
        for (const helper of helpers) {
            expect(helper.textContent!.split('—').length).toBeLessThanOrEqual(2);
            expect(helper.textContent).not.toMatch(/— [A-Z][a-z]/);
        }
        // Each grid model says how far ahead it reaches; blends do not.
        expect(screen.getByRole('button', { name: 'Use the ICON forecast model' })).toHaveTextContent('ICON · 7 days');
        expect(screen.getByRole('button', { name: 'Use the Auto forecast model' })).not.toHaveTextContent(/days/);
        // The credit keeps Météo-France on one line.
        expect(dialog.querySelector('span.whitespace-nowrap')?.textContent).toBe('Météo-France');
    });

    it('writes a one-line credit naming the model the Glass is showing', () => {
        expect(forecastCreditLine('dwd_icon')).toBe('Forecast: DWD ICON · CC BY 4.0');
        expect(forecastCreditLine('ecmwf_aifs025_single')).toBe('Forecast: ECMWF AIFS · CC BY 4.0');
        // UK Met Office open data is share-alike, not plain CC BY.
        expect(forecastCreditLine('ukmo_global_deterministic_10km')).toBe('Forecast: UK Met Office · CC BY-SA 4.0');
        // Blends credit every source, each under its own licence.
        // NOAA's data is a US Government work: public domain, not CC BY.
        expect(forecastCreditLine('best_match')).toMatch(
            /\(CC BY 4\.0\); UKMO \(CC BY-SA 4\.0\); NOAA \(public domain\)$/,
        );
        expect(forecastCreditLine('dwd_icon', 'sg')).toBe('Forecast: StormGlass blend');
        expect(forecastCreditLine('dwd_icon', 'ecmwf')).toBe('Forecast: ECMWF via StormGlass');
    });

    it('gives ModelPickerSheet an explicit close action and contains keyboard focus', () => {
        const onClose = vi.fn();
        render(
            <ModelPickerSheet
                visible
                currentModel="best_match"
                onPick={vi.fn()}
                onClose={onClose}
                onRefresh={vi.fn()}
            />,
        );
        const headerClose = screen.getByRole('button', { name: 'Close forecast model' });
        const close = screen.getByRole('button', { name: 'Close' });
        expect(headerClose).toHaveFocus();

        fireEvent.keyDown(headerClose, { key: 'Tab', shiftKey: true });
        expect(close).toHaveFocus();
        fireEvent.click(close);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
