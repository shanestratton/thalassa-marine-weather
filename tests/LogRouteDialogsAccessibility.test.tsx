import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
        const overlay = dialog.closest<HTMLElement>('[data-overlay-layer="modal"]');
        expect(dialog).toContainElement(cancel);
        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay?.style.zIndex).toBe('1100');
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
        const dialog = screen.getByRole('alertdialog', { name: 'End Voyage?' });
        const overlay = dialog.closest<HTMLElement>('[data-overlay-layer="modal"]');
        expect(dialog).toContainElement(confirm);
        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay?.style.zIndex).toBe('1100');
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
        const dialog = screen.getByRole('dialog', { name: 'GPS Accuracy Notice' });
        const overlay = dialog.closest<HTMLElement>('[data-overlay-layer="modal"]');
        expect(dialog).toContainElement(checkbox);
        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay?.style.zIndex).toBe('1100');
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
});
