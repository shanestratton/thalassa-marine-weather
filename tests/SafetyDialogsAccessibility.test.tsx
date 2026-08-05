import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const notificationMocks = vi.hoisted(() => ({
    checkPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
    requestPermissions: vi.fn().mockResolvedValue({ display: 'granted' }),
}));

vi.mock('@capacitor/local-notifications', () => ({
    LocalNotifications: {
        checkPermissions: notificationMocks.checkPermissions,
        requestPermissions: notificationMocks.requestPermissions,
    },
}));

const anchorNotificationMocks = vi.hoisted(() => ({
    requireReadiness: vi.fn().mockResolvedValue({
        ready: true,
        authorizationStatus: 'authorized',
        timeSensitiveEnabled: true,
        lockScreenEnabled: true,
        availableSlots: 21,
    }),
}));

vi.mock('../services/AnchorSafetyNotificationService', () => ({
    AnchorSafetyNotificationService: anchorNotificationMocks,
}));

import { ForecastSheet } from '../components/ForecastSheet';
import { ShoreWatchModal } from '../components/anchor-watch/ShoreWatchModal';
import { SoundCheckModal } from '../components/anchor-watch/SoundCheckModal';
import { DepartureSweepSheet } from '../components/passage/DepartureSweepSheet';
import { DepartureWindowSheet } from '../components/passage/DepartureWindowSheet';
import { WatchAssignSheet } from '../components/passage/WatchAssignSheet';
import { AlarmAudioService } from '../services/AlarmAudioService';
import { Capacitor } from '@capacitor/core';

afterEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    notificationMocks.checkPermissions.mockReset().mockResolvedValue({ display: 'granted' });
    notificationMocks.requestPermissions.mockReset().mockResolvedValue({ display: 'granted' });
    anchorNotificationMocks.requireReadiness.mockReset().mockResolvedValue({
        ready: true,
        authorizationStatus: 'authorized',
        timeSensitiveEnabled: true,
        lockScreenEnabled: true,
        availableSlots: 21,
    });
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

    it('defaults the anchor sound check to the safe cancel action and traps focus', async () => {
        const onCancel = vi.fn();
        render(<SoundCheckModal onConfirm={vi.fn()} onCancel={onCancel} />);
        const cancel = screen.getByRole('button', { name: 'Cancel this action' });
        const confirm = screen.getByRole('button', { name: 'Confirm selection' });
        expect(cancel).toHaveFocus();

        const alarmTest = screen.getByRole('button', { name: 'Play test alarm' });
        expect(confirm).toBeDisabled();
        alarmTest.focus();
        fireEvent.keyDown(alarmTest, { key: 'Tab', shiftKey: true });
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: 'Escape' });
        await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    });

    it('runs a genuine alarm-service test and states the browser limitation plainly', async () => {
        const start = vi.spyOn(AlarmAudioService, 'acquire').mockResolvedValue('sound-check-lease');
        const stop = vi.spyOn(AlarmAudioService, 'release').mockResolvedValue(undefined);
        render(<SoundCheckModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

        expect(
            screen.getByText(/Browser audio and GPS cannot be relied on after the screen locks/i),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Play test alarm' }));

        await waitFor(() => expect(start).toHaveBeenCalledWith('anchor-sound-check'));
        const stopButton = await screen.findByRole('button', { name: 'Stop test alarm' });
        fireEvent.click(stopButton);
        await waitFor(() => expect(stop).toHaveBeenCalledWith('sound-check-lease'));
        expect(screen.getByRole('status')).toHaveTextContent('Only continue if the alarm was loud and clear');
        expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: 'Confirm alarm was audible' }));
        expect(screen.getByRole('status')).toHaveTextContent('Alarm heard and confirmed');
        expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeEnabled();

        start.mockRestore();
        stop.mockRestore();
    });

    it('keeps a failed sound-check release visible and retryable before cancelling', async () => {
        const start = vi.spyOn(AlarmAudioService, 'acquire').mockResolvedValue('sound-check-retry-lease');
        const stop = vi
            .spyOn(AlarmAudioService, 'release')
            .mockRejectedValueOnce(new Error('native stop failed'))
            .mockRejectedValueOnce(new Error('native stop still failed'))
            .mockResolvedValueOnce(undefined);
        const onCancel = vi.fn();
        const { unmount } = render(<SoundCheckModal onConfirm={vi.fn()} onCancel={onCancel} />);

        fireEvent.click(screen.getByRole('button', { name: 'Play test alarm' }));
        await screen.findByRole('button', { name: 'Stop test alarm' });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel this action' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('alarm may still be sounding');
        expect(onCancel).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Retry stopping alarm and cancel' }));
        await waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
        expect(onCancel).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Retry stopping alarm and cancel' })).toBeEnabled();

        fireEvent.click(screen.getByRole('button', { name: 'Retry stopping alarm and cancel' }));
        await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
        expect(stop).toHaveBeenNthCalledWith(1, 'sound-check-retry-lease');
        expect(stop).toHaveBeenNthCalledWith(2, 'sound-check-retry-lease');
        expect(stop).toHaveBeenNthCalledWith(3, 'sound-check-retry-lease');

        unmount();
        start.mockRestore();
        stop.mockRestore();
    });

    it('adopts a late sound-check lease and keeps its failed cleanup retryable', async () => {
        let resolveAcquire!: (lease: string) => void;
        const pendingAcquire = new Promise<string>((resolve) => {
            resolveAcquire = resolve;
        });
        const start = vi.spyOn(AlarmAudioService, 'acquire').mockReturnValue(pendingAcquire);
        const stop = vi
            .spyOn(AlarmAudioService, 'release')
            .mockRejectedValueOnce(new Error('late native stop failed'))
            .mockResolvedValueOnce(undefined);
        const onCancel = vi.fn();
        const { unmount } = render(<SoundCheckModal onConfirm={vi.fn()} onCancel={onCancel} />);

        fireEvent.click(screen.getByRole('button', { name: 'Play test alarm' }));
        await waitFor(() => expect(start).toHaveBeenCalledWith('anchor-sound-check'));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel this action' }));
        expect(screen.getByRole('button', { name: 'Cancel this action' })).toBeDisabled();
        expect(stop).not.toHaveBeenCalled();

        await act(async () => {
            resolveAcquire('late-sound-check-lease');
            await pendingAcquire;
        });

        expect(await screen.findByRole('alert')).toHaveTextContent('alarm may still be sounding');
        expect(stop).toHaveBeenCalledWith('late-sound-check-lease');
        expect(onCancel).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Retry stopping alarm and cancel' }));
        await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
        expect(stop).toHaveBeenCalledTimes(2);

        unmount();
        start.mockRestore();
        stop.mockRestore();
    });

    it('hands a lease that resolves after external unmount to owner-scoped cleanup', async () => {
        let resolveAcquire!: (lease: string) => void;
        const pendingAcquire = new Promise<string>((resolve) => {
            resolveAcquire = resolve;
        });
        const start = vi.spyOn(AlarmAudioService, 'acquire').mockReturnValue(pendingAcquire);
        const releaseEventually = vi.spyOn(AlarmAudioService, 'releaseEventually').mockImplementation(() => undefined);
        const { unmount } = render(<SoundCheckModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Play test alarm' }));
        await waitFor(() => expect(start).toHaveBeenCalledWith('anchor-sound-check'));
        unmount();

        resolveAcquire('detached-late-sound-check-lease');
        await waitFor(() => expect(releaseEventually).toHaveBeenCalledWith('detached-late-sound-check-lease'));

        start.mockRestore();
        releaseEventually.mockRestore();
    });

    it('blocks Drop Anchor when native notification permission is denied', async () => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        notificationMocks.checkPermissions.mockResolvedValueOnce({ display: 'denied' });
        const onConfirm = vi.fn();

        render(<SoundCheckModal onConfirm={onConfirm} onCancel={vi.fn()} />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Notifications are off');
        const confirm = screen.getByRole('button', { name: 'Confirm selection' });
        expect(confirm).toBeDisabled();
        fireEvent.click(confirm);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.getByText(/must be verified before Anchor Watch can start/i)).toBeInTheDocument();
    });

    it('blocks Drop Anchor when native notification readiness cannot be verified', async () => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        anchorNotificationMocks.requireReadiness.mockRejectedValueOnce(new Error('Lock Screen alerts are disabled'));

        render(<SoundCheckModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Lock Screen alerts are disabled');
        expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeDisabled();
    });

    it('contains both departure-planning sheets and closes them with Escape', () => {
        const closeSweep = vi.fn();
        const { unmount } = render(
            <DepartureSweepSheet open onClose={closeSweep} voyagePlan={null} vessel={null} onAccept={vi.fn()} />,
        );
        const sweepClose = screen.getByRole('button', { name: 'Close' });
        const sweepDialog = screen.getByRole('dialog', { name: 'Inshore Departure Sweep' });
        expect(sweepDialog).toContainElement(sweepClose);
        expect(sweepDialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
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
                progressLabel={undefined}
                onAccept={vi.fn()}
                origin="Brisbane"
                destination="Moreton"
            />,
        );
        const windowClose = screen.getByRole('button', { name: 'Close' });
        const windowDialog = screen.getByRole('dialog', { name: 'Departure Window' });
        expect(windowDialog).toContainElement(windowClose);
        expect(windowDialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
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
