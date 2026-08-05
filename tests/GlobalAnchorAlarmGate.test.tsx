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
    };
});

vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: {
        subscribe: mocks.subscribe,
        getSnapshot: mocks.getSnapshot,
        acknowledgeAlarm: mocks.acknowledgeAlarm,
    },
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
