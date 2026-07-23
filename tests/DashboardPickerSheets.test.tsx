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

    it('gives ModelPickerSheet an explicit close action and contains keyboard focus', () => {
        const onClose = vi.fn();
        render(<ModelPickerSheet visible currentModel="auto" onPick={vi.fn()} onClose={onClose} onRefresh={vi.fn()} />);
        const firstModel = screen.getAllByRole('button', { name: /forecast model$/ })[0];
        const close = screen.getByRole('button', { name: 'Close' });
        expect(firstModel).toHaveFocus();

        fireEvent.keyDown(firstModel, { key: 'Tab', shiftKey: true });
        expect(close).toHaveFocus();
        fireEvent.click(close);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
