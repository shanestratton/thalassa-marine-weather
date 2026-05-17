/**
 * SignInScreen — the canonical sign-in surface.
 *
 * Single screen, multiple doors. Every "you need to be signed in"
 * CTA across the app — Settings → Account, Crew Management,
 * Scuttlebutt DMs, Marketplace listings, Voyage Log publish,
 * Vessel restore, route save — opens THIS component. Apple +
 * Google as primary, email as a fallback. One look, one path.
 *
 * Two modes
 * ---------
 * 1. CONTROLLED — pass `isOpen` + `onClose`. Renders as a full-
 *    screen modal that dismisses on auth success (or when the
 *    user taps the close button). This is the mode every caller
 *    in the app uses today.
 *
 * 2. UNCONTROLLED — omit `isOpen` (or pass undefined). Renders
 *    unconditionally. Used historically by the boot-time AuthGate
 *    (removed in PR1) and kept available for any future flow
 *    that needs an always-rendered sign-in (e.g. a hard-gated
 *    publish step).
 *
 * Apple + Google buttons are primary (App Store policy + best UX
 * on iOS). Email/OTP is a "Use email instead" link below — kept
 * because:
 *   - existing users signed up that way and must keep their data
 *   - recovery lane if Apple/Google has an outage or is locked
 *
 * On a sailing app, identity reliability beats minor UI clutter.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { signInWithApple, signInWithGoogle } from '../services/auth/SocialAuthService';
import { AuthModal } from './AuthModal';
import { triggerHaptic } from '../utils/system';
import { XIcon } from './Icons';
import { useAuthStore } from '../stores/authStore';
// Production brand lockup — compass mark + "THALASSA" wordmark +
// "MARINE DATA & NAVIGATION" descriptor, generated from the Gemini
// Pro concept via Upscayl 4x → Vectorizer.AI → 3-pass SVGO cleanup
// (see assets/brand/CLEANING_NOTES.md). White-on-dark variant.
// Vite resolves the import to a hashed URL string at build time.
import brandLockup from '../assets/brand/full-lockup-dark.svg';

// ─── Brand palette (2026-05-17 logo direction) ────────────────────
// Distinct from the cyan UI palette used elsewhere in the app — this
// is the BRAND palette, locked in `assets/brand/palette.txt` and
// baked into the lockup SVG itself. The constants below are used by
// SignInScreen for the accent-coloured tagline middots and for the
// pulse drop-shadow keyframe (see <style> block at the bottom). Kept
// as a typed const so other conversion-moment surfaces (splash,
// upgrade modal, share cards) can pull from the same source of truth.
//   primary      — deep sea green   (teal-700, pulse halo depth)
//   primarySoft  — sea-foam teal    (teal-300, pulse highlight; also
//                                    the cyan accents inside the SVG)
//   accent       — safety orange    (orange-400, tagline middots)
//   accentDeep   — deep orange      (orange-500, reserved for light surfaces)
const BRAND = {
    primary: '#0F766E',
    primarySoft: '#5EEAD4',
    accent: '#FB923C',
    accentDeep: '#F97316',
} as const;

interface SignInScreenProps {
    /**
     * Controlled mode. When `true`, the screen is visible. When
     * `false`, returns null. When `undefined`, the screen renders
     * unconditionally (legacy uncontrolled mode).
     */
    isOpen?: boolean;
    /**
     * Called when the user dismisses the screen (close button) OR
     * when auth succeeds in controlled mode. Required for the
     * controlled mode close button to appear.
     */
    onClose?: () => void;
    /**
     * Contextual one-liner that explains WHY the user is being
     * asked to sign in right now. Renders above the buttons in a
     * subtle sky-blue italic. Examples:
     *   - "Sign in to save your route to the cloud"
     *   - "Sign in to message crew"
     *   - "Sign in to restore your saved vessel details"
     * When omitted, just shows the tagline.
     */
    prompt?: string;
}

