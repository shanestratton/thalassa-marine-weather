import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShoreAlarmSnapshot } from '../services/ShoreWatchAlarmService';
import type { ShorePushReadiness } from '../services/AnchorWatchSyncService';

const mocks = vi.hoisted(() => ({
    watch: null as unknown as ShoreAlarmSnapshot,
    local: { state: 'idle' },
    push: { status: 'ready', reason: null, checkedAt: 1 } as ShorePushReadiness,
    shoreListeners: new Set<(snapshot: ShoreAlarmSnapshot) => void>(),
    localListeners: new Set<(snapshot: { state: string }) => void>(),
    pushListeners: new Set<(snapshot: ShorePushReadiness) => void>(),
    start: vi.fn(),
    stop: vi.fn(),
    mute: vi.fn(),
    retryAudio: vi.fn(),
    leaveSession: vi.fn(),
    stopBoatWatch: vi.fn(),
}));

vi.mock('../services/ShoreWatchAlarmService', () => ({
    ShoreWatchAlarmService: {
        getSnapshot: () => mocks.watch,
        subscribe: (listener: (snapshot: ShoreAlarmSnapshot) => void) => {
            mocks.shoreListeners.add(listener);
            listener(mocks.watch);
            return () => mocks.shoreListeners.delete(listener);
        },
        start: mocks.start,
        stop: mocks.stop,
        mute: mocks.mute,
        retryAudio: mocks.retryAudio,
    },
}));

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        getSnapshot: () => mocks.local,
        subscribe: (listener: (snapshot: { state: string }) => void) => {
            mocks.localListeners.add(listener);
            listener(mocks.local);
            return () => mocks.localListeners.delete(listener);
        },
        stopWatch: mocks.stopBoatWatch,
    },
}));

vi.mock('../services/AnchorWatchSyncService', () => ({
    AnchorWatchSyncService: {
        getPushReadiness: () => mocks.push,
        onPushReadinessChange: (listener: (snapshot: ShorePushReadiness) => void) => {
            mocks.pushListeners.add(listener);
            listener(mocks.push);
            return () => mocks.pushListeners.delete(listener);
        },
        leaveSession: mocks.leaveSession,
    },
}));

import { GlobalShoreWatchGate } from '../components/anchor-watch/GlobalShoreWatchGate';

function snapshot(overrides: Partial<ShoreAlarmSnapshot> = {}): ShoreAlarmSnapshot {
    return {
        sessionCode: 'ABCDEFGHJKLM',
        position: null,
        lastContactAt: Date.now(),
        stale: false,
        cause: null,
        muted: false,
        audioError: null,
        ...overrides,
    };
}

function emitWatch(patch: Partial<ShoreAlarmSnapshot>) {
    mocks.watch = { ...mocks.watch, ...patch };
    act(() => mocks.shoreListeners.forEach((listener) => listener(mocks.watch)));
}

