/**
 * UX scorecard run 7 — the Crew & Float Plan sign-in wall: centred action,
 * crew-first copy, and a preview of what signing in unlocks.
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
    it('leads with crew readiness, lists what signing in unlocks, and opens sign-in', () => {
        const setShowAuth = vi.fn();
        render(<CrewSignInPrompt onBack={vi.fn()} showAuth={false} setShowAuth={setShowAuth} />);

        expect(screen.getByRole('heading', { name: 'Crew & Float Plan' })).toBeInTheDocument();
        expect(screen.getByText(CREW_PAGE_SUBTITLE)).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Sign in required' })).toBeInTheDocument();
        expect(
            screen.getByText('Sign in to check readiness with your crew and share a private float plan.'),
        ).toBeInTheDocument();
        expect(screen.queryByText(/save routes/i)).not.toBeInTheDocument();

        const unlocks = screen.getAllByRole('listitem').map((item) => item.textContent);
        expect(unlocks).toEqual([
            'Readiness checks before you cast off',
            'Invite crew to prepare the passage with you',
            'A private float plan to share ashore',
        ]);

        // The action sits in the notice's centred action row, not left-aligned
        // under centred copy.
        const signIn = screen.getByRole('button', { name: 'Sign in' });
        expect(signIn.parentElement?.className).toContain('justify-center');
        fireEvent.click(signIn);
        expect(setShowAuth).toHaveBeenCalledWith(true);
    });
});
