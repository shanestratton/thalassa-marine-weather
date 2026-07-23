import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForecastSheet } from '../components/ForecastSheet';
import { ShoreWatchModal } from '../components/anchor-watch/ShoreWatchModal';
import { SoundCheckModal } from '../components/anchor-watch/SoundCheckModal';
import { DepartureSweepSheet } from '../components/passage/DepartureSweepSheet';
import { DepartureWindowSheet } from '../components/passage/DepartureWindowSheet';
import { WatchAssignSheet } from '../components/passage/WatchAssignSheet';

afterEach(() => {
    vi.useRealTimers();
});

describe('safety-critical dialog accessibility', () => {
    it('makes the forecast content the dialog and restores focus after its animated Escape close', () => {
        vi.useFakeTimers();
        const onClose = vi.fn();
        const units = { speed: 'kts', length: 'm', waveHeight: 'm', temp: 'C', distance: 'nm' } as const;
        const { rerender } = render(
            <>
                <button>Open forecast</button>
                <ForecastSheet
                    data={null}
                    isLoading={false}
                    units={units}
                    isOpen={false}
                    onClose={onClose}
                    onViewFull={vi.fn()}
                />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Open forecast' });
        opener.focus();

        rerender(
            <>
                <button>Open forecast</button>
                <ForecastSheet
                    data={null}
                    isLoading={false}
                    units={units}
                    isOpen
                    onClose={onClose}
                    onViewFull={vi.fn()}
                />
            </>,
        );
        const dialog = screen.getByRole('dialog', { name: 'Weather forecast summary' });
        const close = screen.getByRole('button', { name: 'Close forecast sheet' });
        expect(dialog).toContainElement(close);
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Escape' });
        act(() => vi.advanceTimersByTime(300));
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Open forecast</button>
                <ForecastSheet
                    data={null}
                    isLoading={false}
                    units={units}
                    isOpen={false}
                    onClose={onClose}
                    onViewFull={vi.fn()}
                />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('contains and restores focus for remote shore watch', () => {
        const onClose = vi.fn();
        const { rerender } = render(<button>Open shore watch</button>);
        const opener = screen.getByRole('button', { name: 'Open shore watch' });
        opener.focus();

        rerender(
            <>
                <button>Open shore watch</button>
                <ShoreWatchModal sessionCode="" onSessionCodeChange={vi.fn()} onJoin={vi.fn()} onClose={onClose} />
            </>,
        );
        const input = screen.getByRole('textbox', { name: '12-character session code' });
        const close = screen.getByRole('button', { name: 'Close shore watch modal' });
        expect(screen.getByRole('dialog', { name: 'Shore Watch' })).toContainElement(input);
        expect(input).toHaveFocus();

        fireEvent.keyDown(input, { key: 'Tab' });
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Open shore watch</button>);
        expect(opener).toHaveFocus();
    });

    it('defaults the anchor sound check to the safe cancel action and traps focus', () => {
        const onCancel = vi.fn();
        render(<SoundCheckModal onConfirm={vi.fn()} onCancel={onCancel} />);
        const cancel = screen.getByRole('button', { name: 'Cancel this action' });
        const confirm = screen.getByRole('button', { name: 'Confirm selection' });
        expect(cancel).toHaveFocus();

        fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
        expect(confirm).toHaveFocus();
        fireEvent.keyDown(confirm, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('contains both departure-planning sheets and closes them with Escape', () => {
        const closeSweep = vi.fn();
        const { unmount } = render(
            <DepartureSweepSheet open onClose={closeSweep} voyagePlan={null} vessel={null} onAccept={vi.fn()} />,
        );
        const sweepClose = screen.getByRole('button', { name: 'Close' });
        expect(screen.getByRole('dialog', { name: 'Inshore Departure Sweep' })).toContainElement(sweepClose);
        expect(sweepClose).toHaveFocus();
        fireEvent.keyDown(sweepClose, { key: 'Escape' });
        expect(closeSweep).toHaveBeenCalledOnce();
        unmount();

        const closeWindow = vi.fn();
        render(
            <DepartureWindowSheet
                open
                onClose={closeWindow}
                planning={false}
                scenarios={[]}
                progressLabel={null}
                onAccept={vi.fn()}
                origin="Brisbane"
                destination="Moreton"
            />,
        );
        const windowClose = screen.getByRole('button', { name: 'Close' });
        expect(screen.getByRole('dialog', { name: 'Departure Window' })).toContainElement(windowClose);
        expect(windowClose).toHaveFocus();
        fireEvent.keyDown(windowClose, { key: 'Escape' });
        expect(closeWindow).toHaveBeenCalledOnce();
    });

    it('contains watch assignment and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(<button>Open watch assignment</button>);
        const opener = screen.getByRole('button', { name: 'Open watch assignment' });
        opener.focus();

        rerender(
            <>
                <button>Open watch assignment</button>
                <WatchAssignSheet
                    open
                    onClose={onClose}
                    watchLabel="First watch"
                    watchTimeLabel="20:00–00:00"
                    currentEmail={null}
                    crew={[]}
                    skipperEmail="shane@example.com"
                    skipperName="Shane"
                    onAssign={vi.fn()}
                />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close' });
        expect(screen.getByRole('dialog', { name: 'Assign Watch' })).toContainElement(close);
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(<button>Open watch assignment</button>);
        expect(opener).toHaveFocus();
    });
});
