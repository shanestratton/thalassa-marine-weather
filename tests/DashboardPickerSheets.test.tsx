import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MetricPinSheet } from '../components/dashboard/MetricPinSheet';
import { ModelPickerSheet } from '../components/dashboard/ModelPickerSheet';

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
        const first = screen.getByRole('button', { name: 'Reset to temperature' });
        const close = screen.getByRole('button', { name: 'Close pin a metric sheet' });
        expect(first).toHaveFocus();

        fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
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
        expect(screen.getByText('ECMWF AI model — no gust field')).toBeInTheDocument();
        expect(screen.getByText('Japan — western Pacific, no gust field')).toBeInTheDocument();
        const helpers = dialog.querySelectorAll('button p + p');
        expect(helpers.length).toBeGreaterThan(3);
        for (const helper of helpers) {
            expect(helper.textContent!.split('—').length).toBeLessThanOrEqual(2);
        }
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
        const firstModel = screen.getAllByRole('button', { name: /forecast model$/ })[0];
        const close = screen.getByRole('button', { name: 'Close' });
        expect(firstModel).toHaveFocus();

        fireEvent.keyDown(firstModel, { key: 'Tab', shiftKey: true });
        expect(close).toHaveFocus();
        fireEvent.click(close);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
