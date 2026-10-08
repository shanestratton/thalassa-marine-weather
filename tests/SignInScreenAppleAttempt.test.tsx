import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';

/**
 * Sign in with Apple on the sign-in sheet (build 124, package AC). Supabase
 * reports SIGNED_IN before Apple Sign-In's last two steps (the device binding
 * and register-apple-token) have run, so the sheet must not take SIGNED_IN as
 * the end of an Apple attempt: it stays open and busy until the whole chain
 * settles, and a failure in any step lands on an open sheet.
 */

const m = vi.hoisted(() => {
    vi.stubEnv('VITE_APPLE_SIGN_IN_ENABLED', 'true');
    return { apple: vi.fn(), google: vi.fn() };
});

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => false },
    registerPlugin: vi.fn(() => ({})),
}));
vi.mock('../services/auth/SocialAuthService', () => ({
    APPLE_WEB_SIGN_IN_ENABLED: false,
    signInWithApple: m.apple,
    signInWithAppleOnWeb: m.apple,
}));
vi.mock('../services/auth/googleSignIn', () => ({
    GOOGLE_SIGN_IN_ENABLED: true,
    signInWithGoogle: m.google,
    signInWithGoogleOnWeb: m.google,
}));
vi.mock('../stores/authStore', async () => {
    const { create } = await import('zustand');
    return { useAuthStore: create<{ user: User | null }>(() => ({ user: null })) };
});
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { SignInScreen } from '../components/SignInScreen';
import {
    appleSignInHoldsSheet,
    endAppleSignInAttempt,
    getAppleSignInAttempt,
} from '../services/auth/appleSignInAttempt';
import { useAuthStore } from '../stores/authStore';

const SERVER_FAILURE = "Apple Sign-In couldn't finish (server, 502). Try again.";
const sailor = { id: 'user-sailor-1', identities: [] } as unknown as User;

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Supabase's SIGNED_IN / SIGNED_OUT, as authStore publishes them. */
function signedIn(user: User | null) {
    act(() => useAuthStore.setState({ user }));
}

/** A caller like Settings → Account: the sheet stays mounted, open or closed. */
function AccountLikeCaller({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Open sign-in
            </button>
            <SignInScreen
                isOpen={open}
                onClose={() => {
                    setOpen(false);
                    onClose();
                }}
            />
        </>
    );
}

/** A caller like the Vessel hub's claim: the sheet is rendered only while signed out. */
function SignedOutOnlyCaller() {
    const user = useAuthStore((s) => s.user);
    const [open, setOpen] = useState(true);
    return user ? (
        <p>Signed-in view</p>
    ) : (
        <SignInScreen isOpen={open} onClose={() => setOpen(false)} prompt="Sign in to share your boat’s position." />
    );
}

/**
 * A caller like the Galley or the Vessel hub's claim card: it closes its sheet
 * itself whenever the signed-in account changes. `guarded` is the build-124
 * hunk those two callers carry: skip that close while an Apple attempt holds
 * the sheet. Unguarded, it stands for any caller that has not got it.
 */
function ClosesOnAccountChangeCaller({ guarded, onClose }: { guarded: boolean; onClose?: () => void }) {
    const userId = useAuthStore((s) => s.user?.id ?? null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (!guarded || !appleSignInHoldsSheet()) setOpen(false);
    }, [guarded, userId]);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Open sign-in
            </button>
            <SignInScreen
                isOpen={open}
                onClose={() => {
                    setOpen(false);
                    onClose?.();
                }}
            />
        </>
    );
}

/** A caller like Voyage Log or Sightings: the sheet is rendered only while open. */
function MountOnOpenCaller() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Open sign-in
            </button>
            <button type="button" onClick={() => setOpen(false)}>
                Leave page
            </button>
            {open && <SignInScreen isOpen onClose={() => setOpen(false)} />}
        </>
    );
}

const appleButton = () => screen.getByRole('button', { name: 'Sign in with Apple' });
const openSignIn = () => fireEvent.click(screen.getByRole('button', { name: 'Open sign-in' }));
const sheet = () => screen.queryByRole('dialog', { name: 'Sign in to Thalassa' });

beforeEach(() => {
    vi.clearAllMocks();
    act(() => useAuthStore.setState({ user: null }));
    endAppleSignInAttempt(null);
});
afterAll(() => vi.unstubAllEnvs());