export const SignInScreen: React.FC<SignInScreenProps> = ({ isOpen, onClose, prompt }) => {
    const [busy, setBusy] = useState<'apple' | 'google' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [emailMode, setEmailMode] = useState(false);
    const authedUser = useAuthStore((s) => s.user);

    // Auto-dismiss in controlled mode once authentication succeeds.
    // The Apple/Google/email handlers all push the new session into
    // authStore via supabase.auth.onAuthStateChange; we just react
    // to that landing.
    useEffect(() => {
        if (isOpen && authedUser && onClose) {
            onClose();
        }
    }, [authedUser, isOpen, onClose]);

    const handleApple = useCallback(async () => {
        setError(null);
        setBusy('apple');
        try {
            await signInWithApple();
            triggerHaptic('medium');
            // Dismissal handled by the effect above watching authedUser.
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

    // Controlled mode: respect isOpen.
    if (isOpen === false) return null;

    // Email fallback — opens the AuthModal flow (magic link / OTP).
    // Rendered inline rather than via the legacy `thalassa:navigate`
    // event so it works cleanly without the rest of the app mounted.
    // In controlled mode, completing email auth flows back through
    // the auth-store effect → onClose, same as Apple/Google.
    if (emailMode) {
        return (
            <AuthModal
                isOpen={true}
                onClose={() => {
                    setEmailMode(false);
                    // If the outer SignInScreen is controlled, also
                    // close it — the user backed out of email mode and
                    // we don't want to strand them on the sign-in
                    // screen if they explicitly cancelled.
                    // (When auth SUCCEEDS via email, the authedUser
                    // effect above will close the outer screen too.)
                }}
            />
        );
    }

    return (
        <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col items-center justify-center px-6 overflow-hidden">
            {/* Atmospheric backdrop — deeper ocean gradient with a
                soft aurora-like sky glow up top. Makes the screen feel
                like a marine destination instead of a generic auth
                form. All decorative, all behind pointer-events:none. */}
            <div className="absolute inset-0 bg-gradient-to-b from-slate-950 via-slate-950 to-sky-950/40 pointer-events-none" />
            <div className="absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-sky-500/15 via-sky-500/5 to-transparent pointer-events-none" />
            {/* Subtle horizon line — sits at ~40% down, the eye-line
                of a sailor looking out from the cockpit. Pure
                atmospherics, 1px of cyan glow. */}
            <div
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                    top: '42%',
                    height: '1px',
                    background:
                        'linear-gradient(to right, transparent, rgba(103,232,249,0.35), rgba(103,232,249,0.55), rgba(103,232,249,0.35), transparent)',
                    filter: 'blur(0.5px)',
                }}
            />

            {/* Close button — only shown in controlled mode. Tap-
                target 44x44 per Apple HIG. */}
            {onClose && (
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close sign-in"
                    className="absolute top-6 right-6 z-20 w-11 h-11 rounded-full bg-white/5 hover:bg-white/10 active:bg-white/15 flex items-center justify-center text-white/70 transition-colors backdrop-blur-md"
                    style={{ top: 'max(1.5rem, env(safe-area-inset-top))' }}
                >
                    <XIcon className="w-5 h-5" />
                </button>
            )}

            {/* ─── Brand lockup ─────────────────────────────────
                The cleaned production logo: compass rose with wind
                /wave swirls (white + cyan accents), "THALASSA"
                wordmark, and "MARINE DATA & NAVIGATION" descriptor —
                all baked into one SVG so proportions and weights
                stay exactly as designed. The pulse keyframe (below)
                animates a teal drop-shadow around it so the mark
                breathes like a beacon. */}
            <div className="relative z-10 mb-7 text-center">
                <div
                    className="mx-auto w-60 h-60 sm:w-64 sm:h-64 flex items-center justify-center"
                    style={{
                        animation: 'signInPulse 4s ease-in-out infinite',
                    }}
                >
                    <img
                        src={brandLockup}
                        alt="Thalassa — Marine Data & Navigation"
                        className="w-full h-full object-contain"
                        draggable={false}
                    />
                </div>
                {/*
                    Positioning tagline — separate copy from the
                    brand descriptor ("MARINE DATA & NAVIGATION")
                    baked into the lockup SVG. This is the conversion
                    promise: what signing in unlocks. Middot accents
                    tinted safety-orange to echo the brand palette
                    against the sky-300 line.
                */}
                <p className="mt-3 text-[13px] font-semibold tracking-wider text-sky-300/90">
                    <span>Plan it</span>
                    <span className="mx-1.5" style={{ color: BRAND.accent }}>
                        ·
                    </span>
                    <span>Sail it</span>
                    <span className="mx-1.5" style={{ color: BRAND.accent }}>
                        ·
                    </span>
                    <span>Share it</span>
                </p>
            </div>

            {/* Buttons — controlled by Apple HIG. The CONTAINER gets
                a soft sky frame so the area reads as a deliberate
                conversion moment, not just two stock buttons floating
                on a dark page. */}
            <div className="relative z-10 w-full max-w-sm">
                {/* Optional contextual prompt — when a caller says
                    "Sign in to restore your vessel" we render it
                    here in a quiet italic sky line above the buttons.
                    Makes the moment feel specific to what the user
                    was just doing. */}
                {prompt && (
                    <div className="mb-5 text-center">
                        <p className="text-[13px] italic text-sky-200/90 leading-snug">{prompt}</p>
                    </div>
                )}

                <div className="space-y-3">
                    {/* Apple — official styling: white background, black
                        text, with the Apple logo. Per Apple HIG. */}
                    <button
                        type="button"
                        onClick={() => void handleApple()}
                        disabled={busy !== null}
                        aria-label="Sign in with Apple"
                        className="w-full h-12 rounded-xl bg-white text-black font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50 shadow-lg shadow-black/40"
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
                        className="w-full h-12 rounded-xl bg-white text-slate-900 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50 shadow-lg shadow-black/40"
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
                </div>

                {/* Error banner — covers RLS, network, unknown provider failure */}
                {error && (
                    <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 leading-relaxed">
                        {error}
                    </div>
                )}

                {/* Email fallback link */}
                <div className="pt-5 text-center">
                    <button
                        type="button"
                        onClick={() => setEmailMode(true)}
                        disabled={busy !== null}
                        className="text-sm text-slate-400 hover:text-slate-200 active:text-white transition-colors disabled:opacity-50 underline-offset-4 hover:underline"
                    >
                        Use email instead
                    </button>
                </div>
            </div>

            {/* Footer — legal copy lives elsewhere (Disclaimer modal),
                this is the gentle trust aside. */}
            <div className="relative z-10 absolute bottom-6 left-6 right-6 text-center">
                <p className="text-[10px] text-slate-500 leading-relaxed max-w-xs mx-auto">
                    Signing in unlocks crew sharing, cloud sync, and your public Voyage Log.
                    <br />
                    Your data never leaves your boat without you publishing it.
                </p>
            </div>

            {/* Pulse keyframe — drop-shadow filter rather than the
                old disc-based box-shadow, because the lockup is now a
                free-standing image (no surrounding container disc).
                Two stacked drop-shadows: a tight inner glow that
                pulses (the beacon breath) plus a wider soft halo
                (depth on the dark slate). Teal-300 hues to match the
                brand palette + the cyan accents in the lockup itself.
                Scoped to this screen via inline <style>; no global
                CSS pollution. */}
            <style>{`
                @keyframes signInPulse {
                    0%, 100% {
                        filter:
                            drop-shadow(0 0 14px rgba(94, 234, 212, 0.12))
                            drop-shadow(0 8px 32px rgba(15, 118, 110, 0.30));
                    }
                    50% {
                        filter:
                            drop-shadow(0 0 28px rgba(94, 234, 212, 0.28))
                            drop-shadow(0 12px 40px rgba(15, 118, 110, 0.40));
                    }
                }
            `}</style>
        </div>
    );
};
