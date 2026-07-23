import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AnchorAlarmOverlay } from '../components/anchor-watch/AnchorAlarmOverlay';
import { ProcessOverlay } from '../components/ProcessOverlay';
import { EmptyTrackRemovedModal } from '../components/ui/EmptyTrackRemovedModal';
import { GpsAcquiringOverlay } from '../components/ui/GpsAcquiringOverlay';
import type { AnchorWatchSnapshot } from '../services/AnchorWatchService';

const alarmSnapshot: AnchorWatchSnapshot = {
    state: 'alarm',
    anchorPosition: { latitude: -27.47, longitude: 153.03, timestamp: 1 },
    vesselPosition: {
        latitude: -27.471,
        longitude: 153.031,
        accuracy: 5,
        heading: 180,
        speed: 1,
        timestamp: 2,
    },
    swingRadius: 35,
    distanceFromAnchor: 80,
    maxDistanceRecorded: 80,
    bearingToAnchor: 180,
    config: {
        rodeLength: 30,
        waterDepth: 5,
        scopeRatio: 5,
        rodeType: 'chain',
        safetyMargin: 10,
    },
    positionHistory: [],
    alarmTriggeredAt: 2,
    alarmCause: 'drag',
    watchStartedAt: 1,
    gpsAccuracy: 5,
    gpsQuality: 'precision',
    gpsQualityLabel: 'Precision GPS',
    guardianStatus: 'idle',
};

describe('blocking overlay focus lifecycle', () => {
    it('requires deliberate anchor-alarm acknowledgement and restores the opener', () => {
        const onAcknowledge = vi.fn();
        const { rerender } = render(<button>Open anchor alarm</button>);
        const opener = screen.getByRole('button', { name: 'Open anchor alarm' });
        opener.focus();

        rerender(
            <>
                <button>Open anchor alarm</button>
                <AnchorAlarmOverlay snapshot={alarmSnapshot} onAcknowledge={onAcknowledge} />
            </>,
        );

        const dialog = screen.getByRole('alertdialog', { name: 'Drag Alarm' });
        const acknowledge = screen.getByRole('button', { name: 'Acknowledge Alarm' });
        expect(dialog).toContainElement(acknowledge);
        expect(acknowledge).toHaveFocus();

        fireEvent.keyDown(acknowledge, { key: 'Escape' });
        expect(onAcknowledge).not.toHaveBeenCalled();

        fireEvent.keyDown(acknowledge, { key: 'Tab' });
        expect(acknowledge).toHaveFocus();
        fireEvent.click(acknowledge);
        expect(onAcknowledge).toHaveBeenCalledOnce();

        rerender(<button>Open anchor alarm</button>);
        expect(opener).toHaveFocus();
    });

    it('lets the skipper background GPS acquisition with Escape and restores focus', () => {
        const onDismiss = vi.fn();
        const { rerender } = render(
            <>
                <button>Start tracking</button>
                <GpsAcquiringOverlay open={false} onDismiss={onDismiss} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Start tracking' });
        opener.focus();

        rerender(
            <>
                <button>Start tracking</button>
                <GpsAcquiringOverlay open onDismiss={onDismiss} />
            </>,
        );

        const dialog = screen.getByRole('alertdialog', { name: 'Acquiring GPS fix…' });
        const dismiss = screen.getByRole('button', { name: 'Keep waiting in background' });
        expect(dialog).toContainElement(dismiss);
        expect(dismiss).toHaveFocus();

        fireEvent.keyDown(dismiss, { key: 'Escape' });
        expect(onDismiss).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Start tracking</button>
                <GpsAcquiringOverlay open={false} onDismiss={onDismiss} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('contains the empty-track announcement and supports its existing dismiss action', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <>
                <button>Open logbook</button>
                <EmptyTrackRemovedModal count={null} onClose={onClose} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Open logbook' });
        opener.focus();

        rerender(
            <>
                <button>Open logbook</button>
                <EmptyTrackRemovedModal count={1} onClose={onClose} />
            </>,
        );

        const dialog = screen.getByRole('dialog', { name: 'Empty track tidied away' });
        const close = screen.getByRole('button', { name: /^Got it/ });
        expect(dialog).toContainElement(close);
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Open logbook</button>
                <EmptyTrackRemovedModal count={null} onClose={onClose} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('focuses the non-dismissible process dialog without inventing an Escape action', () => {
        const { rerender } = render(<button>Save passage</button>);
        const opener = screen.getByRole('button', { name: 'Save passage' });
        opener.focus();

        rerender(
            <>
                <button>Save passage</button>
                <ProcessOverlay message="Saving passage…" />
            </>,
        );

        const dialog = screen.getByRole('dialog', { name: 'Saving passage…' });
        expect(dialog).toHaveAttribute('aria-busy', 'true');
        expect(dialog).toHaveFocus();

        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveFocus();

        rerender(<button>Save passage</button>);
        expect(opener).toHaveFocus();
    });
});
