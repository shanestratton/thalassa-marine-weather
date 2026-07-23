/**
 * CheckoutModal — Thalassa Marketplace Checkout
 *
 * Marketplace payment bottom-sheet. Cash deals are available now; secure
 * escrow is intentionally presented as unavailable until the native Stripe
 * confirmation and handoff flow has passed end-to-end payment testing.
 */

import React, { useRef } from 'react';
import type { MarketplaceListing } from '../../services/MarketplaceService';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// --- HELPERS ---

const formatPrice = (price: number, currency: string): string => {
    const symbols: Record<string, string> = { AUD: 'A$', USD: '$', EUR: '€', GBP: '£', NZD: 'NZ$' };
    const sym = symbols[currency] || `${currency} `;
    return price % 1 === 0
        ? `${sym}${price.toLocaleString()}`
        : `${sym}${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// --- PROPS ---

interface CheckoutModalProps {
    listing: MarketplaceListing | null;
    isOpen: boolean;
    onClose: () => void;
    onCashDeal: (listing: MarketplaceListing) => void;
    onEscrowComplete?: (paymentIntentId: string) => void;
}

// --- COMPONENT ---

export const CheckoutModal: React.FC<CheckoutModalProps> = ({
    listing,
    isOpen,
    onClose,
    onCashDeal,
    onEscrowComplete: _onEscrowComplete,
}) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen && listing !== null, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });

    if (!isOpen || !listing) return null;

    const platformFee = listing.price * 0.06;
    const totalWithFee = listing.price + platformFee;

    const handleCashDeal = () => {
        onCashDeal(listing);
        onClose();
    };

    const handleClose = () => {
        onClose();
    };

    return (
        <div
            className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70"
            onClick={handleClose}
            role="presentation"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Marketplace checkout"
                className="w-full max-w-lg bg-slate-900/98 border-t border-white/10 rounded-t-3xl shadow-2xl max-h-[85vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Drag handle */}
                <div className="flex justify-center pt-3 pb-1">
                    <div className="w-10 h-1 rounded-full bg-white/20" />
                </div>
                <div className="flex items-center justify-between px-5 py-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-white/60">Checkout</span>
                    <button
                        ref={closeButtonRef}
                        type="button"
                        onClick={handleClose}
                        aria-label="Close marketplace checkout"
                        className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold text-white/60 hover:bg-white/10 hover:text-white"
                    >
                        Close
                    </button>
                </div>

                {/* Listing context card */}
                <div className="mx-5 mt-2 mb-4 p-3 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex gap-3 items-center">
                    {listing.images.length > 0 && (
                        <img
                            src={listing.images[0]}
                            loading="lazy"
                            alt=""
                            className="w-16 h-16 rounded-xl object-cover shrink-0"
                        />
                    )}
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-white truncate">{listing.title}</h3>
                        <p className="text-[11px] text-white/60 mt-0.5">
                            {listing.condition} · {listing.category}
                        </p>
                        <p className="text-sm font-bold text-emerald-400 mt-1">
                            {formatPrice(listing.price, listing.currency)}
                        </p>
                    </div>
                </div>

                <div className="px-5 pb-8 space-y-3">
                    <h2 className="text-xs font-bold text-white/60 uppercase tracking-wider mb-3">
                        How would you like to buy?
                    </h2>

                    {/* Option A: Cash on Dock */}
                    <button
                        aria-label="Cash Deal"
                        onClick={handleCashDeal}
                        className="w-full p-4 rounded-2xl bg-white/[0.04] border border-white/10 text-left group hover:border-emerald-500/30 hover:bg-emerald-500/[0.04] transition-all active:scale-[0.98]"
                    >
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2.5">
                                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-xl">
                                    💵
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-white">Cash on the Dock</h3>
                                    <p className="text-[11px] text-emerald-400 font-semibold">FREE — No fees</p>
                                </div>
                            </div>
                            <span className="text-white/60 text-lg group-hover:text-emerald-400 transition-colors">
                                ›
                            </span>
                        </div>
                        <p className="text-[11px] text-white/60 leading-relaxed pl-[52px]">
                            Opens a direct message with the seller to arrange cash payment and pickup in person.
                        </p>
                    </button>

                    {/* Option B: Secure Escrow */}
                    <button
                        aria-label="Secure escrow coming soon"
                        disabled
                        className="w-full p-4 rounded-2xl border-2 border-sky-500/20 bg-gradient-to-br from-sky-500/[0.04] to-sky-500/[0.02] text-left relative overflow-hidden opacity-70 cursor-not-allowed"
                    >
                        <div className="absolute top-2.5 right-3 px-2 py-0.5 rounded-full bg-sky-500/20 border border-sky-500/30">
                            <span className="text-[11px] font-bold text-sky-300 uppercase tracking-wider">
                                Coming soon
                            </span>
                        </div>

                        <div className="flex items-center gap-2.5 mb-2">
                            <div className="w-10 h-10 rounded-xl bg-sky-500/10 flex items-center justify-center text-xl">
                                🔒
                            </div>
                            <div>
                                <h3 className="text-sm font-bold text-white">Thalassa Secure Escrow</h3>
                                <p className="text-[11px] text-sky-400 font-semibold">6% Platform Fee</p>
                            </div>
                        </div>
                        <p className="text-[11px] text-white/60 leading-relaxed pl-[52px] mb-3">
                            Secure card holds stay unavailable until the native Stripe confirmation sheet and handoff
                            flow have passed end-to-end payment testing.
                        </p>

                        {/* Fee breakdown */}
                        <div className="ml-[52px] p-2.5 rounded-xl bg-black/20 border border-white/[0.06] space-y-1">
                            <div className="flex justify-between text-[11px]">
                                <span className="text-white/60">Item price</span>
                                <span className="text-white/70 font-medium">
                                    {formatPrice(listing.price, listing.currency)}
                                </span>
                            </div>
                            <div className="flex justify-between text-[11px]">
                                <span className="text-white/60">Escrow fee (6%)</span>
                                <span className="text-sky-400/70 font-medium">
                                    +{formatPrice(platformFee, listing.currency)}
                                </span>
                            </div>
                            <div className="h-px bg-white/[0.08] my-1" />
                            <div className="flex justify-between text-xs">
                                <span className="text-white/60 font-semibold">Total hold</span>
                                <span className="text-white font-bold">
                                    {formatPrice(totalWithFee, listing.currency)}
                                </span>
                            </div>
                        </div>
                    </button>
                </div>

                {/* Safe area */}
                <div className="h-6" />
            </div>
        </div>
    );
};
