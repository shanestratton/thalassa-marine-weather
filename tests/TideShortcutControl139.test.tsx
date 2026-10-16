import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TideShortcutControl } from '../components/passage/TideShortcutControl';
import type { TideShortcutView } from '../services/routing/tideGatedPlanning';
function Harness({ review = null }: { review?: TideShortcutView | null }) {
    const [enabled, setEnabled] = useState(false),
        [bufferMinutes, setBufferMinutes] = useState(15);
    return <TideShortcutControl {...{ enabled, setEnabled, bufferMinutes, setBufferMinutes, review }} />;
}
describe('explicit tide shortcut control', () => {
    it('starts off and requires an explicit opt-in without changing the existing buffer', () => {
        render(<Harness />);
        const control = screen.getByTestId('tide-shortcut-control');
        expect(control).not.toHaveAttribute('open');
        expect(screen.getByRole('checkbox', { hidden: true })).not.toBeChecked();
        fireEvent.click(screen.getByText('Tide windows · off'));
        fireEvent.click(screen.getByRole('checkbox'));
        expect(screen.getByRole('checkbox')).toBeChecked();
        expect(screen.getByLabelText('Tide shortcut arrival buffer in minutes')).toHaveValue(15);
        expect(control).toHaveTextContent('No automatic wait or departure change.');
    });
    it('accepts a bounded whole-minute uncertainty and ignores incomplete/out-of-range values', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('checkbox', { hidden: true }));
        const input = screen.getByLabelText('Tide shortcut arrival buffer in minutes');
        for (const value of ['0', '61', '1.5', '']) {
            fireEvent.change(input, { target: { value } });
            expect(input).toHaveValue(15);
        }
        fireEvent.change(input, { target: { value: '30' } });
        expect(input).toHaveValue(30);
    });
    it('states the real missing evidence and keeps informational source limits visible', () => {
        render(<Harness review={{ kind: 'held', reason: 'The exact original chart-datum tie is missing.' }} />);
        fireEvent.click(screen.getByRole('checkbox', { hidden: true }));
        expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('chart-datum tie is missing');
        expect(screen.getByTestId('tide-shortcut-control')).toHaveTextContent(
            'WorldTides has no reviewed navigation permission',
        );
    });
    it('describes a timed result as a temporary preview with actions held', () => {
        const t = Date.parse('2026-10-17T01:00:00Z');
        render(
            <Harness
                review={{
                    kind: 'preview',
                    departureMs: t,
                    arrivalMs: t + 123456,
                    expiresAtMs: t + 300000,
                    speedKts: 6,
                    uncertaintyMs: 900000,
                    sourceSummary: 'Fictional independently reviewed source',
                }}
            />,
        );
        fireEvent.click(screen.getByRole('checkbox', { hidden: true }));
        expect(screen.getByRole('status', { hidden: true })).toHaveTextContent(
            'Save, export and departure actions remain held',
        );
        expect(screen.getByTestId('tide-shortcut-control')).toHaveTextContent(
            'Fictional independently reviewed source',
        );
    });
});
