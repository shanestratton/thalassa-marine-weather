import React, { useState, useEffect, useRef } from 'react';
import { t } from '../theme';
import { supabase } from '../services/supabase';
import { getErrorMessage } from '../utils/createLogger';
import { XIcon, LockIcon, BoatIcon, CheckIcon, DiamondIcon } from './Icons';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { OverlayPortal, type OverlayLayer } from './ui/OverlayPortal';
import { Button } from './ui/Button';
import { useKeyboardOffset } from '../hooks/useKeyboardOffset';

import { createLogger } from '../utils/createLogger';

const log = createLogger('AuthModal');

interface AuthModalProps {
    isOpen: boolean;
    onClose: () => void;
    layer?: OverlayLayer;
}

type AuthStep = 'input' | 'otp' | 'success';

/** Strip invisible Unicode characters and trim whitespace that iOS autocomplete can inject */
const sanitizeEmail = (raw: string): string =>
    raw
        .replace(/[\u200B-\u200D\uFEFF\u00A0\u2060]/g, '')
        .trim()
        .toLowerCase();

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, layer = 'modal' }) => {
    const [step, setStep] = useState<AuthStep>('input');
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resendCooldown, setResendCooldown] = useState(0);
    const keyboardHeight = useKeyboardOffset(isOpen);
    const otpInputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    // Reset state when modal closes
    useEffect(() => {
        if (!isOpen) {
            setStep('input');
            setEmail('');
            setOtp('');
            setError(null);
            setResendCooldown(0);
        }
    }, [isOpen]);

    // Resend cooldown timer
    useEffect(() => {
        if (resendCooldown <= 0) return;
        const timer = setInterval(() => {
            setResendCooldown((prev) => Math.max(0, prev - 1));
        }, 1000);
        return () => clearInterval(timer);
    }, [resendCooldown]);

    // Auto-focus OTP input when step changes
    useEffect(() => {
        if (step === 'otp' && otpInputRef.current) {
            otpInputRef.current.focus();
        }
    }, [step]);

    const focusTrapRef = useFocusTrap(isOpen, { onEscape: onClose });

    /** Detect Supabase rate-limit errors */
    const isRateLimited = (err: unknown): boolean => {
        const msg = getErrorMessage(err).toLowerCase();
        const errObj = err as Partial<HttpError> | undefined;
        const status = errObj?.status ?? errObj?.statusCode;
        if (status === 429) return true;
        return msg.includes('rate limit') || msg.includes('rate_limit');
    };

    /**
     * GoTrue counts an email as "registered" when ANY identity holds it —
     * including Apple/Google identities on an account whose primary email
     * is something else. The OTP lane then 422s with user_already_exists
     * ("User already registered"), which reads as nonsense to someone who
     * never made a password. Field bug Shane 2026-07-09: his gmail lived
     * on the account's Google/Apple identities while the primary email
     * was the unreachable captain@<vessel> address. Map it to advice.
     */
    const isOauthBoundEmail = (err: unknown): boolean => {
        const errObj = err as { code?: string } | undefined;
        if (errObj?.code === 'user_already_exists') return true;
        return getErrorMessage(err).toLowerCase().includes('already registered');
    };

    /** Log raw error for debugging */
    const logAuthError = (context: string, err: unknown) => {
        const msg = getErrorMessage(err);
        const errObj = err as Partial<HttpError> | undefined;
        const status = errObj?.status ?? errObj?.statusCode ?? 'n/a';
        const code = errObj?.code ?? 'n/a';
        log.error(`[AuthModal] ${context}: status=${status} code=${code} msg="${msg}"`, err);
    };

    if (!isOpen) return null;

    // Send OTP code via email
    const handleSendCode = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!supabase) {
            setError('Database connection not established. Check API Keys.');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const cleanEmail = sanitizeEmail(email);
            if (!cleanEmail || !cleanEmail.includes('@')) {
                setError('Please enter a valid email address.');
                setLoading(false);
                return;
            }
            // Keep the exact canonical address used to request the OTP. iOS
            // autocomplete can leave invisible characters in the input; using
            // the raw state at verification makes a valid code impossible.
            setEmail(cleanEmail);
            const { error } = await supabase.auth.signInWithOtp({
                email: cleanEmail,
                options: {
                    shouldCreateUser: true,
                },
            });
            if (error) throw error;

            setStep('otp');
            setResendCooldown(60);
        } catch (err: unknown) {
            logAuthError('handleSendCode', err);
            if (isRateLimited(err)) {
                setError('Too many sign-in attempts. Please wait a few minutes and try again.');
                setResendCooldown(120);
            } else if (isOauthBoundEmail(err)) {
                setError(
                    'This email is linked to an Apple or Google sign-in. Use that sign-in method on your boat app instead — or sign in with the email address shown under Settings → Account & Cloud.',
                );
            } else {
                setError(getErrorMessage(err) || 'Failed to send code. Please try again.');
            }
        } finally {
            setLoading(false);
        }
    };

    // Verify OTP code
    const handleVerifyOtp = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!supabase) {
            setError('Database connection not established.');
            return;
        }

        // Supabase email OTPs can be 6, 7, or 8 digits depending on the
        // project's Auth → Email → "Email OTP Length" setting. Be lenient
        // — the actual length validation happens server-side via
        // verifyOtp. Clamp to digit-only / 6-8 chars so we don't ship
        // junk to the API.
        if (otp.length < 6 || otp.length > 8 || !/^\d+$/.test(otp)) {
            setError('Please enter the code from your email (6–8 digits).');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const result = await supabase.auth.verifyOtp({
                email: sanitizeEmail(email),
                token: otp,
                type: 'email',
            });

            if (result.error) throw result.error;

            if (result.data.session) {
                setStep('success');
                setTimeout(() => onClose(), 1500);
            }
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Invalid or expired code. Please try again.');
            setOtp('');
        } finally {
            setLoading(false);
        }
    };

    // Resend OTP code
    const handleResendCode = async () => {
        if (resendCooldown > 0 || !supabase) return;

        setLoading(true);
        setError(null);

        try {
            const { error } = await supabase.auth.signInWithOtp({
                email: sanitizeEmail(email),
                options: { shouldCreateUser: true },
            });
            if (error) throw error;

            setResendCooldown(60);
            setOtp('');
        } catch (err: unknown) {
            logAuthError('handleResendCode', err);
            if (isRateLimited(err)) {
                setError('Too many sign-in attempts. Please wait a few minutes and try again.');
                setResendCooldown(120);
            } else if (isOauthBoundEmail(err)) {
                setError(
                    'This email is linked to an Apple or Google sign-in. Use that sign-in method on your boat app instead — or sign in with the email address shown under Settings → Account & Cloud.',
                );
            } else {
                setError(getErrorMessage(err) || 'Failed to resend code.');
            }
        } finally {
            setLoading(false);
        }
    };

    // Go back to input step
    const handleChangeInput = () => {
        setStep('input');
        setOtp('');
        setError(null);
        setResendCooldown(0);
    };

    // Handle OTP input - only allow digits
    const handleOtpChange = (value: string) => {
        const digits = value.replace(/\D/g, '').slice(0, 8);
        setOtp(digits);
    };

    return (
        <OverlayPortal
            layer={layer}
            className="flex items-center justify-center p-4"
            style={{
                // Shift the entire flex container up by the keyboard height
                // so the centered modal sits in the visible portion of the screen
                paddingBottom: keyboardHeight > 0 ? keyboardHeight : undefined,
                transition: 'padding-bottom 0.25s ease-out',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-title"
            ref={focusTrapRef}
        >
            <div className="absolute inset-0 bg-black/90 transition-opacity" role="presentation" onClick={onClose} />

            <div
                ref={panelRef}
                className={`relative modal-panel-enter bg-slate-900 w-full min-h-0 max-h-full max-w-md tablet-modal rounded-2xl overflow-y-auto ${t.border.default} shadow-2xl flex flex-col animate-in fade-in zoom-in-95`}
            >
                {/* A 44 px target: the root font scales with the phone
                    (clamp on 4vw), so p-3 around the glyph alone came to 43 px
                    at 393 and 41 px at 375; the px minimum holds it at 44 with
                    the glyph centred. top/right-3 keeps the glyph where p-2 at
                    top/right-4 drew it. */}
                <button
                    type="button"
                    onClick={onClose}
                    className="absolute top-3 right-3 flex min-h-[44px] min-w-[44px] items-center justify-center p-3 bg-black/20 hover:bg-black/40 rounded-full text-white/70 hover:text-white transition-colors z-20"
                    aria-label="Close authentication dialog"
                >
                    <XIcon className="w-5 h-5" />
                </button>

                <div
                    className={`${keyboardHeight > 0 ? 'p-4 pt-10' : 'p-8'} flex flex-col items-center text-center transition-all duration-200`}
                >
                    {/* Hero section — collapses to 0 when the on-screen
                        keyboard appears. Previously the closed-state cap
                        was 200 px, but icon + title + paragraph need
                        ~220 px → the bottom of the description was clipped
                        and the form slid up under it, making the layout
                        read as jumbled. 'none' lets the hero size to its
                        natural content when the keyboard isn't up. */}
                    <div
                        style={{
                            maxHeight: keyboardHeight > 0 ? 0 : 'none',
                            opacity: keyboardHeight > 0 ? 0 : 1,
                            overflow: 'hidden',
                            transition: 'max-height 0.15s ease-out, opacity 0.1s ease-out',
                        }}
                    >
                        <div className="w-16 h-16 bg-sky-500/20 rounded-full flex items-center justify-center mb-6 border border-sky-500/30 shadow-lg mx-auto">
                            <LockIcon className="w-8 h-8 text-sky-400" />
                        </div>

                        <h2 id="auth-title" className="text-2xl font-bold text-white mb-2">
                            {step === 'success' ? 'Welcome aboard' : 'Sync your logs'}
                        </h2>
                        <p className="text-sm text-gray-400 mb-6 max-w-xs leading-relaxed">
                            {step === 'input' &&
                                'Sign in to synchronise your vessel profile, saved routes, and preferences across all your devices.'}
                            {step === 'otp' && `We sent a verification code to ${email}`}
                            {step === 'success' && "You're now signed in and your data will sync automatically."}
                        </p>
                    </div>

                    {/* Compact title shown when keyboard is open */}
                    {keyboardHeight > 0 && step !== 'success' && (
                        <h2 className="text-lg font-bold text-white mb-3">
                            {step === 'input' ? 'Sign in' : `Code sent to ${email}`}
                        </h2>
                    )}

                    {/* Success State */}
                    {step === 'success' && (
                        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-6 w-full animate-in fade-in slide-in-from-bottom-4">
                            <div className="w-12 h-12 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-500/20">
                                <CheckIcon className="w-6 h-6 text-white" />
                            </div>
                            <h3 className="text-white font-bold mb-1">Signed in</h3>
                            <p className="text-sm text-emerald-200/80">Your logs are now syncing…</p>
                        </div>
                    )}

                    {/* Email Input Step */}
                    {step === 'input' && (
                        <form onSubmit={handleSendCode} className="w-full space-y-4">
                            <div className="text-left">
                                <label
                                    htmlFor="auth-email"
                                    className="text-sm uppercase font-bold text-gray-400 mb-1.5 ml-1 block"
                                >
                                    Email address
                                </label>
                                <input
                                    id="auth-email"
                                    type="email"
                                    inputMode="email"
                                    autoComplete="email"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    aria-describedby="auth-email-help"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value.replace(/\s+/g, ''))}
                                    placeholder="skipper@vessel.com"
                                    className={`w-full bg-slate-900 ${t.border.default} rounded-xl px-4 py-3 text-base text-white focus:border-sky-500 outline-hidden transition-colors`}
                                    required
                                    autoFocus
                                />
                                <p id="auth-email-help" className="mt-2 text-sm leading-relaxed text-slate-300">
                                    We'll email you a one-time code. No password needed. Your first sign-in creates your
                                    account.
                                </p>
                            </div>

                            {error && (
                                <div
                                    className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200"
                                    aria-live="assertive"
                                >
                                    {error}
                                </div>
                            )}

                            {/* The house dialog primary (<Button variant="primary">),
                                the same sky fill as the sheet's 'Sign in with email'
                                and every SignInButton; a white slab was a fifth
                                primary shape. The visible words are the name, and
                                they stay beside the spinner while busy (UX scorecard
                                run 10: a bare spinner left the button wordless), as
                                ConfirmDialog does. */}
                            <Button
                                variant="primary"
                                type="submit"
                                disabled={loading || !supabase || resendCooldown > 0}
                                aria-busy={loading || undefined}
                                className="w-full"
                            >
                                {loading ? (
                                    <>
                                        <span
                                            aria-hidden="true"
                                            className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                                        />
                                        Sending code…
                                    </>
                                ) : resendCooldown > 0 ? (
                                    `Try again in ${resendCooldown}s`
                                ) : (
                                    'Send code'
                                )}
                            </Button>

                            {!supabase && (
                                <p className="text-sm text-red-400 mt-2">Database not configured. Keys missing.</p>
                            )}
                        </form>
                    )}

                    {/* OTP Verification Step */}
                    {step === 'otp' && (
                        <form onSubmit={handleVerifyOtp} className="w-full space-y-4">
                            <div className="text-left">
                                <label
                                    htmlFor="auth-otp"
                                    className="text-sm uppercase font-bold text-gray-400 mb-1.5 ml-1 block"
                                >
                                    Verification code
                                </label>
                                <input
                                    id="auth-otp"
                                    ref={otpInputRef}
                                    type="text"
                                    inputMode="numeric"
                                    value={otp}
                                    onChange={(e) => handleOtpChange(e.target.value)}
                                    placeholder="••••••"
                                    className={`w-full bg-slate-900 ${t.border.default} rounded-xl px-4 py-4 text-white text-center text-xl font-mono tracking-[0.3em] focus:border-sky-500 outline-hidden transition-colors`}
                                    // Accept Supabase's 6-8 digit range; the
                                    // dashboard setting picks one. Hardcoding 8
                                    // locked users out when the project setting
                                    // drifted to 6.
                                    maxLength={8}
                                    autoComplete="one-time-code"
                                />
                            </div>

                            {error && (
                                <div
                                    className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200"
                                    aria-live="assertive"
                                >
                                    {error}
                                </div>
                            )}

                            <Button
                                variant="primary"
                                type="submit"
                                disabled={loading || otp.length < 6}
                                aria-busy={loading || undefined}
                                className="w-full"
                            >
                                {loading ? (
                                    <>
                                        <span
                                            aria-hidden="true"
                                            className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                                        />
                                        Verifying code…
                                    </>
                                ) : (
                                    // The name screen readers already heard, now on
                                    // screen too (the beta gate pins it).
                                    'Verify email code'
                                )}
                            </Button>

                            <div className="flex items-center justify-between text-sm">
                                <button
                                    type="button"
                                    onClick={handleChangeInput}
                                    className="min-h-[44px] inline-flex items-center gap-1 px-2 text-gray-400 hover:text-white transition-colors"
                                >
                                    <span aria-hidden="true">←</span> Change email
                                </button>
                                <button
                                    type="button"
                                    onClick={handleResendCode}
                                    disabled={resendCooldown > 0 || loading}
                                    className={`min-h-[44px] inline-flex items-center px-2 transition-colors ${resendCooldown > 0 ? 'text-gray-400' : 'text-sky-400 hover:text-sky-300'}`}
                                >
                                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>

                <div className="bg-black/20 p-4 border-t border-white/5 flex items-center justify-center gap-6">
                    <div className="flex items-center gap-2 text-sm text-gray-400 font-medium">
                        <DiamondIcon className="w-3 h-3 text-sky-400" /> Pro sync
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-400 font-medium">
                        <BoatIcon className="w-3 h-3 text-sky-400" /> Crew sharing
                    </div>
                </div>
            </div>
        </OverlayPortal>
    );
};
