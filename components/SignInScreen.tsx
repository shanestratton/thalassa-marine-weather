/**
 * SignInScreen — the canonical sign-in surface.
 *
 * Single screen, multiple doors. Every "you need to be signed in"
 * CTA across the app — Settings → Account, Crew Management,
 * Scuttlebutt DMs, Voyage Log publishing,
 * Vessel restore, route save — opens THIS component. Email OTP is the
 * public-beta door. Native Apple is compiled in but remains fail-closed until
 * its complete TN3194 server lifecycle is deployed and explicitly enabled.
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
 * Browser Apple uses its released Services-ID OAuth lane. Native Apple stays
 * separately held until its full lifecycle gate is enabled, with email as the
 * recovery lane throughout.
 *
 * On a sailing app, identity reliability beats minor UI clutter.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { APPLE_WEB_SIGN_IN_ENABLED, signInWithApple, signInWithAppleOnWeb } from '../services/auth/SocialAuthService';
import { GOOGLE_SIGN_IN_ENABLED, signInWithGoogle, signInWithGoogleOnWeb } from '../services/auth/googleSignIn';
import { AuthModal } from './AuthModal';
import { triggerHaptic } from '../utils/system';
import { XIcon } from './Icons';
import { useAuthStore } from '../stores/authStore';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { OverlayPortal } from './ui/OverlayPortal';
// Ornate compass MARK only — NOT the full lockup. The traced lockup baked
// "THALASSA" in as raster-vectorised paths that rendered blocky/jagged at
// display size (Shane 2026-07-17: "the logo has blockey text… amateur
// stuff"). The compass artwork is fine; the wordmark + descriptor are now
// crisp LIVE TEXT below. Vite resolves the import to a hashed URL string.
import markDark from '../assets/brand/mark-dark.svg';
// Locked brand palette — single source of truth in theme.ts. Used
// here for the accent-coloured tagline middots and the pulse drop-
// shadow keyframe at the bottom of this file. See theme.ts for the
// two-palette discipline rules (UI vs BRAND).
import { BRAND } from '../theme';

// Fail closed until the TN3194 migration, both authenticated Edge Functions,
// Apple server credentials, and the signed server-notification receiver are
// deployed and verified. A missing variable must never expose a broken door.
const APPLE_NATIVE_SIGN_IN_ENABLED = import.meta.env.VITE_APPLE_SIGN_IN_ENABLED === 'true';

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
    const primaryActionRef = useRef<HTMLButtonElement>(null);
    const emailModeWasOpenRef = useRef(false);
    // Native and browser Apple are separate release lanes. Native wraps a
    // Capacitor plugin and remains held behind its entitlement/lifecycle gate;
    // browser Apple uses the configured Services ID through Supabase OAuth.
    const isNative = Capacitor.isNativePlatform();
    const appleNativeEnabled = isNative && APPLE_NATIVE_SIGN_IN_ENABLED;
    const appleWebEnabled = !isNative && APPLE_WEB_SIGN_IN_ENABLED;
    const appleEnabled = appleNativeEnabled || appleWebEnabled;
    // Google works on both lanes: native PKCE and the web OAuth redirect share
    // the configured provider client list.
    const googleEnabled = GOOGLE_SIGN_IN_ENABLED;

    // Auto-dismiss in controlled mode once authentication succeeds.
    // The Apple/email handlers push the new session into
    // authStore via supabase.auth.onAuthStateChange; we just react
    // to that landing.
    useEffect(() => {
        if (isOpen && authedUser && onClose) {
            onClose();
        }
    }, [authedUser, isOpen, onClose]);

    // A nested portal can cause some WebViews to report <body> as the
    // previously focused element once the parent becomes aria-hidden.
    // Explicitly return to the action that opened email mode as a reliable
    // fallback to the nested dialog's normal focus restoration.
    useEffect(() => {
        if (emailModeWasOpenRef.current && !emailMode && isOpen !== false) {
            primaryActionRef.current?.focus();
        }
        emailModeWasOpenRef.current = emailMode;
    }, [emailMode, isOpen]);

    const focusTrapRef = useFocusTrap<HTMLDivElement>(isOpen !== false, {
        initialFocusRef: primaryActionRef,
        onEscape: onClose,
    });

    const handleApple = useCallback(async () => {
        setError(null);
        setBusy('apple');
        try {
            if (!appleEnabled) throw new Error('Apple sign-in is not enabled in this beta. Use email instead.');
            if (isNative) {
                await signInWithApple();
                triggerHaptic('medium');
                // Dismissal handled by the effect above watching authedUser.
            } else {
                await signInWithAppleOnWeb();
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg !== 'CANCELLED') setError(msg);
        } finally {
            setBusy(null);
        }
    }, [appleEnabled, isNative]);

    const handleGoogle = useCallback(async () => {
        setError(null);
        setBusy('google');
        try {
            if (!googleEnabled) throw new Error('Google sign-in is not enabled in this build. Use email instead.');
            // Native opens the system browser and awaits the redirect; web
            // navigates away entirely and resumes via detectSessionInUrl.
            if (isNative) {
                await signInWithGoogle();
                triggerHaptic('medium');
            } else {
                await signInWithGoogleOnWeb();
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg !== 'CANCELLED') setError(msg);
        } finally {
            setBusy(null);
        }
    }, [googleEnabled, isNative]);

    // Controlled mode: respect isOpen.
    if (isOpen === false) return null;

    return (
        <>
            <OverlayPortal
                ref={focusTrapRef}
                role="dialog"
                aria-modal={emailMode ? undefined : 'true'}
                aria-labelledby="sign-in-title"
                aria-hidden={emailMode || undefined}
                className="bg-slate-950 flex flex-col items-center justify-center px-6 overflow-hidden"
            >
                <h2 id="sign-in-title" className="sr-only">
                    Sign in to Thalassa
                </h2>
                {/* Atmospheric backdrop — deeper ocean gradient with a
                soft aurora-like sky glow up top. Makes the screen feel
                like a marine destination instead of a generic auth
                form. All decorative, all behind pointer-events:none. */}
                <div className="absolute inset-0 bg-linear-to-b from-slate-950 via-slate-950 to-sky-950/40 pointer-events-none" />
                <div className="absolute inset-x-0 top-0 h-72 bg-linear-to-b from-sky-500/15 via-sky-500/5 to-transparent pointer-events-none" />
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
                animates a teal drop-shadow-sm around it so the mark
                breathes like a beacon. */}
                <div className="relative z-10 mb-8 flex flex-col items-center text-center">
                    <div
                        className="w-40 sm:w-44 flex items-center justify-center"
                        style={{
                            animation: 'signInPulse 4s ease-in-out infinite',
                        }}
                    >
                        <img src={markDark} alt="" className="w-full object-contain" draggable={false} />
                    </div>
                    {/* CRISP live wordmark (was the blocky baked-in SVG text).
                    Wide tracking reads as a premium marine wordmark; the
                    equal paddingLeft cancels the trailing letter-space so
                    the caps stay optically centred. */}
                    <h1
                        className="mt-5 text-[2.75rem] sm:text-6xl font-black uppercase leading-none text-white"
                        style={{ letterSpacing: '0.18em', paddingLeft: '0.18em' }}
                    >
                        Thalassa
                    </h1>
                    <p
                        className="mt-2.5 text-[10px] sm:text-[11px] font-bold uppercase text-white/60"
                        style={{ letterSpacing: '0.34em', paddingLeft: '0.34em' }}
                    >
                        Marine Data &amp; Navigation
                    </p>
                    {/* Positioning tagline — the conversion promise. Middot
                    accents tinted to the brand palette against the sky line. */}
                    <p className="mt-4 text-[13px] font-semibold tracking-wider text-sky-300/90">
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
                        {/* Web/desktop primary: email OTP. It stays FIRST and keeps
                        the focus ref; social providers follow as alternatives. */}
                        {!appleNativeEnabled && (
                            <button
                                ref={primaryActionRef}
                                type="button"
                                onClick={() => setEmailMode(true)}
                                aria-label="Sign in with email"
                                className="w-full h-12 rounded-xl bg-sky-500 hover:bg-sky-400 text-white font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform shadow-lg shadow-black/40"
                            >
                                Sign in with email
                            </button>
                        )}
                        {/* Native Apple uses the system plugin's ID-token flow;
                            browser Apple uses the separately configured Services
                            ID and Supabase OAuth callback. */}
                        {appleEnabled && (
                            <>
                                {/* Apple — official styling: white background, black
                        text, with the Apple logo. Per Apple HIG. */}
                                <button
                                    ref={appleNativeEnabled ? primaryActionRef : undefined}
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
                                            <svg
                                                className="w-5 h-5"
                                                viewBox="0 0 24 24"
                                                fill="currentColor"
                                                aria-hidden="true"
                                            >
                                                <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                                            </svg>
                                            <span>Sign in with Apple</span>
                                        </>
                                    )}
                                </button>
                            </>
                        )}
                        {/* Google — official styling: white surface with the
                            four-colour mark, per Google's branding guidelines.
                            Sits under Apple on iOS (Apple HIG expects the
                            Apple button to lead) and under email on the web. */}
                        {googleEnabled && (
                            <button
                                type="button"
                                onClick={() => void handleGoogle()}
                                disabled={busy !== null}
                                aria-label="Sign in with Google"
                                className="w-full h-12 rounded-xl bg-white text-[#1f1f1f] font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50 shadow-lg shadow-black/40"
                            >
                                {busy === 'google' ? (
                                    <span className="text-sm">Signing in…</span>
                                ) : (
                                    <>
                                        <svg className="w-5 h-5" viewBox="0 0 48 48" aria-hidden="true">
                                            <path
                                                fill="#EA4335"
                                                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                                            />
                                            <path
                                                fill="#4285F4"
                                                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                                            />
                                            <path
                                                fill="#FBBC05"
                                                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                                            />
                                            <path
                                                fill="#34A853"
                                                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                                            />
                                        </svg>
                                        <span>Sign in with Google</span>
                                    </>
                                )}
                            </button>
                        )}
                        {!appleEnabled && (
                            <p className="px-2 text-center text-xs leading-relaxed text-slate-400">
                                Apple sign-in is not enabled in this beta build; use email.
                            </p>
                        )}
                    </div>

                    {/* Error banner — covers RLS, network, unknown provider failure */}
                    {error && (
                        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 leading-relaxed">
                            {error}
                        </div>
                    )}

                    {/* Email fallback link — native only; on web email is
                    already the primary button above. */}
                    {appleNativeEnabled && (
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
                    )}
                </div>

                {/* Footer — the gentle trust aside (legal copy lives in the
                Disclaimer modal). PINNED to the viewport bottom: it had BOTH
                `relative` and `absolute` classes, and when `relative` won the
                cascade it fell into normal flow right under the button and
                overlapped it (Shane 2026-07-17: "words under the CTA button").
                Pure absolute now, clear of the centred content. */}
                <div className="absolute bottom-6 left-6 right-6 z-10 text-center">
                    <p className="text-[10px] text-slate-500 leading-relaxed max-w-xs mx-auto">
                        Signing in enables automatic private cloud sync. Location is sent only when a weather, map,
                        Guardian, route, or AI feature you request needs it.
                        <br />
                        Community content is public only when you choose to share or publish.{' '}
                        <a
                            href="https://www.thalassawx.app/terms.html"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline decoration-slate-600 underline-offset-2 hover:text-slate-300"
                        >
                            Terms &amp; Privacy
                        </a>
                    </p>
                </div>

                {/* Pulse keyframe — drop-shadow-sm filter rather than the
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
            </OverlayPortal>

            {/* Keep the outer dialog mounted while the OTP flow is open.
                This preserves its focus trap and lets the nested dialog
                restore focus to the email action when it closes. */}
            <AuthModal isOpen={emailMode} onClose={() => setEmailMode(false)} layer="nested" />
        </>
    );
};
