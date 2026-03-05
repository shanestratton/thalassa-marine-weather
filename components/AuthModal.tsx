
import React, { useState, useEffect, useRef } from 'react';
import { t } from '../theme';
import { supabase } from '../services/supabase';
import { getErrorMessage } from '../utils/logger';
import { XIcon, LockIcon, BoatIcon, CheckIcon, DiamondIcon } from './Icons';
import { useFocusTrap } from '../hooks/useAccessibility';

interface AuthModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type AuthStep = 'input' | 'otp' | 'success';

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose }) => {
    const [step, setStep] = useState<AuthStep>('input');
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [resendCooldown, setResendCooldown] = useState(0);
    const otpInputRef = useRef<HTMLInputElement>(null);

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
            setResendCooldown(prev => Math.max(0, prev - 1));
        }, 1000);
        return () => clearInterval(timer);
    }, [resendCooldown]);

    // Auto-focus OTP input when step changes
    useEffect(() => {
        if (step === 'otp' && otpInputRef.current) {
            otpInputRef.current.focus();
        }
    }, [step]);

    const focusTrapRef = useFocusTrap(isOpen);

    if (!isOpen) return null;

    // Send OTP code via email
    const handleSendCode = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!supabase) {
            setError("Database connection not established. Check API Keys.");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const { error } = await supabase.auth.signInWithOtp({
                email,
                options: {
                    shouldCreateUser: true,
                },
            });
            if (error) throw error;

            setStep('otp');
            setResendCooldown(60);
        } catch (err: unknown) {
            setError(getErrorMessage(err) || "Failed to send code. Please try again.");
        } finally {
            setLoading(false);
        }
    };

    // Verify OTP code
    const handleVerifyOtp = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!supabase) {
            setError("Database connection not established.");
            return;
        }

        if (otp.length !== 8) {
            setError("Please enter the 8-digit code.");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const result = await supabase.auth.verifyOtp({
                email,
                token: otp,
                type: 'email',
            });

            if (result.error) throw result.error;

            if (result.data.session) {
                setStep('success');
                setTimeout(() => onClose(), 1500);
            }
        } catch (err: unknown) {
            setError(getErrorMessage(err) || "Invalid or expired code. Please try again.");
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
                email,
                options: { shouldCreateUser: true },
            });
            if (error) throw error;

            setResendCooldown(60);
            setOtp('');
        } catch (err: unknown) {
            setError(getErrorMessage(err) || "Failed to resend code.");
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
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="auth-title" ref={focusTrapRef}>
            <div className="absolute inset-0 bg-black/90 transition-opacity" onClick={onClose} />

            <div className="relative modal-panel-enter bg-slate-900 w-full max-w-md tablet-modal rounded-2xl overflow-hidden ${t.border.default} shadow-2xl flex flex-col animate-in fade-in zoom-in-95">
                <button onClick={onClose} className="absolute top-4 right-4 p-2 bg-black/20 hover:bg-black/40 rounded-full text-white/70 hover:text-white transition-colors z-20" aria-label="Close">
                    <XIcon className="w-5 h-5" />
                </button>

                <div className="p-8 flex flex-col items-center text-center">
                    <div className="w-16 h-16 bg-sky-500/20 rounded-full flex items-center justify-center mb-6 border border-sky-500/30 shadow-lg">
                        <LockIcon className="w-8 h-8 text-sky-400" />
                    </div>

                    <h2 className="text-2xl font-bold text-white mb-2">
                        {step === 'success' ? 'Welcome Aboard!' : 'Sync Your Logs'}
                    </h2>
                    <p className="text-sm text-gray-400 mb-6 max-w-xs leading-relaxed">
                        {step === 'input' && "Sign in to synchronize your vessel profile, saved routes, and preferences across all your devices."}
                        {step === 'otp' && `We sent an 8-digit code to ${email}`}
                        {step === 'success' && "You're now signed in and your data will sync automatically."}
                    </p>

                    {/* Success State */}
                    {step === 'success' && (
                        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-6 w-full animate-in fade-in slide-in-from-bottom-4">
                            <div className="w-12 h-12 bg-emerald-500 rounded-full flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-500/20">
                                <CheckIcon className="w-6 h-6 text-white" />
                            </div>
                            <h3 className="text-white font-bold mb-1">Signed In Successfully</h3>
                            <p className="text-sm text-emerald-200/80">Your logs are now syncing...</p>
                        </div>
                    )}

                    {/* Email Input Step */}
                    {step === 'input' && (
                        <form onSubmit={handleSendCode} className="w-full space-y-4">
                            <div className="text-left">
                                <label className="text-sm uppercase font-bold text-gray-500 mb-1.5 ml-1 block">Email Address</label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="captain@vessel.com"
                                    className={`w-full bg-slate-900 ${t.border.default} rounded-xl px-4 py-3 text-white focus:border-sky-500 outline-none transition-colors`}
                                    required
                                    autoFocus
                                />
                            </div>

                            {error && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200" aria-live="assertive">
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={loading || !supabase}
                                className={`w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 ${!supabase ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}`}
                            >
                                {loading ? <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" /> : "Send Code"}
                            </button>

                            {!supabase && (
                                <p className="text-sm text-red-400 mt-2">Database not configured. Keys missing.</p>
                            )}
                        </form>
                    )}

                    {/* OTP Verification Step */}
                    {step === 'otp' && (
                        <form onSubmit={handleVerifyOtp} className="w-full space-y-4">
                            <div className="text-left">
                                <label className="text-sm uppercase font-bold text-gray-500 mb-1.5 ml-1 block">8-Digit Code</label>
                                <input
                                    ref={otpInputRef}
                                    type="text"
                                    inputMode="numeric"
                                    value={otp}
                                    onChange={(e) => handleOtpChange(e.target.value)}
                                    placeholder="00000000"
                                    className={`w-full bg-slate-900 ${t.border.default} rounded-xl px-4 py-4 text-white text-center text-xl font-mono tracking-[0.3em] focus:border-sky-500 outline-none transition-colors`}
                                    maxLength={8}
                                    autoComplete="one-time-code"
                                />
                            </div>

                            {error && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-200" aria-live="assertive">
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={loading || otp.length !== 8}
                                className={`w-full py-3.5 bg-white text-slate-900 font-bold rounded-xl shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 ${otp.length !== 8 ? 'opacity-50' : 'hover:bg-gray-100'}`}
                            >
                                {loading ? <div className="w-4 h-4 border-2 border-slate-900 border-t-transparent rounded-full animate-spin" /> : "Verify Code"}
                            </button>

                            <div className="flex items-center justify-between text-sm">
                                <button
                                    type="button"
                                    onClick={handleChangeInput}
                                    className="text-gray-400 hover:text-white transition-colors"
                                    aria-label="Change Email">
                                    ← Change email
                                </button>
                                <button
                                    type="button"
                                    onClick={handleResendCode}
                                    disabled={resendCooldown > 0 || loading}
                                    className={`transition-colors ${resendCooldown > 0 ? 'text-gray-500' : 'text-sky-400 hover:text-sky-300'}`}
                                >
                                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>

                <div className="bg-black/20 p-4 border-t border-white/5 flex items-center justify-center gap-6">
                    <div className="flex items-center gap-2 text-sm text-gray-500 font-medium">
                        <DiamondIcon className="w-3 h-3 text-sky-400" /> Pro Sync
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-500 font-medium">
                        <BoatIcon className="w-3 h-3 text-sky-400" /> Crew Sharing
                    </div>
                </div>
            </div>
        </div>
    );
};
