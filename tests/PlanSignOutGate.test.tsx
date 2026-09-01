import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logout = vi.fn(async () => {});
const requestTracerOpen = vi.fn();

type AuthState = { user: unknown; authChecked: boolean; logout: typeof logout };
let authState: AuthState = { user: null, authChecked: true, logout };

vi.mock('../services/deepLink', () => ({
    isBuilderDeepLink: () => true,
    requestTracerOpen: () => requestTracerOpen(),
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: Object.assign((selector: (s: AuthState) => unknown) => selector(authState), {
        getState: () => authState,
    }),
}));

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

vi.mock('../components/SignInScreen', () => ({
    SignInScreen: (props: { onClose?: () => void }) => (
        <div data-testid="sign-in-wall" data-has-close={props.onClose ? 'yes' : 'no'} />
    ),
}));

import { BuilderDeepLink } from '../components/BuilderDeepLink';
import { PlanSignOutButton } from '../components/PlanSignOutButton';

describe('/plan session gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authState = { user: null, authChecked: true, logout };
    });

    it('is a wall, not a door — the sign-in offers no way to dismiss it', () => {
        render(<BuilderDeepLink />);
        // `onClose` is exactly what renders SignInScreen's close button, so
        // its absence IS the wall. Passing one would silently restore the
        // old dismissible behaviour.
        expect(screen.getByTestId('sign-in-wall')).toHaveAttribute('data-has-close', 'no');
        expect(requestTracerOpen).not.toHaveBeenCalled();
    });

    it('re-raises the wall after a sign-out instead of latching open', () => {
        authState = { ...authState, user: { id: 'skipper' } };
        const { rerender } = render(<BuilderDeepLink />);
        expect(screen.queryByTestId('sign-in-wall')).not.toBeInTheDocument();
        // The wall only lowers now — it never fires the tracer itself. The
        // planner front door (Trip·Legs, departure, saved routes) is what
        // the boot lands on, and ITS slide opens the tracer (2026-09-02:
        // "otherwise we cannot start a new leg").
        expect(requestTracerOpen).not.toHaveBeenCalled();

        // Signing out from the planner must not leave a signed-out builder
        // running: charted depth is account-gated, so tide/depth checks
        // would silently vanish. The `done` latch has to clear.
        authState = { ...authState, user: null };
        rerender(<BuilderDeepLink />);
        expect(screen.getByTestId('sign-in-wall')).toBeInTheDocument();
    });

    it('shows the sign-out only on /plan with a live session', () => {
        const { rerender } = render(<PlanSignOutButton />);
        expect(screen.queryByTestId('plan-sign-out')).not.toBeInTheDocument();

        authState = { ...authState, user: { id: 'skipper' } };
        rerender(<PlanSignOutButton />);
        expect(screen.getByTestId('plan-sign-out')).toBeInTheDocument();
    });

    it('signs out through authStore, which restores the session on failure', async () => {
        authState = { ...authState, user: { id: 'skipper' } };
        render(<PlanSignOutButton />);

        fireEvent.click(screen.getByTestId('plan-sign-out'));
        await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    });

    it('shows an actionable safety-interlock rejection instead of swallowing it', async () => {
        authState = { ...authState, user: { id: 'skipper' } };
        logout.mockRejectedValueOnce(
            new Error('Man Overboard is active on this device. Clear the Man Overboard emergency before you sign out.'),
        );
        render(<PlanSignOutButton />);

        fireEvent.click(screen.getByTestId('plan-sign-out'));

        expect(await screen.findByRole('alert')).toHaveTextContent('Clear the Man Overboard emergency');
        expect(screen.getByTestId('plan-sign-out')).toBeEnabled();
    });

    it('ignores a second tap while the sign-out is still in flight', async () => {
        authState = { ...authState, user: { id: 'skipper' } };
        render(<PlanSignOutButton />);

        const button = screen.getByTestId('plan-sign-out');
        fireEvent.click(button);
        fireEvent.click(button);
        await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    });
});

describe('the /plan boot destination', () => {
    it('lands on the planner front door, not the bare chart', () => {
        const src = readFileSync(resolve(process.cwd(), 'services/deepLink.ts'), 'utf8');
        expect(src).toContain("if (isBuilderDeepLink()) return 'voyage';");
    });
});
