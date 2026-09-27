/**
 * UX scorecard run 7 — the Crew & Float Plan sign-in wall: crew-first copy and
 * a preview of what signing in unlocks. Run 9 — the one sign-in card recipe
 * (as on Galley, Account & Cloud and Voyage Log) and a heading that states
 * the benefit.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/SignInScreen', () => ({
    SignInScreen: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div role="dialog" aria-label="Sign in" /> : null),
}));

import { CREW_PAGE_SUBTITLE, CrewSignInPrompt } from '../components/crewManagement/CrewSignInPrompt';

afterEach(cleanup);

describe('CrewSignInPrompt', () => {
    it('leads with the crew benefit, lists what signing in unlocks, and opens sign-in', () => {
        const setShowAuth = vi.fn();
        render(<CrewSignInPrompt onBack={vi.fn()} showAuth={false} setShowAuth={setShowAuth} />);

        expect(screen.getByRole('heading', { name: 'Crew & Float Plan' })).toBeInTheDocument();
        expect(screen.getByText(CREW_PAGE_SUBTITLE)).toBeInTheDocument();
        // The benefit, not the barrier (UX scorecard run 9).
        expect(screen.getByRole('heading', { name: 'Sign in to plan with your crew' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Sign in required' })).not.toBeInTheDocument();
        expect(screen.getByText('An account unlocks:')).toBeInTheDocument();
        expect(screen.queryByText(/save routes/i)).not.toBeInTheDocument();

        const unlocks = screen.getAllByRole('listitem').map((item) => item.textContent);
        expect(unlocks).toEqual([
            'Readiness checks before you cast off',
            'Invite crew to prepare the passage with you',
            'A private float plan to share ashore',
        ]);

        // The one sign-in card: the full-width SignInButton under a
        // left-aligned heading, as on Galley (UX scorecard run 9).
        const signIn = screen.getByRole('button', { name: 'Sign in' });
        expect(signIn).toHaveClass('w-full');
        expect(screen.getByRole('region', { name: 'Sign in to plan with your crew' })).toContainElement(signIn);
        fireEvent.click(signIn);
        expect(setShowAuth).toHaveBeenCalledWith(true);
    });
});
