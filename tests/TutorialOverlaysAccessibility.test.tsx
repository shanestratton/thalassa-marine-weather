import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlassTutorial } from '../components/dashboard/GlassTutorial';
import { GestureTutorial } from '../components/ui/GestureTutorial';
import { OnboardingOverlay } from '../components/ui/OnboardingOverlay';
import { authScopedStorageKey, setAuthIdentityScope } from '../services/authIdentityScope';

function GlassTutorialHarness() {
    return (
        <>
            <button onClick={() => window.dispatchEvent(new Event('thalassa:show-glass-tutorial'))}>
                Show Glass tips
            </button>
            <GlassTutorial />
        </>
    );
}

function OnboardingOverlayHarness() {
    return (
        <>
            <button onClick={() => window.dispatchEvent(new Event('thalassa:show-intro-overlay'))}>
                Show onboarding
            </button>
            <OnboardingOverlay />
        </>
    );
}

function CoordinatedTutorialHarness() {
    return (
        <>
            <button
                onClick={() => {
                    window.dispatchEvent(new Event('thalassa:show-intro-overlay'));
                    window.dispatchEvent(new Event('thalassa:show-glass-tutorial'));
                }}
            >
                Show first-run tutorials
            </button>
            <OnboardingOverlay />
            <GlassTutorial />
        </>
    );
}

function GestureTutorialHarness({ onNeverShow = vi.fn() }: { onNeverShow?: () => void }) {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button onClick={() => setOpen(true)}>Show gesture tips</button>
            {open && <GestureTutorial onDismiss={() => setOpen(false)} onNeverShow={onNeverShow} />}
        </>
    );
}

describe('tutorial overlay accessibility', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('tutorial-user');
    });

    afterEach(() => {
        vi.useRealTimers();
        setAuthIdentityScope(null);
    });

    it('labels the Glass tutorial, contains focus, and restores its launcher on Escape', () => {
        localStorage.setItem(authScopedStorageKey('thalassa_onboarding_complete'), 'true');
        render(<GlassTutorialHarness />);

        const opener = screen.getByRole('button', { name: 'Show Glass tips' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Essential Mode' });
        const next = screen.getByRole('button', { name: 'Next tip: Future Hours' });
        const skip = screen.getByRole('button', { name: 'Skip Glass tutorial' });

        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleDescription(/Tip 1 of 4.*Tap the chevron/);
        expect(next).toHaveFocus();

        fireEvent.keyDown(next, { key: 'Tab' });
        expect(skip).toHaveFocus();
        fireEvent.keyDown(skip, { key: 'Tab', shiftKey: true });
        expect(next).toHaveFocus();

        fireEvent.click(next);
        expect(screen.getByRole('dialog', { name: 'Future Hours' })).toHaveAccessibleDescription(
            /Tip 2 of 4.*Swipe left or right/,
        );

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_glass_tutorial_seen'))).toBe('true');
    });

    it('queues the Glass tutorial until onboarding has closed instead of stacking two modals', () => {
        render(<CoordinatedTutorialHarness />);

        const opener = screen.getByRole('button', { name: 'Show first-run tutorials' });
        opener.focus();
        fireEvent.click(opener);

        expect(screen.getByRole('dialog', { name: 'Your Weather' })).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Essential Mode' })).not.toBeInTheDocument();

        fireEvent.keyDown(screen.getByRole('button', { name: 'Next: Your Charts' }), { key: 'Escape' });

        expect(screen.queryByRole('dialog', { name: 'Your Weather' })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Essential Mode' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next tip: Future Hours' })).toHaveFocus();

        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('dismisses onboarding with Escape and restores the control that launched it', () => {
        render(<OnboardingOverlayHarness />);

        const opener = screen.getByRole('button', { name: 'Show onboarding' });
        opener.focus();
        fireEvent.click(opener);

        const dialog = screen.getByRole('dialog', { name: 'Your Weather' });
        const next = screen.getByRole('button', { name: 'Next: Your Charts' });

        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleDescription(/Step 1 of 4.*Real-time marine forecasts/);
        expect(next).toHaveFocus();

        fireEvent.keyDown(next, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_onboarding_complete'))).toBe('true');
    });

    it('gives every onboarding action an accurate name through completion', () => {
        render(<OnboardingOverlayHarness />);

        const opener = screen.getByRole('button', { name: 'Show onboarding' });
        opener.focus();
        fireEvent.click(opener);

        fireEvent.click(screen.getByRole('button', { name: 'Next: Your Charts' }));
        expect(screen.getByRole('dialog', { name: 'Your Charts' })).toHaveAccessibleDescription(/Step 2 of 4/);

        fireEvent.click(screen.getByRole('button', { name: 'Next: The Scuttlebutt' }));
        expect(screen.getByRole('dialog', { name: 'The Scuttlebutt' })).toHaveAccessibleDescription(/Step 3 of 4/);

        fireEvent.click(screen.getByRole('button', { name: 'Next: Your Vessel' }));
        const finish = screen.getByRole('button', { name: 'Finish onboarding' });
        expect(screen.getByRole('dialog', { name: 'Your Vessel' })).toHaveAccessibleDescription(/Step 4 of 4/);
        expect(finish).toHaveFocus();

        fireEvent.click(finish);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('activates the gesture tutorial after its fade, traps focus, and restores focus on Escape', () => {
        vi.useFakeTimers();
        render(<GestureTutorialHarness />);

        const opener = screen.getByRole('button', { name: 'Show gesture tips' });
        opener.focus();
        fireEvent.click(opener);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(100);
        });

        const dialog = screen.getByRole('dialog', { name: 'Swipe Horizontally' });
        const next = screen.getByRole('button', { name: 'Next: Swipe Vertically' });
        const skip = screen.getByRole('button', { name: 'Skip gesture tutorial' });

        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAccessibleDescription(/Step 1 of 4.*Scrub through hours/);
        expect(next).toHaveFocus();

        fireEvent.keyDown(next, { key: 'Tab', shiftKey: true });
        expect(skip).toHaveFocus();
        fireEvent.keyDown(skip, { key: 'Tab' });
        expect(next).toHaveFocus();

        fireEvent.keyDown(next, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();

        act(() => {
            vi.advanceTimersByTime(300);
        });
    });

    it('synchronously hides an open tutorial when the active account changes', () => {
        render(<OnboardingOverlayHarness />);
        fireEvent.click(screen.getByRole('button', { name: 'Show onboarding' }));
        expect(screen.getByRole('dialog', { name: 'Your Weather' })).toBeInTheDocument();

        act(() => {
            setAuthIdentityScope('tutorial-user-b');
        });

        expect(screen.queryByRole('dialog', { name: 'Your Weather' })).not.toBeInTheDocument();
    });

    it('keeps completion flags independent between accounts', () => {
        render(<OnboardingOverlayHarness />);
        fireEvent.click(screen.getByRole('button', { name: 'Show onboarding' }));
        fireEvent.keyDown(screen.getByRole('button', { name: 'Next: Your Charts' }), { key: 'Escape' });

        const accountAKey = authScopedStorageKey('thalassa_onboarding_complete');
        expect(localStorage.getItem(accountAKey)).toBe('true');

        act(() => {
            setAuthIdentityScope('tutorial-user-b');
        });
        expect(localStorage.getItem(authScopedStorageKey('thalassa_onboarding_complete'))).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Show onboarding' }));
        expect(screen.getByRole('dialog', { name: 'Your Weather' })).toBeInTheDocument();
    });
});
