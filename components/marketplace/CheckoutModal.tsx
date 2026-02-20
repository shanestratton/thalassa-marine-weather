/**
 * CheckoutModal — Thalassa Marketplace Checkout
 * 
 * Hybrid payment bottom-sheet with two options:
 * A) Cash on the Dock (Free) — triggers DM thread
 * B) Secure Escrow (6% fee) — triggers Stripe Payment Intent
 * 
 * Shows listing context, fee breakdown, and seller info.
 */

import React, { useState } from 'react';
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

// --- PROPS ---

interface CheckoutModalProps {
    listing: MarketplaceListing | null;
    isOpen: boolean;
    onClose: () => void;
    onCashDeal: (listing: MarketplaceListing) => void;          // Option A: Cash on Dock → DM
    onEscrowComplete?: (paymentIntentId: string) => void;       // Option B: Escrow complete
}

// --- COMPONENT ---

export const CheckoutModal: React.FC<CheckoutModalProps> = ({
    listing, isOpen, onClose, onCashDeal, onEscrowComplete,
}) => {
    const [mode, setMode] = useState<'choose' | 'escrow_loading' | 'escrow_ready' | 'escrow_error'>('choose');
    const [escrowData, setEscrowData] = useState<{
        clientSecret: string;
        paymentIntentId: string;
        amountCents: number;
        platformFeeCents: number;
        sellerPayoutCents: number;
        currency: string;
    } | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

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

            setEscrowData(res.data);
            setMode('escrow_ready');
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : 'Unexpected error');
            setMode('escrow_error');
        }
    };

    const handleClose = () => {
        setMode('choose');
        setEscrowData(null);
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
                            {/* Recommended badge */}
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
                                Your payment is held securely by Thalassa until you inspect the item in person. Full buyer protection.
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
                                    <span className="text-white/60 font-semibold">Total</span>
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
                        <p className="text-[13px] text-white/50">Setting up secure payment…</p>
                    </div>
                )}

                {/* ═══════ ESCROW READY ═══════ */}
                {mode === 'escrow_ready' && escrowData && (
                    <div className="px-5 pb-8 space-y-4">
                        <div className="p-4 rounded-2xl bg-emerald-500/[0.06] border border-emerald-500/20 text-center">
                            <div className="text-3xl mb-2">✅</div>
                            <h3 className="text-[15px] font-bold text-emerald-400 mb-1">Payment Intent Created</h3>
                            <p className="text-[12px] text-white/50">
                                Complete payment in the Stripe checkout to hold funds in escrow.
                            </p>
                        </div>

                        <div className="p-3 rounded-xl bg-white/[0.04] border border-white/[0.06] space-y-1.5">
                            <div className="flex justify-between text-[11px]">
                                <span className="text-white/40">Total charge</span>
                                <span className="text-white font-bold">{formatCents(escrowData.amountCents, escrowData.currency)}</span>
                            </div>
                            <div className="flex justify-between text-[11px]">
                                <span className="text-white/40">Seller receives</span>
                                <span className="text-emerald-400 font-medium">{formatCents(escrowData.sellerPayoutCents, escrowData.currency)}</span>
                            </div>
                            <div className="flex justify-between text-[11px]">
                                <span className="text-white/40">Platform fee</span>
                                <span className="text-sky-400/70 font-medium">{formatCents(escrowData.platformFeeCents, escrowData.currency)}</span>
                            </div>
                        </div>

                        <button
                            onClick={() => {
                                onEscrowComplete?.(escrowData.paymentIntentId);
                                handleClose();
                            }}
                            className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-sky-500 to-cyan-500 text-[14px] font-bold text-white uppercase tracking-wider shadow-lg shadow-sky-500/20 active:scale-[0.98] transition-transform"
                        >
                            🔒 Complete Payment
                        </button>
                    </div>
                )}

                {/* ═══════ ESCROW ERROR ═══════ */}
                {mode === 'escrow_error' && (
                    <div className="px-5 pb-8 space-y-4">
                        <div className="p-4 rounded-2xl bg-red-500/[0.06] border border-red-500/20 text-center">
                            <div className="text-3xl mb-2">⚠️</div>
                            <h3 className="text-[14px] font-bold text-red-400 mb-1">Payment Setup Failed</h3>
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