function emitLocal(state: string) {
    mocks.local = { state };
    act(() => mocks.localListeners.forEach((listener) => listener(mocks.local)));
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.watch = snapshot();
    mocks.local = { state: 'idle' };
    mocks.push = { status: 'ready', reason: null, checkedAt: 1 };
    mocks.shoreListeners.clear();
    mocks.localListeners.clear();
    mocks.pushListeners.clear();
    mocks.mute.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('GlobalShoreWatchGate', () => {
    it('keeps routine status off the page without stopping monitoring', () => {
        const view = render(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        expect(view.container).toBeEmptyDOMElement();
        expect(mocks.start).toHaveBeenCalledOnce();
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(mocks.leaveSession).not.toHaveBeenCalled();
    });

    it('hides the status pill on the compass page and when there is no shore session', () => {
        const view = render(<GlobalShoreWatchGate showStatus={false} onOpen={vi.fn()} />);
        expect(view.container).toBeEmptyDOMElement();
        emitWatch({ sessionCode: null });
        view.rerender(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        expect(view.container).toBeEmptyDOMElement();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('leaves routine waiting and notification details to the information FAB', () => {
        const view = render(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        mocks.push = { status: 'unavailable', reason: 'Notifications denied', checkedAt: 1 };
        act(() => mocks.pushListeners.forEach((listener) => listener(mocks.push)));
        expect(view.container).toBeEmptyDOMElement();
        emitWatch({ stale: true });
        expect(view.container).toBeEmptyDOMElement();
    });

    it.each([
        ['drag', 'Vessel drag alarm'],
        ['contact-lost', 'Vessel contact lost'],
        ['gps-lost', 'Vessel GPS lost'],
        ['session-expiring', 'Shore Watch expiring'],
    ] as const)('portals an unmuted %s alarm even on the compass page', (cause, title) => {
        mocks.watch = snapshot({ cause });
        render(<GlobalShoreWatchGate showStatus={false} onOpen={vi.fn()} />);
        const dialog = screen.getByRole('alertdialog', { name: title });
        expect(dialog).toHaveAttribute('data-overlay-layer', 'critical');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(document.body).toContainElement(dialog);
        expect(screen.getByRole('button', { name: 'Silence this phone' })).toBeEnabled();
        expect(screen.getByText(/does not stop or silence the boat’s watchkeeper/)).toBeInTheDocument();
    });

    it('gives a local boat alarm priority, then reveals the still-active shore alarm', () => {
        mocks.watch = snapshot({ cause: 'drag' });
        mocks.local = { state: 'alarm' };
        render(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(mocks.mute).not.toHaveBeenCalled();
        emitLocal('watching');
        expect(screen.getByRole('alertdialog', { name: 'Vessel drag alarm' })).toBeInTheDocument();
        emitLocal('alarm');
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('retains a visible check-vessel status after a local mute without reopening the dialog', () => {
        mocks.watch = snapshot({ cause: 'drag', muted: true });
        const onOpen = vi.fn();
        render(<GlobalShoreWatchGate showStatus onOpen={onOpen} />);
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open active Shore Watch' })).toHaveTextContent('Check vessel');
        fireEvent.click(screen.getByRole('button', { name: 'Open active Shore Watch' }));
        expect(onOpen).toHaveBeenCalledOnce();
    });

    it('keeps the alarm visible and disables repeated silence clicks until the service confirms mute', async () => {
        mocks.watch = snapshot({ cause: 'drag' });
        let resolve!: () => void;
        const pending = new Promise<void>((done) => (resolve = done));
        mocks.mute.mockReturnValueOnce(pending);
        render(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Silence this phone' }));
        const busy = screen.getByRole('button', { name: 'Silencing…' });
        expect(busy).toBeDisabled();
        fireEvent.click(busy);
        expect(mocks.mute).toHaveBeenCalledOnce();
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();

        await act(async () => {
            resolve();
            await pending;
        });
        // A settled request alone is not evidence that the service muted it.
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        emitWatch({ muted: true });
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(mocks.stopBoatWatch).not.toHaveBeenCalled();
        expect(mocks.leaveSession).not.toHaveBeenCalled();
    });

    it('keeps an unsuccessful silence actionable and lets the user retry', async () => {
        mocks.watch = snapshot({ cause: 'drag' });
        mocks.mute.mockRejectedValueOnce(new Error('Native audio did not stop'));
        render(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Silence this phone' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not silence the alarm. Please retry.');
        const retry = screen.getByRole('button', { name: 'Silence this phone' });
        await waitFor(() => expect(retry).toBeEnabled());
        fireEvent.click(retry);
        await waitFor(() => expect(mocks.mute).toHaveBeenCalledTimes(2));
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('exposes failed audio and delegates sound retry to the app service', () => {
        mocks.watch = snapshot({ cause: 'contact-lost', audioError: 'The alarm could not sound.' });
        render(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        expect(screen.getByRole('alert')).toHaveTextContent('The alarm could not sound.');
        fireEvent.click(screen.getByRole('button', { name: 'Retry alarm sound' }));
        expect(mocks.retryAudio).toHaveBeenCalledOnce();
    });

    it('unsubscribes UI on unmount without silencing, leaving, or stopping the app service', () => {
        mocks.watch = snapshot({ cause: 'drag' });
        const view = render(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        expect(mocks.shoreListeners.size).toBeGreaterThan(0);
        view.unmount();
        expect(mocks.shoreListeners.size).toBe(0);
        expect(mocks.localListeners.size).toBe(0);
        expect(mocks.pushListeners.size).toBe(0);
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(mocks.mute).not.toHaveBeenCalled();
        expect(mocks.leaveSession).not.toHaveBeenCalled();
        expect(mocks.stopBoatWatch).not.toHaveBeenCalled();
        render(<GlobalShoreWatchGate showStatus onOpen={vi.fn()} />);
        expect(screen.getByRole('alertdialog', { name: 'Vessel drag alarm' })).toBeInTheDocument();
    });
});
