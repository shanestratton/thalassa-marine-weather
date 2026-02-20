/**
 * CheckoutModal — Thalassa Marketplace Checkout
 * 
 * Hybrid payment bottom-sheet:
 * A) Cash on the Dock (Free) — triggers DM thread
 * B) Secure Escrow (6% fee) — auth-only Stripe hold + 4-digit PIN handoff
 * 
 * After successful escrow hold, displays a prominent PIN that the buyer
 * gives to the seller only after inspecting the gear. The hold expires
 * automatically after 48 hours if no handoff occurs.
 */

import React, { useState, useEffect } from 'react';
import { supabase } from '../../services/supabase';
import type { MarketplaceListing } from '../../services/MarketplaceService';

// --- HELPERS ---

const formatPrice = (price: number, currency: string): string => {
    const symbols: Record<string, string> = { AUD: 'A$', USD: '$', EUR: '€', GBP: '£', NZD: 'NZ$' };
    const sym = symbols[currency] || `${currency} `;
    return price % 1 === 0 ? `${sym}${price.toLocaleString()}` : `${sym}${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatCents = (cents: number, currency: string): string => {
    return formatPrice(cents / 100, currency);
};

/** Format remaining time as "Xh Ym" */
const formatTimeRemaining = (expiresAt: string): string => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const hrs = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
};

// --- PROPS ---

interface CheckoutModalProps {
    listing: MarketplaceListing | null;
    isOpen: boolean;
    onClose: () => void;
    onCashDeal: (listing: MarketplaceListing) => void;
    onEscrowComplete?: (paymentIntentId: string) => void;
}

// --- ESCROW DATA ---

interface EscrowHoldData {
    clientSecret: string;
    paymentIntentId: string;
    escrowId: string;
    escrowPin: string;
    expiresAt: string;
    amountCents: number;
    platformFeeCents: number;
    sellerPayoutCents: number;
    currency: string;
}

type ModalMode = 'choose' | 'escrow_loading' | 'pin_display' | 'escrow_error';

// --- COMPONENT ---

export const CheckoutModal: React.FC<CheckoutModalProps> = ({
    listing, isOpen, onClose, onCashDeal, onEscrowComplete,
}) => {
    const [mode, setMode] = useState<ModalMode>('choose');
    const [holdData, setHoldData] = useState<EscrowHoldData | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState<string>('');

    // Countdown timer for PIN display
    useEffect(() => {
        if (mode !== 'pin_display' || !holdData) return;
        const tick = () => setTimeLeft(formatTimeRemaining(holdData.expiresAt));
        tick();
        const id = setInterval(tick, 60000); // Update every minute
        return () => clearInterval(id);
    }, [mode, holdData]);

    if (!isOpen || !listing) return null;

    const platformFee = listing.price * 0.06;
    const totalWithFee = listing.price + platformFee;

    const handleCashDeal = () => {
        onCashDeal(listing);
        onClose();
    };

    const handleEscrow = async () => {
        if (!supabase) {
            setErrorMsg('Supabase not configured');
            setMode('escrow_error');
            return;
        }

        setMode('escrow_loading');
        setErrorMsg(null);

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                setErrorMsg('Please sign in to use Secure Escrow');
                setMode('escrow_error');
                return;
            }

            const res = await supabase.functions.invoke('create-marketplace-payment', {
                body: { listing_id: listing.id },
            });

            if (res.error) {
                setErrorMsg(res.error.message || 'Payment setup failed');
                setMode('escrow_error');
                return;
            }

            setHoldData(res.data as EscrowHoldData);
            setMode('pin_display');
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : 'Unexpected error');
            setMode('escrow_error');
        }
    };

    const handleClose = () => {
        setMode('choose');
        setHoldData(null);
        setErrorMsg(null);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70 backdrop-blur-sm" onClick={handleClose}>
            <div
                className="w-full max-w-lg bg-slate-900/98 border-t border-white/10 rounded-t-3xl shadow-2xl max-h-[85vh] overflow-y-auto"
                onClick={e => e.stopPropagation()}
            >
                {/* Drag handle */}
                <div className="flex justify-center pt-3 pb-1">
                    <div className="w-10 h-1 rounded-full bg-white/20" />
                </div>

                {/* Listing context card */}
                <div className="mx-5 mt-2 mb-4 p-3 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex gap-3 items-center">
                    {listing.images.length > 0 && (
                        <img src={listing.images[0]} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                        <h3 className="text-[14px] font-semibold text-white truncate">{listing.title}</h3>
                        <p className="text-[11px] text-white/40 mt-0.5">{listing.condition} · {listing.category}</p>
                        <p className="text-[15px] font-bold text-emerald-400 mt-1">{formatPrice(listing.price, listing.currency)}</p>
                    </div>
                </div>

                {/* ═══════ CHOOSE MODE ═══════ */}
                {mode === 'choose' && (
                    <div className="px-5 pb-8 space-y-3">
                        <h2 className="text-[13px] font-bold text-white/50 uppercase tracking-wider mb-3">How would you like to buy?</h2>

                        {/* Option A: Cash on Dock */}
                        <button
                            onClick={handleCashDeal}
                            className="w-full p-4 rounded-2xl bg-white/[0.04] border border-white/10 text-left group hover:border-emerald-500/30 hover:bg-emerald-500/[0.04] transition-all active:scale-[0.98]"
                        >
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2.5">
                                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-xl">💵</div>
                                    <div>
                                        <h3 className="text-[14px] font-bold text-white">Cash on the Dock</h3>
                                        <p className="text-[11px] text-emerald-400 font-semibold">FREE — No fees</p>
                                    </div>
                                </div>
                                <span className="text-white/20 text-lg group-hover:text-emerald-400 transition-colors">›</span>
                            </div>
                            <p className="text-[11px] text-white/40 leading-relaxed pl-[52px]">
                                Opens a direct message with the seller to arrange cash payment and pickup in person.
                            </p>
                        </button>

                        {/* Option B: Secure Escrow */}
                        <button
                            onClick={handleEscrow}
                            className="w-full p-4 rounded-2xl border-2 border-sky-500/30 bg-gradient-to-br from-sky-500/[0.06] to-cyan-500/[0.03] text-left group hover:border-sky-500/50 transition-all active:scale-[0.98] relative overflow-hidden"
                        >
                            <div className="absolute top-2.5 right-3 px-2 py-0.5 rounded-full bg-sky-500/20 border border-sky-500/30">
                                <span className="text-[9px] font-bold text-sky-300 uppercase tracking-wider">Recommended</span>
                            </div>

                            <div className="flex items-center gap-2.5 mb-2">
                                <div className="w-10 h-10 rounded-xl bg-sky-500/10 flex items-center justify-center text-xl">🔒</div>
                                <div>
                                    <h3 className="text-[14px] font-bold text-white">Thalassa Secure Escrow</h3>
                                    <p className="text-[11px] text-sky-400 font-semibold">6% Platform Fee</p>
                                </div>
                            </div>
                            <p className="text-[11px] text-white/40 leading-relaxed pl-[52px] mb-3">
                                A hold is placed on your card. You receive a 4-digit PIN. Give the PIN to the seller
                                <strong className="text-white/60"> only after you've inspected the gear</strong>. The hold auto-expires in 48 hours.
                            </p>

                            {/* Fee breakdown */}
                            <div className="ml-[52px] p-2.5 rounded-xl bg-black/20 border border-white/[0.06] space-y-1">
                                <div className="flex justify-between text-[11px]">
                                    <span className="text-white/40">Item price</span>
                                    <span className="text-white/70 font-medium">{formatPrice(listing.price, listing.currency)}</span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                    <span className="text-white/40">Escrow fee (6%)</span>
                                    <span className="text-sky-400/70 font-medium">+{formatPrice(platformFee, listing.currency)}</span>
                                </div>
                                <div className="h-px bg-white/[0.08] my-1" />
                                <div className="flex justify-between text-[12px]">
                                    <span className="text-white/60 font-semibold">Total hold</span>
                                    <span className="text-white font-bold">{formatPrice(totalWithFee, listing.currency)}</span>
                                </div>
                            </div>
                        </button>
                    </div>
                )}

                {/* ═══════ ESCROW LOADING ═══════ */}
                {mode === 'escrow_loading' && (
                    <div className="px-5 pb-8 flex flex-col items-center gap-4 py-10">
                        <div className="relative">
                            <div className="w-10 h-10 border-2 border-sky-500/30 rounded-full" />
                            <div className="absolute inset-0 w-10 h-10 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                        <p className="text-[13px] text-white/50">Placing hold on your card…</p>
                        <p className="text-[11px] text-white/30">This is an authorization only. No charge yet.</p>
                    </div>
                )}

                {/* ═══════ PIN DISPLAY (Buyer sees this) ═══════ */}
                {mode === 'pin_display' && holdData && (
                    <div className="px-5 pb-8 space-y-4">
                        {/* Success header */}
                        <div className="p-4 rounded-2xl bg-emerald-500/[0.06] border border-emerald-500/20 text-center">
                            <div className="text-3xl mb-1">🔒</div>
                            <h3 className="text-[15px] font-bold text-emerald-400">Hold Placed Successfully</h3>
                            <p className="text-[11px] text-white/40 mt-1">
                                {formatCents(holdData.amountCents, holdData.currency)} authorized on your card
                            </p>
                        </div>

                        {/* THE PIN — large, prominent */}
                        <div className="p-5 rounded-2xl bg-gradient-to-br from-sky-500/[0.08] to-cyan-500/[0.04] border-2 border-sky-500/30 text-center">
                            <p className="text-[11px] font-bold text-sky-400/70 uppercase tracking-widest mb-3">Your Handoff PIN</p>
                            <div className="flex justify-center gap-3 mb-4">
                                {holdData.escrowPin.split('').map((digit, i) => (
                                    <div
                                        key={i}
                                        className="w-14 h-16 rounded-xl bg-slate-800/80 border border-sky-500/20 flex items-center justify-center"
                                    >
                                        <span className="text-3xl font-black text-white tracking-wider">{digit}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex items-center justify-center gap-1.5 text-[11px] text-amber-400/80">
                                <span>⏱</span>
                                <span>Expires in {timeLeft}</span>
                            </div>
                        </div>

                        {/* Instructions */}
                        <div className="p-3.5 rounded-xl bg-amber-500/[0.06] border border-amber-500/20">
                            <p className="text-[12px] text-amber-200/80 leading-relaxed">
                                <strong>Give this PIN to the seller only when you have inspected the gear
                                    and are ready to finalize the purchase.</strong>
                            </p>
                            <p className="text-[11px] text-white/40 mt-2 leading-relaxed">
                                If the deal falls through, simply walk away. The hold will automatically
                                expire in 48 hours and no charge will be made.
                            </p>
                        </div>

                        {/* Fee summary */}
                        <div className="p-3 rounded-xl bg-white/[0.04] border border-white/[0.06] space-y-1.5">
                            <div className="flex justify-between text-[11px]">
                                <span className="text-white/40">Hold amount</span>
                                <span className="text-white font-bold">{formatCents(holdData.amountCents, holdData.currency)}</span>
                            </div>
                            <div className="flex justify-between text-[11px]">
                                <span className="text-white/40">Seller receives on capture</span>
                                <span className="text-emerald-400 font-medium">{formatCents(holdData.sellerPayoutCents, holdData.currency)}</span>
                            </div>
                            <div className="flex justify-between text-[11px]">
                                <span className="text-white/40">Platform fee (6%)</span>
                                <span className="text-sky-400/70 font-medium">{formatCents(holdData.platformFeeCents, holdData.currency)}</span>
                            </div>
                        </div>

                        <button
                            onClick={handleClose}
                            className="w-full py-3 rounded-2xl bg-white/[0.06] border border-white/10 text-[13px] font-bold text-white/60 active:scale-[0.98] transition-transform"
                        >
                            Done — I'll give the PIN when ready
                        </button>
                    </div>
                )}

                {/* ═══════ ESCROW ERROR ═══════ */}
                {mode === 'escrow_error' && (
                    <div className="px-5 pb-8 space-y-4">
                        <div className="p-4 rounded-2xl bg-red-500/[0.06] border border-red-500/20 text-center">
                            <div className="text-3xl mb-2">⚠️</div>
                            <h3 className="text-[14px] font-bold text-red-400 mb-1">Payment Hold Failed</h3>
                            <p className="text-[12px] text-white/50">{errorMsg || 'Unknown error'}</p>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setMode('choose')}
                                className="flex-1 py-3 rounded-2xl bg-white/[0.06] border border-white/10 text-[13px] font-bold text-white/60"
                            >
                                Back
                            </button>
                            <button
                                onClick={handleEscrow}
                                className="flex-1 py-3 rounded-2xl bg-sky-500/20 border border-sky-500/30 text-[13px] font-bold text-sky-300"
                            >
                                Retry
                            </button>
                        </div>
                    </div>
                )}

                {/* Safe area */}
                <div className="h-6" />
            </div>
        </div>
    );
};