describe('SignInScreen: Sign in with Apple stays open until every step has finished', () => {
    it('stays open and busy after SIGNED_IN until bind and register finish, then closes', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        const onClose = vi.fn();
        render(<AccountLikeCaller onClose={onClose} />);

        fireEvent.click(appleButton());
        signedIn(sailor);

        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Sign in to Thalassa' })).toBeInTheDocument();
        expect(appleButton()).toHaveTextContent('Signing in…');
        expect(appleButton()).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled();

        await act(async () => attempt.resolve());

        expect(onClose).toHaveBeenCalledOnce();
    });

    it('shows the failing step on the still-open sheet when a step after SIGNED_IN fails', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        const onClose = vi.fn();
        render(<AccountLikeCaller onClose={onClose} />);

        fireEvent.click(appleButton());
        signedIn(sailor);
        // The failed session is discarded (SIGNED_OUT), then the step's error arrives.
        signedIn(null);
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));

        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText(SERVER_FAILURE)).toBeVisible();
        expect(appleButton()).toBeEnabled();
        expect(appleButton()).toHaveTextContent('Sign in with Apple');
    });

    it('hands a failure to the sheet a signed-out-only caller shows again after the discarded session', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        render(<SignedOutOnlyCaller />);

        fireEvent.click(appleButton());
        signedIn(sailor);
        expect(screen.getByText('Signed-in view')).toBeInTheDocument();

        signedIn(null);
        // The re-rendered sheet knows the attempt is still running.
        expect(appleButton()).toHaveTextContent('Signing in…');
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));

        expect(screen.getByText(SERVER_FAILURE)).toBeVisible();
        expect(appleButton()).toBeEnabled();
    });

    it('clears a failure the sailor has seen once the sheet is closed and opened again', async () => {
        m.apple.mockRejectedValue(new Error(SERVER_FAILURE));
        render(<AccountLikeCaller onClose={vi.fn()} />);

        await act(async () => fireEvent.click(appleButton()));
        expect(screen.getByText(SERVER_FAILURE)).toBeVisible();

        fireEvent.click(screen.getByRole('button', { name: 'Close sign-in' }));
        fireEvent.click(screen.getByRole('button', { name: 'Open sign-in' }));

        expect(screen.getByRole('dialog', { name: 'Sign in to Thalassa' })).toBeInTheDocument();
        expect(screen.queryByText(SERVER_FAILURE)).not.toBeInTheDocument();
    });

    it('does not greet the next visit with a failure that landed after the sailor closed the sheet', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        render(<AccountLikeCaller onClose={vi.fn()} />);

        fireEvent.click(appleButton());
        signedIn(sailor);
        fireEvent.click(screen.getByRole('button', { name: 'Close sign-in' }));
        signedIn(null);
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));

        fireEvent.click(screen.getByRole('button', { name: 'Open sign-in' }));
        expect(screen.queryByText(SERVER_FAILURE)).not.toBeInTheDocument();
        expect(appleButton()).toBeEnabled();
    });

    it('stays silent on a cancel, and shows Apple error 1000 instead of swallowing it', async () => {
        m.apple.mockRejectedValueOnce(new Error('CANCELLED'));
        render(<AccountLikeCaller onClose={vi.fn()} />);
        await act(async () => fireEvent.click(appleButton()));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        m.apple.mockRejectedValueOnce(new Error("Apple Sign-In didn't complete (Apple error 1000). Try again."));
        await act(async () => fireEvent.click(appleButton()));
        expect(screen.getByRole('alert')).toHaveTextContent(
            "Apple Sign-In didn't complete (Apple error 1000). Try again.",
        );
    });

    it('a Google attempt clears an Apple failure, and Google still closes on SIGNED_IN as before', async () => {
        m.apple.mockRejectedValueOnce(new Error(SERVER_FAILURE));
        const google = deferred();
        m.google.mockReturnValue(google.promise);
        const onClose = vi.fn();
        render(<AccountLikeCaller onClose={onClose} />);
        await act(async () => fireEvent.click(appleButton()));
        expect(screen.getByText(SERVER_FAILURE)).toBeVisible();

        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
        expect(screen.queryByText(SERVER_FAILURE)).not.toBeInTheDocument();
        signedIn(sailor);

        // Unchanged Google behaviour: SIGNED_IN dismisses the sheet at once.
        expect(onClose).toHaveBeenCalledOnce();
        await act(async () => google.resolve());
    });
});

