import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassageDepartureModal, parsePassageLocalDeparture } from '../components/passage/PassageDepartureModal';
import { PASSAGE_DEPARTURE_MAX_MS } from '../services/passageDeparture';
import type { PassageDepartureSuggestionState } from '../services/passageDepartureSuggestion';

const NOW = new Date(2026, 8, 21, 10, 30).getTime();
const suggestion: PassageDepartureSuggestionState = {
    status: 'ready',
    suggestion: {
        departureMs: NOW + 24 * 3_600_000,
        windowStartMs: NOW + 24 * 3_600_000,
        windowEndMs: NOW + 24 * 3_600_000,
        windowDepartures: 1,
        approximateStart: true,
        uncheckedJoinNm: 0.02,
        modelLabel: 'ECMWF',
        cruiseKts: 6.2,
        durationMs: 5 * 3_600_000,
        maxWindKts: 12.4,
        maxGustKts: 18.1,
        maxWaveM: null,
        maxHeadwindKts: 4,
        gustComplete: true,
        waveComplete: false,
        windOnly: true,
        gustsRanked: true,
        spreadLevel: 'some',
        limits: { maxWindKts: 20, maxGustKts: 25 },
        sampleCount: 8,
        comparedDepartures: 37,
    },
};
const localDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const localTime = (date: Date) =>
    `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

function chooseTime(timestamp: number) {
    fireEvent.click(screen.getByRole('button', { name: 'Choose a time' }));
    fireEvent.change(screen.getByLabelText('Departure date'), { target: { value: localDate(new Date(timestamp)) } });
    fireEvent.change(screen.getByLabelText('Departure time'), { target: { value: localTime(new Date(timestamp)) } });
}

describe('PassageDepartureModal', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('defaults to Leave now and submits null, not the time the modal opened', () => {
        const onConfirm = vi.fn();
        render(
            <PassageDepartureModal
                visible
                onClose={vi.fn()}
                onConfirm={onConfirm}
                routeName="Newport → Mooloolaba"
                cruiseKts={6.2}
            />,
        );
        expect(screen.getByRole('dialog', { name: 'When will you leave?' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Leave now' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('Newport → Mooloolaba')).toBeInTheDocument();
        expect(screen.getByText('6.2 kn cruise')).toBeInTheDocument();
        expect(screen.getByText(/Device local time/)).toHaveTextContent(
            Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        act(() => vi.setSystemTime(NOW + 6 * 3_600_000));
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(onConfirm).toHaveBeenCalledWith(null);
    });

    it('submits native date and time in the device-local time zone without starting on edit', () => {
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} />);
        const departure = new Date(2026, 8, 23, 8, 45).getTime();
        chooseTime(departure);
        expect(onConfirm).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(onConfirm).toHaveBeenCalledWith(departure);
    });

    it('offers tomorrow without confirming until Preview passage', () => {
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} />);
        fireEvent.click(screen.getByRole('button', { name: 'Choose a time' }));
        fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
        expect(screen.getByLabelText('Departure date')).toHaveValue('2026-09-22');
        expect(onConfirm).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(onConfirm).toHaveBeenCalledWith(new Date(2026, 8, 22, 10, 30).getTime());
    });

    it.each([
        [NOW - 60_000, /departure has passed/],
        [NOW + PASSAGE_DEPARTURE_MAX_MS + 60_000, /within the next five days/],
    ])('rejects an out-of-range time (%s) without silently clamping the fields', (timestamp, message) => {
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} />);
        chooseTime(timestamp);
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(screen.getByRole('alert')).toHaveTextContent(message);
        expect(screen.getByLabelText('Departure date')).toHaveValue(localDate(new Date(timestamp)));
        expect(screen.getByLabelText('Departure time')).toHaveValue(localTime(new Date(timestamp)));
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('accepts exactly 120 hours ahead, while keeping the native date bounds visible', () => {
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} />);
        chooseTime(NOW + PASSAGE_DEPARTURE_MAX_MS);
        expect(screen.getByLabelText('Departure date')).toHaveAttribute('min', '2026-09-21');
        expect(screen.getByLabelText('Departure date')).toHaveAttribute('max', '2026-09-26');
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(onConfirm).toHaveBeenCalledWith(NOW + PASSAGE_DEPARTURE_MAX_MS);
    });

    it('checks the rolling clock again on submission of an old open dialog', () => {
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} departureMs={NOW + 60_000} />);
        act(() => vi.setSystemTime(NOW + 120_000));
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(screen.getByRole('alert')).toHaveTextContent('That departure has passed');
        expect(onConfirm).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Leave now' }));
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(onConfirm).toHaveBeenCalledWith(null);
    });

    it('preserves a supplied exact departure unless a field is edited', () => {
        const onConfirm = vi.fn();
        const departure = NOW + 3_600_123;
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} departureMs={departure} />);
        expect(screen.getByRole('button', { name: 'Choose a time' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(onConfirm).toHaveBeenCalledWith(departure);
    });

    it('shows a validation error for missing fields and a non-finite supplied date', () => {
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} departureMs={NaN} />);
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(screen.getByRole('alert')).toHaveTextContent('Choose a valid local date and time');
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it.each(['Cancel', 'Close departure picker', 'Escape'])('dismisses with %s without confirming', (control) => {
        const onClose = vi.fn();
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={onClose} onConfirm={onConfirm} />);
        if (control === 'Escape') fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        else fireEvent.click(screen.getByRole('button', { name: control }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('traps focus, restores the opener, and discards an abandoned draft on reopening', () => {
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        const props = { onClose: vi.fn(), onConfirm: vi.fn() };
        const { rerender } = render(<PassageDepartureModal {...props} visible />);
        expect(screen.getByRole('button', { name: 'Close departure picker' })).toHaveFocus();
        screen.getByRole('button', { name: 'Preview passage' }).focus();
        fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
        expect(screen.getByRole('button', { name: 'Close departure picker' })).toHaveFocus();
        chooseTime(NOW + 3_600_000);
        rerender(<PassageDepartureModal {...props} visible={false} />);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
        rerender(<PassageDepartureModal {...props} visible />);
        expect(screen.getByRole('button', { name: 'Leave now' })).toHaveAttribute('aria-pressed', 'true');
        opener.remove();
    });

    it('contains backdrop and field interactions rather than passing them through to the map', () => {
        const mapClick = vi.fn();
        const mapPointer = vi.fn();
        const mapWheel = vi.fn();
        const onClose = vi.fn();
        render(
            <div onClick={mapClick} onPointerDown={mapPointer} onWheel={mapWheel}>
                <PassageDepartureModal visible onClose={onClose} onConfirm={vi.fn()} />
            </div>,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Choose a time' }));
        fireEvent.pointerDown(screen.getByLabelText('Departure date'));
        fireEvent.wheel(screen.getByRole('dialog'));
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('presentation'));
        expect(onClose).toHaveBeenCalledOnce();
        expect(mapClick).not.toHaveBeenCalled();
        expect(mapPointer).not.toHaveBeenCalled();
        expect(mapWheel).not.toHaveBeenCalled();
    });

    it('shows model, maxima, limits and incomplete sea coverage; Use this time only fills the form', () => {
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} suggestion={suggestion} />);
        expect(screen.getByRole('region', { name: 'Suggested forecast window' })).toBeInTheDocument();
        expect(screen.getByText('ECMWF · 6.2 kn cruise')).toBeInTheDocument();
        expect(screen.getByText(/Sampled max wind 12.4 kn · gust 18.1 kn/)).toBeInTheDocument();
        expect(screen.getByText(/Approximate start · ~37 m unchecked joining leg/)).toBeInTheDocument();
        expect(screen.getByText(/Wind-only comparison/)).toBeInTheDocument();
        expect(screen.getByText(/Your limits: wind 20 kn · gust 25 kn/)).toBeInTheDocument();
        expect(screen.getByText('Models disagree')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Use this time' }));
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Departure date')).toHaveValue('2026-09-22');
        expect(screen.getByLabelText('Departure time')).toHaveValue('10:30');
        fireEvent.click(screen.getByRole('button', { name: 'Preview passage' }));
        expect(onConfirm).toHaveBeenCalledWith(NOW + 24 * 3_600_000);
    });

    it('puts the departure controls and local time zone before the suggestion card', () => {
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={vi.fn()} suggestion={suggestion} />);
        const card = screen.getByRole('region', { name: 'Suggested forecast window' });
        expect(
            screen.getByText('Start from the current time').compareDocumentPosition(card) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Choose a time' }));
        for (const control of [
            screen.getByLabelText('Departure date'),
            screen.getByLabelText('Departure time'),
            screen.getByText(/Device local time/),
        ]) {
            expect(control.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
    });

    it('keeps the summary and caveats visible while comparison methodology starts collapsed', () => {
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={vi.fn()} suggestion={suggestion} />);
        const summary = screen.getByText('Forecast comparison details');
        const details = summary.closest('details')!;
        expect(details).not.toHaveAttribute('open');
        expect(screen.getByText(/Your limits: wind 20 kn/)).not.toBeVisible();
        expect(screen.getByText(/Approximate start/)).not.toBeVisible();
        expect(screen.getByText(/37 hourly departures ranked/)).not.toBeVisible();
        expect(screen.getByText('Wind-only comparison')).toBeVisible();
        expect(screen.getByText('Models disagree')).toBeVisible();
        expect(screen.getByText('Forecast comparison, not a safety clearance.')).toBeVisible();
        expect(screen.getByRole('button', { name: 'Use this time' })).toBeVisible();
        fireEvent.click(summary);
        expect(details).toHaveAttribute('open');
        expect(screen.getByText(/Your limits: wind 20 kn/)).toBeVisible();
        expect(screen.getByText(/Approximate start/)).toBeVisible();
        expect(screen.getByText(/37 hourly departures ranked/)).toBeVisible();
    });

    it.each([
        [{ status: 'loading' }, /Comparing departure forecasts/],
        [
            { status: 'unavailable', reason: 'coverage', message: 'Insufficient forecast coverage.' },
            /Insufficient forecast coverage/,
        ],
    ] as const)('keeps a non-actionable suggestion state informational (%j)', (state, message) => {
        const onConfirm = vi.fn();
        render(<PassageDepartureModal visible onClose={vi.fn()} onConfirm={onConfirm} suggestion={state} />);
        expect(screen.getByRole('status')).toHaveTextContent(message);
        expect(screen.queryByRole('button', { name: 'Use this time' })).not.toBeInTheDocument();
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Preview passage' })).toBeEnabled();
    });
});

describe('parsePassageLocalDeparture', () => {
    it('parses local wall time and rejects invalid or overflowing values', () => {
        expect(parsePassageLocalDeparture('2026-09-23', '08:45')).toBe(new Date(2026, 8, 23, 8, 45).getTime());
        for (const [date, time] of [
            ['', '08:00'],
            ['2026-02-30', '08:00'],
            ['2026-13-01', '08:00'],
            ['2026-09-23', '24:00'],
            ['2026-09-23', '08:60'],
            ['2026-09-23', '8:00'],
        ]) {
            expect(parsePassageLocalDeparture(date, time)).toBeNull();
        }
    });
});
