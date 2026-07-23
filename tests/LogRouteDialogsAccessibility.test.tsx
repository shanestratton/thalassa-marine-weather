import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const followRouteMocks = vi.hoisted(() => ({
    stopFollowing: vi.fn(),
    refreshRoute: vi.fn(),
    acceptRouteChange: vi.fn(),
    dismissRouteChange: vi.fn(),
}));

vi.mock('../context/FollowRouteContext', () => ({
    useFollowRoute: () => ({
        isFollowing: true,
        voyagePlan: {
            origin: 'Brisbane, Australia',
            destination: 'Moreton Island, Australia',
        },
        routeChanged: false,
        changeDescription: null,
        isRefreshing: false,
        lastRefresh: null,
        routeCoords: [],
        ...followRouteMocks,
    }),
}));

import { FollowRouteBadge } from '../components/FollowRouteBadge';
import { GpsDisclaimerModal } from '../pages/log/GpsDisclaimerModal';
import { StopVoyageDialog, VoyageChoiceDialog } from '../pages/log/VoyageDialogs';

describe('log and route dialog accessibility', () => {
    it('contains the voyage choice, cancels on Escape, and restores its opener', () => {
        const onCancel = vi.fn();
        const { rerender } = render(<button>Start tracking</button>);
        const opener = screen.getByRole('button', { name: 'Start tracking' });
        opener.focus();

        rerender(
            <>
                <button>Start tracking</button>
                <VoyageChoiceDialog onContinue={vi.fn()} onNewVoyage={vi.fn()} onCancel={onCancel} />
            </>,
        );

        const dialog = screen.getByRole('dialog', { name: 'Start Tracking' });
        const cancel = screen.getByRole('button', { name: 'Cancel' });
        const continueVoyage = screen.getByRole('button', { name: 'Continue Last Voyage' });
        expect(dialog).toContainElement(cancel);
        expect(cancel).toHaveFocus();

        fireEvent.keyDown(cancel, { key: 'Tab' });
        expect(continueVoyage).toHaveFocus();
        fireEvent.keyDown(continueVoyage, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledOnce();

        rerender(<button>Start tracking</button>);
        expect(opener).toHaveFocus();
    });

    it('defaults the destructive end-voyage confirmation to Cancel', () => {
        const onCancel = vi.fn();
        const { rerender } = render(<button>End current voyage</button>);
        const opener = screen.getByRole('button', { name: 'End current voyage' });
        opener.focus();

        rerender(
            <>
                <button>End current voyage</button>
                <StopVoyageDialog onConfirm={vi.fn()} onCancel={onCancel} />
            </>,
        );

        const cancel = screen.getByRole('button', { name: 'Cancel' });
        const confirm = screen.getByRole('button', { name: 'End Voyage' });
        expect(screen.getByRole('alertdialog', { name: 'End Voyage?' })).toContainElement(confirm);
        expect(cancel).toHaveFocus();

        fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
        expect(confirm).toHaveFocus();
        fireEvent.keyDown(confirm, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledOnce();

        rerender(<button>End current voyage</button>);
        expect(opener).toHaveFocus();
    });

    it('focuses the GPS preference, does not start tracking on Escape, and restores focus', () => {
        const onDismiss = vi.fn();
        const { rerender } = render(
            <>
                <button>Begin GPS tracking</button>
                <GpsDisclaimerModal isOpen={false} onDismiss={onDismiss} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Begin GPS tracking' });
        opener.focus();

        rerender(
            <>
                <button>Begin GPS tracking</button>
                <GpsDisclaimerModal isOpen onDismiss={onDismiss} />
            </>,
        );

        const checkbox = screen.getByRole('checkbox', { name: "Don't show this again" });
        const dismiss = screen.getByRole('button', { name: 'Dismiss GPS disclaimer' });
        expect(screen.getByRole('dialog', { name: 'GPS Accuracy Notice' })).toContainElement(checkbox);
        expect(checkbox).toHaveFocus();

        fireEvent.keyDown(checkbox, { key: 'Escape' });
        expect(onDismiss).not.toHaveBeenCalled();
        fireEvent.click(checkbox);
        fireEvent.click(dismiss);
        expect(onDismiss).toHaveBeenCalledWith(true);

        rerender(
            <>
                <button>Begin GPS tracking</button>
                <GpsDisclaimerModal isOpen={false} onDismiss={onDismiss} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('keeps route following by default and restores the stop button after Escape', () => {
        followRouteMocks.stopFollowing.mockClear();
        render(<FollowRouteBadge />);

        const opener = screen.getByRole('button', { name: 'Stop following route' });
        opener.focus();
        fireEvent.click(opener);

        const cancel = screen.getByRole('button', { name: 'Cancel route following' });
        const stop = screen.getByRole('button', { name: 'Stop route following' });
        expect(screen.getByRole('alertdialog', { name: 'Stop Following Route?' })).toContainElement(stop);
        expect(cancel).toHaveFocus();

        fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
        expect(stop).toHaveFocus();
        fireEvent.keyDown(stop, { key: 'Escape' });

        expect(screen.queryByRole('alertdialog', { name: 'Stop Following Route?' })).not.toBeInTheDocument();
        expect(followRouteMocks.stopFollowing).not.toHaveBeenCalled();
        expect(opener).toHaveFocus();
    });
});
