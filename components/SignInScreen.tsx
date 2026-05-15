/**
 * SignInScreen — the boot-time auth gate.
 *
 * Rendered by AuthGate when there's no Supabase session. Punter
 * picks Apple, Google, or email; on success the session lands in
 * authStore and AuthGate unmounts this screen.
 *
 * Apple + Google buttons are primary (App Store policy + best UX).
 * Email/OTP is a "Use email instead" link below — kept available
 * because:
 *   1. Existing users signed up that way and must keep their data
 *   2. Recovery lane if Apple/Google has an outage or is locked
 *
 * On a sailing app, identity reliability beats minor UI clutter.
 */

import React, { useCallback, useState } from 'react';
import { signInWithApple, signInWithGoogle } from '../services/auth/SocialAuthService';
import { AuthModal } from './AuthModal';
import { triggerHaptic } from '../utils/system';

export const SignInScreen: React.FC = () => {
    const [busy, setBusy] = useState<'apple' | 'google' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [emailMode, setEmailMode] = useState(false);

    const handleApple = useCallback(async () => {
        setError(null);
        setBusy('apple');
        try {
            await signInWithApple();
            triggerHaptic('medium');
            // AuthGate's onAuthStateChange listener will swap us out.
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg !== 'CANCELLED') setError(msg);
        } finally {
            setBusy(null);
        }
    }, []);

    const handleGoogle = useCallback(async () => {
        setError(null);
        setBusy('google');
        try {
            await signInWithGoogle();
            triggerHaptic('medium');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg !== 'CANCELLED') setError(msg);
        } finally {
            setBusy(null);
        }
    }, []);

    // Email fallback — opens the existing AuthModal flow (magic link).
    // We render it inline rather than dispatching the legacy
    // `thalassa:navigate` event so it works cleanly without the rest
    // of the app mounted.
    if (emailMode) {
        return <AuthModal isOpen={true} onClose={() => setEmailMode(false)} />;
    }

    return (
        <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col items-center justify-center px-6 overflow-hidden">
            {/* Atmospheric gradient — matches the rest of the app's
                ocean palette without competing with sign-in buttons. */}
            <div className="absolute inset-0 bg-gradient-to-b from-slate-950 via-slate-950 to-sky-950/30 pointer-events-none" />
            <div className="absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-sky-500/10 to-transparent pointer-events-none" />

            {/* Brand */}
            <div className="relative z-10 mb-10 text-center">
                <div className="text-6xl mb-4">⚓</div>
                <h1 className="text-3xl font-black text-white tracking-tight">Thalassa</h1>
                <p className="mt-2 text-sm text-slate-400">Marine Weather &amp; Voyage Log</p>
            </div>

            {/* Buttons */}
            <div className="relative z-10 w-full max-w-sm space-y-3">
                {/* Apple — official styling: white text on black, with
                    the Apple logo. Per Apple HIG. */}
                <button
                    type="button"
                    onClick={() => void handleApple()}
                    disabled={busy !== null}
                    aria-label="Sign in with Apple"
                    className="w-full h-12 rounded-xl bg-white text-black font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50"
                >
                    {busy === 'apple' ? (
                        <span className="text-sm">Signing in…</span>
                    ) : (
                        <>
                            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                            </svg>
                            <span>Sign in with Apple</span>
                        </>
                    )}
                </button>

                {/* Google — white background, dark text, multi-color G */}
                <button
                    type="button"
                    onClick={() => void handleGoogle()}
                    disabled={busy !== null}
                    aria-label="Sign in with Google"
                    className="w-full h-12 rounded-xl bg-white text-slate-900 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50"
                >
                    {busy === 'google' ? (
                        <span className="text-sm">Signing in…</span>
                    ) : (
                        <>
                            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                                <path
                                    fill="#4285F4"
                                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                />
                                <path
                                    fill="#34A853"
                                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                />
                                <path
                                    fill="#FBBC05"
                                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                />
                                <path
                                    fill="#EA4335"
                                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                />
                            </svg>
                            <span>Sign in with Google</span>
                        </>
                    )}
                </button>

                {/* Error banner — covers RLS, network, unknown provider failure */}
                {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 leading-relaxed">
                        {error}
                    </div>
                )}

                {/* Email fallback link */}
                <div className="pt-4 text-center">
                    <button
                        type="button"
                        onClick={() => setEmailMode(true)}
                        disabled={busy !== null}
                        className="text-sm text-slate-400 hover:text-slate-200 active:text-white transition-colors disabled:opacity-50"
                    >
                        Use email instead
                    </button>
                </div>
            </div>

            {/* Footer — legal copy lives elsewhere (Disclaimer modal),
                this is just the gentle aside. */}
            <div className="relative z-10 absolute bottom-6 left-6 right-6 text-center">
                <p className="text-[10px] text-slate-600 leading-relaxed">
                    Signing in unlocks crew sharing, cloud sync, and your public Voyage Log. Your data never leaves your
                    boat without you publishing it.
                </p>
            </div>
        </div>
    );
};
