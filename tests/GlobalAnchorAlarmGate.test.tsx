/**
 * GlobalAnchorAlarmGate — app-level anchor-alarm mount (2026-08-03
 * life-safety module).
 *
 * Pins:
 *  - the gate renders NOTHING unless snapshot.state === 'alarm'
 *  - the moment state hits 'alarm' it portals the real AnchorAlarmOverlay
 *    over whatever page is showing (critical z-layer, alertdialog)
 *  - mounted mid-alarm (app relaunch), the overlay is up on first paint
 *  - Silence routes to AnchorWatchService.acknowledgeAlarm
 *  - the alarm resolving clears the overlay; unmount unsubscribes
 *  - build 125 (125-03): a drag alarm offers Move anchor, which opens the
 *    Move anchor sheet in alarm mode over the alarm; never for a GPS-lost
 *    alarm, nor while the boat's Pi keeps the watch
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalAnchorAlarmGate } from '../components/anchor-watch/GlobalAnchorAlarmGate';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';

const mocks = vi.hoisted(() => {
    const listeners = new Set<(snap: unknown) => void>();
    const state = { snapshot: null as unknown };
    return {
        listeners,
        state,
        // Mirrors the real service contract: subscribe fires the listener
        // immediately with the current snapshot and returns an unsubscriber.
        subscribe: vi.fn((listener: (snap: unknown) => void) => {
            listeners.add(listener);
            listener(state.snapshot);
            return () => listeners.delete(listener);
        }),
        getSnapshot: vi.fn(() => state.snapshot),
        acknowledgeAlarm: vi.fn(),
        piKeeping: false,
        toastSuccess: vi.fn(),
    };
});

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        subscribe: mocks.subscribe,
        getSnapshot: mocks.getSnapshot,
        acknowledgeAlarm: mocks.acknowledgeAlarm,
    },
}));

vi.mock('../services/anchorPiWatchKeeper', () => ({
    AnchorPiWatchKeeper: { isKeeping: () => mocks.piKeeping, keepingSessionCode: () => null },
}));

vi.mock('../components/Toast', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));

// The sheet itself has its own suite (MoveAnchorSheet.test.tsx). Here it is a
// stand-in that shows which mode the gate opened it in and lets the test
// finish or cancel it.
vi.mock('../components/anchor-watch/MoveAnchorSheet', () => ({
    MoveAnchorSheet: (props: { mode?: string; onClose: () => void; onMoved?: () => void }) => (
        <div role="dialog" aria-label="Move anchor" data-mode={props.mode ?? 'watch'}>
            <button type="button" onClick={props.onClose}>
                Cancel
            </button>
            <button type="button" onClick={() => props.onMoved?.()}>
                Finish the move
            </button>
        </div>
    ),
}));

function snap(over: Partial<AnchorWatchSnapshot> = {}): AnchorWatchSnapshot {
    return {
        state: 'watching',
        anchorPosition: { latitude: -27, longitude: 153, timestamp: 1_000 },
        vesselPosition: null,
        swingRadius: 30,
        distanceFromAnchor: 12,
        maxDistanceRecorded: 14,
        bearingToAnchor: 90,
        config: { rodeLength: 40, waterDepth: 5, scopeRatio: 5, rodeType: 'chain', safetyMargin: 10 },
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: 1_000,
        gpsAccuracy: 5,
        gpsQuality: 'precision',
        gpsQualityLabel: 'Precision GPS',
        guardianStatus: 'idle',
        setupError: null,
        ...over,
    };
}

function alarmSnap(over: Partial<AnchorWatchSnapshot> = {}): AnchorWatchSnapshot {
    return snap({
        state: 'alarm',
        alarmTriggeredAt: 9_000,
        alarmCause: 'drag',
        distanceFromAnchor: 55,
        maxDistanceRecorded: 55,
        ...over,
    });
}

function emitSnapshot(next: AnchorWatchSnapshot) {
    mocks.state.snapshot = next;
    act(() => {
        for (const listener of [...mocks.listeners]) listener(next);
    });
}

beforeEach(() => {
    mocks.listeners.clear();
    mocks.state.snapshot = snap({ state: 'idle', anchorPosition: null });
    mocks.subscribe.mockClear();
    mocks.getSnapshot.mockClear();
    mocks.acknowledgeAlarm.mockClear();
    mocks.toastSuccess.mockClear();
    mocks.piKeeping = false;
});

afterEach(() => {
    cleanup();
});

describe('GlobalAnchorAlarmGate', () => {
    it('renders nothing through every non-alarm state', () => {
        const { container } = render(<GlobalAnchorAlarmGate />);
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

        for (const state of ['setting', 'watching', 'paused', 'idle'] as const) {
            emitSnapshot(snap({ state }));
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        }
        // One stable subscription — the 1 Hz-ish emissions re-render only
        // this gate, they must never stack extra listeners.
        expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    });

    it('portals the full-screen drag alarm over any page the moment state hits alarm', () => {
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap());

        const dialog = screen.getByRole('alertdialog');
        // Portaled to document.body on the critical layer: it must outrank
        // every other in-app surface, whatever page is underneath.
        expect(document.body.contains(dialog)).toBe(true);
        expect(dialog).toHaveAttribute('data-overlay-layer', 'critical');
        expect(screen.getByRole('heading', { name: /drag alarm/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /acknowledge alarm/i })).toBeInTheDocument();
    });

    it('shows the overlay on first paint when mounted mid-alarm (relaunch path)', () => {
        mocks.state.snapshot = alarmSnap();
        render(<GlobalAnchorAlarmGate />);
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('routes Silence to AnchorWatchService.acknowledgeAlarm', () => {
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap());

        fireEvent.click(screen.getByRole('button', { name: /acknowledge alarm/i }));
        expect(mocks.acknowledgeAlarm).toHaveBeenCalledTimes(1);
        // Silencing is not stopping: the overlay clears only when the
        // SERVICE says the state changed.
        expect(screen.getByText(/monitoring continues after silencing/i)).toBeInTheDocument();
    });

    it('shows the blind-watch variant for a gps-lost alarm', () => {
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap({ alarmCause: 'gps-lost' }));

        expect(screen.getByRole('heading', { name: /gps lost/i })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /drag alarm/i })).not.toBeInTheDocument();
    });

    it('clears when the alarm resolves and unsubscribes on unmount', () => {
        const view = render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap());
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();

        emitSnapshot(snap({ state: 'watching' }));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

        view.unmount();
        expect(mocks.listeners.size).toBe(0);
        // A late emission after unmount must be inert.
        expect(() => emitSnapshot(alarmSnap())).not.toThrow();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
});

describe('GlobalAnchorAlarmGate: Move anchor from the alarm (build 125, 125-03)', () => {
    const moveButton = () => screen.queryByRole('button', { name: 'Move anchor' });

    it('a drag alarm offers Move anchor, which opens the sheet in alarm mode over the alarm', () => {
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap());
        expect(screen.queryByRole('dialog', { name: 'Move anchor' })).not.toBeInTheDocument();

        fireEvent.click(moveButton()!);

        const sheet = screen.getByRole('dialog', { name: 'Move anchor' });
        expect(sheet).toHaveAttribute('data-mode', 'alarm');
        // The alarm stays up behind it, Silence and all.
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /acknowledge alarm/i })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog', { name: 'Move anchor' })).not.toBeInTheDocument();
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('never for a GPS-lost alarm: a blind watch cannot judge a move', () => {
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap({ alarmCause: 'gps-lost' }));
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(moveButton()).not.toBeInTheDocument();
    });

    it('never while the boat’s Pi keeps the watch', () => {
        mocks.piKeeping = true;
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap());
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(moveButton()).not.toBeInTheDocument();
    });

    it('a finished move says so; the alarm stopping closes the sheet, and the next alarm does not reopen it', () => {
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap());
        fireEvent.click(moveButton()!);
        fireEvent.click(screen.getByRole('button', { name: 'Finish the move' }));
        expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/anchor moved/i));
        expect(mocks.toastSuccess.mock.calls[0][0]).toMatch(/drift/i);

        emitSnapshot(snap({ state: 'watching' }));
        expect(screen.queryByRole('dialog', { name: 'Move anchor' })).not.toBeInTheDocument();

        emitSnapshot(alarmSnap());
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Move anchor' })).not.toBeInTheDocument();
    });

    it('a sheet left open closes when the alarm turns GPS-lost under it', () => {
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap());
        fireEvent.click(moveButton()!);
        emitSnapshot(alarmSnap({ alarmCause: 'gps-lost' }));
        expect(screen.queryByRole('dialog', { name: 'Move anchor' })).not.toBeInTheDocument();
    });

    it('says why it sounded again after a move', () => {
        render(<GlobalAnchorAlarmGate />);
        emitSnapshot(alarmSnap({ alarmDetail: 'She is further from the anchor than when it was moved.' }));
        expect(screen.getByRole('alertdialog')).toHaveTextContent(
            'She is further from the anchor than when it was moved.',
        );
    });
});
