/**
 * SellerPinInput — Escrow PIN Capture for Sellers
 * 
 * Renders in the seller's DM thread / listing view when there's an
 * active escrow awaiting handoff. The seller enters the buyer's 4-digit
 * PIN to trigger fund capture.
 * 
 * Flow:
 * 1. Seller sees "Enter Buyer's PIN" card
 * 2. Enters 4 digits into individual input boxes
 * 3. Calls capture-escrow-payment edge function
 * 4. On success: "Funds Secured ✅" confirmation
 */

import React, { useState, useRef, useEffect } from 'react';
import { supabase } from '../../services/supabase';

// --- HELPERS ---

const formatCents = (cents: number, currency: string): string => {
    const symbols: Record<string, string> = { aud: 'A$', usd: '$', eur: '€', gbp: '£', nzd: 'NZ$' };
    const sym = symbols[currency.toLowerCase()] || `${currency} `;
    const amount = cents / 100;
    return amount % 1 === 0 ? `${sym}${amount.toLocaleString()}` : `${sym}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatTimeRemaining = (expiresAt: string): string => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const hrs = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    return hrs > 0 ? `${hrs}h ${mins}m remaining` : `${mins}m remaining`;
};

// --- PROPS ---

export interface EscrowInfo {
    escrow_id: string;
    listing_title: string;
    amount_cents: number;
    seller_payout_cents: number;
    platform_fee_cents: number;
    currency: string;
    escrow_status: string;
    escrow_expires_at: string;
}

interface SellerPinInputProps {
    escrow: EscrowInfo;
    onCaptured?: () => void;
}

// --- COMPONENT ---

export const SellerPinInput: React.FC<SellerPinInputProps> = ({ escrow, onCaptured }) => {
    const [digits, setDigits] = useState<string[]>(['', '', '', '']);
    const [status, setStatus] = useState<'input' | 'verifying' | 'success' | 'error'>('input');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState<string>('');
    const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

    // Countdown timer
    useEffect(() => {
        const tick = () => setTimeLeft(formatTimeRemaining(escrow.escrow_expires_at));
        tick();
        const id = setInterval(tick, 60000);
        return () => clearInterval(id);
    }, [escrow.escrow_expires_at]);

    // If already released or expired, show that state
    if (escrow.escrow_status === 'released') {
        return (
            <div className="mx-3 mb-3 p-4 rounded-2xl bg-emerald-500/[0.06] border border-emerald-500/20 text-center">
                <div className="text-2xl mb-1">✅</div>
                <h3 className="text-[14px] font-bold text-emerald-400">Funds Secured</h3>
                <p className="text-[11px] text-white/40 mt-1">
                    {formatCents(escrow.seller_payout_cents, escrow.currency)} has been transferred to your account.
                </p>
            </div>
        );
    }

    if (escrow.escrow_status === 'expired' || escrow.escrow_status === 'canceled') {
        return (
            <div className="mx-3 mb-3 p-4 rounded-2xl bg-white/[0.04] border border-white/[0.06] text-center">
                <div className="text-2xl mb-1">{escrow.escrow_status === 'expired' ? '⏰' : '❌'}</div>
                <h3 className="text-[14px] font-bold text-white/50">
                    Escrow {escrow.escrow_status === 'expired' ? 'Expired' : 'Canceled'}
                </h3>
                <p className="text-[11px] text-white/30 mt-1">No funds were captured.</p>
            </div>
        );
    }

    const handleDigitChange = (index: number, value: string) => {
        const digit = value.replace(/\D/g, '').slice(-1);
        const newDigits = [...digits];
        newDigits[index] = digit;
        setDigits(newDigits);

        // Auto-advance to next input
        if (digit && index < 3) {
            inputRefs.current[index + 1]?.focus();
        }
    };

    const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
        if (e.key === 'Backspace' && !digits[index] && index > 0) {
            inputRefs.current[index - 1]?.focus();
        }
    };

    const handleSubmit = async () => {
        const pin = digits.join('');
        if (pin.length !== 4) {
            setErrorMsg('Enter all 4 digits');
            return;
        }

        if (!supabase) {
            setErrorMsg('Supabase not configured');
            return;
        }

        setStatus('verifying');
        setErrorMsg(null);

        try {
            const res = await supabase.functions.invoke('capture-escrow-payment', {
                body: { escrow_id: escrow.escrow_id, pin },
            });

            if (res.error || !res.data?.success) {
                setErrorMsg(res.data?.error || res.error?.message || 'PIN verification failed');
                setStatus('error');
                return;
            }

            setStatus('success');
            onCaptured?.();
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : 'Unexpected error');
            setStatus('error');
        }
    };

    return (
        <div className="mx-3 mb-3">
            <div className="rounded-2xl overflow-hidden border border-sky-500/20 bg-gradient-to-br from-sky-500/[0.04] to-cyan-500/[0.02]">
                {/* Header */}
                <div className="px-4 py-3 border-b border-sky-500/10 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-lg">🔐</span>
                        <div>
                            <h3 className="text-[13px] font-bold text-white">Escrow Handoff</h3>
                            <p className="text-[10px] text-white/40">{escrow.listing_title}</p>
                        </div>
                    </div>
                    <div className="text-[10px] text-amber-400/70 font-medium">⏱ {timeLeft}</div>
                </div>

                <div className="p-4">
                    {status === 'success' ? (
                        /* ═══ SUCCESS STATE ═══ */
                        <div className="text-center py-4">
                            <div className="text-4xl mb-2">✅</div>
                            <h3 className="text-[16px] font-bold text-emerald-400 mb-1">Funds Secured!</h3>
                            <p className="text-[12px] text-white/50">
                                {formatCents(escrow.seller_payout_cents, escrow.currency)} is being transferred to your account.
                            </p>
                            <p className="text-[11px] text-white/30 mt-2">
                                It's safe to hand over the gear now.
                            </p>
                        </div>
                    ) : (
                        /* ═══ PIN INPUT STATE ═══ */
                        <>
                            {/* Instructions */}
                            <div className="p-3 rounded-xl bg-amber-500/[0.06] border border-amber-500/15 mb-4">
                                <p className="text-[11px] text-amber-200/80 leading-relaxed">
                                    <strong>Do not hand over the gear</strong> until you have entered the buyer's
                                    4-digit PIN below and received the "Funds Secured" confirmation.
                                </p>
                            </div>

                            {/* PIN digits */}
                            <div className="flex justify-center gap-3 mb-4">
                                {[0, 1, 2, 3].map(i => (
                                    <input
                                        key={i}
                                        ref={el => { inputRefs.current[i] = el; }}
                                        type="text"
                                        inputMode="numeric"
                                        maxLength={1}
                                        value={digits[i]}
                                        onChange={e => handleDigitChange(i, e.target.value)}
                                        onKeyDown={e => handleKeyDown(i, e)}
                                        className={`w-14 h-16 rounded-xl bg-slate-800/80 border text-center text-3xl font-black text-white outline-none transition-all ${status === 'error' ? 'border-red-500/40 shake' :
                                                digits[i] ? 'border-sky-500/40' : 'border-white/10'
                                            } focus:border-sky-500/60 focus:ring-2 focus:ring-sky-500/20`}
                                    />
                                ))}
                            </div>

                            {/* Error message */}
                            {errorMsg && (
                                <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-[11px] text-red-400 text-center mb-3">
                                    {errorMsg}
                                </div>
                            )}

                            {/* Payout info */}
                            <div className="p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06] space-y-1 mb-4">
                                <div className="flex justify-between text-[11px]">
                                    <span className="text-white/40">You'll receive</span>
                                    <span className="text-emerald-400 font-bold">{formatCents(escrow.seller_payout_cents, escrow.currency)}</span>
                                </div>
                                <div className="flex justify-between text-[10px]">
                                    <span className="text-white/30">Platform fee (6%)</span>
                                    <span className="text-white/30">{formatCents(escrow.platform_fee_cents, escrow.currency)}</span>
                                </div>
                            </div>

                            {/* Submit */}
                            <button
                                onClick={handleSubmit}
                                disabled={status === 'verifying' || digits.some(d => !d)}
                                className={`w-full py-3.5 rounded-2xl font-bold text-[13px] uppercase tracking-wider transition-all active:scale-[0.98] ${status === 'verifying' || digits.some(d => !d)
                                        ? 'bg-white/[0.04] text-white/20 border border-white/[0.06]'
                                        : 'bg-gradient-to-r from-sky-500 to-cyan-500 text-white shadow-lg shadow-sky-500/20'
                                    }`}
                            >
                                {status === 'verifying' ? '⏳ Verifying PIN...' : '🔐 Capture Payment'}
                            </button>

                            {status === 'error' && (
                                <button
                                    onClick={() => { setStatus('input'); setErrorMsg(null); setDigits(['', '', '', '']); }}
                                    className="w-full py-2 mt-2 text-[12px] text-sky-400 font-medium"
                                >
                                    Try again
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