describe('SignInScreen: an Apple failure reaches the sailor whoever closes the sheet', () => {
    it('a caller guarded by appleSignInHoldsSheet keeps the sheet open and busy, then shows the failed step', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        render(<ClosesOnAccountChangeCaller guarded />);
        openSignIn();

        fireEvent.click(appleButton());
        signedIn(sailor);
        expect(sheet()).toBeInTheDocument();
        expect(appleButton()).toHaveTextContent('Signing in…');

        signedIn(null);
        expect(sheet()).toBeInTheDocument();
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));

        expect(sheet()).toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(SERVER_FAILURE);
        expect(appleButton()).toBeEnabled();
    });

    it('a guarded caller still closes once every Apple step has finished', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        const onClose = vi.fn();
        render(<ClosesOnAccountChangeCaller guarded onClose={onClose} />);
        openSignIn();

        fireEvent.click(appleButton());
        signedIn(sailor);
        expect(sheet()).toBeInTheDocument();
        await act(async () => attempt.resolve());

        expect(onClose).toHaveBeenCalledOnce();
        expect(sheet()).not.toBeInTheDocument();
    });

    it('keeps a failure that lands while a caller (not the sailor) has the sheet closed, and shows it on the next open', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        render(<ClosesOnAccountChangeCaller guarded={false} />);
        openSignIn();

        fireEvent.click(appleButton());
        signedIn(sailor);
        // The caller closed the sheet on the account change; the sailor did not.
        expect(sheet()).not.toBeInTheDocument();
        signedIn(null);
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));
        expect(getAppleSignInAttempt().failure).toBe(SERVER_FAILURE);

        openSignIn();
        expect(screen.getByRole('alert')).toHaveTextContent(SERVER_FAILURE);
    });

    it('stays open on a failed step when the discarded session is still signed in', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        const onClose = vi.fn();
        render(<AccountLikeCaller onClose={onClose} />);

        fireEvent.click(appleButton());
        signedIn(sailor);
        // No SIGNED_OUT: the discard could not sign the session out.
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));

        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent(SERVER_FAILURE);
    });

    it('a sheet rendered only while open does not reopen with a failure the sailor closed', async () => {
        m.apple.mockRejectedValue(new Error(SERVER_FAILURE));
        render(<MountOnOpenCaller />);
        openSignIn();
        await act(async () => fireEvent.click(appleButton()));
        expect(screen.getByRole('alert')).toHaveTextContent(SERVER_FAILURE);

        fireEvent.click(screen.getByRole('button', { name: 'Close sign-in' }));
        openSignIn();

        expect(sheet()).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a sheet rendered only while open forgets a failure it showed when the caller unmounts it', async () => {
        m.apple.mockRejectedValue(new Error(SERVER_FAILURE));
        render(<MountOnOpenCaller />);
        openSignIn();
        await act(async () => fireEvent.click(appleButton()));
        expect(screen.getByRole('alert')).toHaveTextContent(SERVER_FAILURE);

        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Leave page' })));
        openSignIn();

        expect(sheet()).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('drops a failure that lands after the sailor closed a sheet rendered only while open', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        render(<MountOnOpenCaller />);
        openSignIn();

        fireEvent.click(appleButton());
        signedIn(sailor);
        fireEvent.click(screen.getByRole('button', { name: 'Close sign-in' }));
        signedIn(null);
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));

        openSignIn();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(appleButton()).toBeEnabled();
    });

    it('Escape is the sailor walking away too', async () => {
        const attempt = deferred();
        m.apple.mockReturnValue(attempt.promise);
        render(<AccountLikeCaller onClose={vi.fn()} />);

        fireEvent.click(appleButton());
        screen.getByRole('button', { name: 'Close sign-in' }).focus();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(sheet()).not.toBeInTheDocument();
        await act(async () => attempt.reject(new Error(SERVER_FAILURE)));

        openSignIn();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('email after an Apple failure clears the banner and still closes on SIGNED_IN as before', async () => {
        m.apple.mockRejectedValueOnce(new Error(SERVER_FAILURE));
        const onClose = vi.fn();
        render(<AccountLikeCaller onClose={onClose} />);
        await act(async () => fireEvent.click(appleButton()));
        expect(screen.getByText(SERVER_FAILURE)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Sign in with email' }));
        expect(screen.queryByText(SERVER_FAILURE)).not.toBeInTheDocument();
        signedIn(sailor);

        expect(onClose).toHaveBeenCalledOnce();
    });
});
