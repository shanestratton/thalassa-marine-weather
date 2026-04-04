/**
 * ListingCard — Individual marketplace listing card component.
 *
 * Features:
 * - Image carousel with pagination dots
 * - Boat specs grid (LOA, beam, draft, engine, etc.)
 * - Expandable description
 * - Seller reputation + rating modal
 * - Swipe-to-delete (owner only)
 * - Make-an-offer inline input
 * - SOLD overlay with auto-removal countdown
 */

import React, { useState, useEffect } from 'react';
import { MarketplaceListing, CATEGORY_ICONS } from '../../services/MarketplaceService';
import { ChatService } from '../../services/ChatService';
import { SellerRatingService, SellerReputation } from '../../services/SellerRatingService';
import { t } from '../../theme';
import { useSwipeable } from '../../hooks/useSwipeable';
import { scrollInputAboveKeyboard } from '../../utils/keyboardScroll';
import { formatPrice, getConditionColor, getAvatarGradient, timeAgo } from './helpers';

export interface ListingCardProps {
    listing: MarketplaceListing;
    isOwn: boolean;
    onMessageSeller: (listing: MarketplaceListing) => void;
    onMarkSold: (id: string) => void;
    onDelete: (id: string) => void;
    onFlagLocation?: (listing: MarketplaceListing) => void;
    isNew?: boolean;
}

export const ListingCard: React.FC<ListingCardProps> = React.memo(
    ({ listing, isOwn, onMessageSeller, onMarkSold, onDelete, onFlagLocation, isNew }) => {
        const [expanded, setExpanded] = useState(false);
        const [imageIdx, setImageIdx] = useState(0);
        const [showActions, setShowActions] = useState(false);
        const [showOfferInput, setShowOfferInput] = useState(false);
        const [offerPrice, setOfferPrice] = useState('');

        // Swipe-to-delete (owner only)
        const { swipeOffset, isSwiping, resetSwipe, ref: swipeRef } = useSwipeable();

        const isOwnerSwipeable = isOwn;

        // Seller reputation
        const [reputation, setReputation] = useState<SellerReputation | null>(null);
        const [showRateModal, setShowRateModal] = useState(false);
        const [rateStars, setRateStars] = useState(5);
        const [rateComment, setRateComment] = useState('');
        const [hasRated, setHasRated] = useState(false);

        useEffect(() => {
            SellerRatingService.getSellerReputation(listing.seller_id).then(setReputation);
            if (listing.status === 'sold') {
                SellerRatingService.hasRated(listing.id).then(setHasRated);
            }
        }, [listing.seller_id, listing.id, listing.status]);

        const handleSubmitRating = async () => {
            const result = await SellerRatingService.rateSeller(listing.id, listing.seller_id, rateStars, rateComment);
            if (result) {
                setHasRated(true);
                setShowRateModal(false);
                // Refresh reputation
                SellerRatingService.getSellerReputation(listing.seller_id).then(setReputation);
            }
        };

        const hasImages = listing.images.length > 0;

        return (
            <div
                className={`mx-3 mb-3 transition-all duration-300 ${isNew ? 'animate-in slide-in-from-top-4 fade-in' : ''}`}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 350px' } as React.CSSProperties}
            >
                <div className="relative overflow-hidden rounded-2xl">
                    {/* Delete button revealed on swipe (owner only) */}
                    {isOwnerSwipeable && (
                        <div
                            className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-2xl transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                            onClick={() => {
                                resetSwipe();
                                onDelete(listing.id);
                            }}
                        >
                            <div className="text-center text-white">
                                <svg
                                    className="w-5 h-5 mx-auto mb-0.5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                    />
                                </svg>
                                <span className="text-[11px] font-bold uppercase">Delete</span>
                            </div>
                        </div>
                    )}
                    <div
                        className={`relative border border-white/[0.06] rounded-2xl bg-slate-800/40 overflow-hidden ${listing.status === 'sold' ? 'opacity-60' : ''} transition-transform ${isSwiping ? '' : 'duration-200'}`}
                        ref={isOwnerSwipeable ? swipeRef : undefined}
                        style={isOwnerSwipeable ? { transform: `translateX(-${swipeOffset}px)` } : undefined}
                    >
                        {' '}
                        {/* Subtle gradient bg */}
                        <div className="absolute inset-0 bg-gradient-to-br from-slate-700/20 via-transparent to-slate-800/30 pointer-events-none" />
                        <div className="relative">
                            {/* Image Section */}
                            {hasImages && (
                                <div className="relative w-full aspect-[16/10] overflow-hidden bg-slate-800/50">
                                    <img
                                        src={listing.images[imageIdx]}
                                        alt={listing.title}
                                        className="w-full h-full object-cover"
                                        loading="lazy"
                                    />
                                    {/* Image pagination dots */}
                                    {listing.images.length > 1 && (
                                        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
                                            {listing.images.map((_, i) => (
                                                <button
                                                    aria-label="View listing category"
                                                    key={i}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setImageIdx(i);
                                                    }}
                                                    className={`w-1.5 h-1.5 rounded-full transition-all ${i === imageIdx ? 'bg-white w-4' : 'bg-white/40'}`}
                                                />
                                            ))}
                                        </div>
                                    )}
                                    {/* Category badge */}
                                    <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-full bg-black/50 border border-white/10 text-[11px] font-bold text-white/90 uppercase tracking-wider">
                                        {CATEGORY_ICONS[listing.category]} {listing.category}
                                    </div>
                                    {/* Condition badge */}
                                    <div
                                        className={`absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wider ${getConditionColor(listing.condition)}`}
                                    >
                                        {listing.condition}
                                    </div>
                                </div>
                            )}

                            {/* Content */}
                            <div className="p-3.5">
                                {/* If no image, show category inline */}
                                {!hasImages && (
                                    <div className="flex items-center gap-2 mb-2">
                                        <span
                                            className={`px-2 py-0.5 rounded-full bg-white/[0.06] border ${t.border.default} text-[11px] font-bold text-white/70 uppercase tracking-wider`}
                                        >
                                            {CATEGORY_ICONS[listing.category]} {listing.category}
                                        </span>
                                        <span
                                            className={`px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wider ${getConditionColor(listing.condition)}`}
                                        >
                                            {listing.condition}
                                        </span>
                                    </div>
                                )}

                                {/* Title + Price row */}
                                <div className="flex items-start justify-between gap-3">
                                    <h3 className="text-sm font-semibold text-white leading-snug flex-1">
                                        {listing.title}
                                    </h3>
                                    <div className="text-right shrink-0">
                                        <span className="text-lg font-bold text-emerald-400 whitespace-nowrap tracking-tight">
                                            {formatPrice(listing.price, listing.currency)}
                                        </span>
                                        {listing.boat_details?.price_reduced &&
                                            listing.boat_details?.original_price && (
                                                <div className="flex items-center gap-1 justify-end mt-0.5">
                                                    <span className="text-[11px] text-white/40 line-through">
                                                        {formatPrice(
                                                            listing.boat_details.original_price,
                                                            listing.currency,
                                                        )}
                                                    </span>
                                                    <span className="text-[11px] font-bold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded-full uppercase">
                                                        Reduced
                                                    </span>
                                                </div>
                                            )}
                                    </div>
                                </div>

                                {/* ═══ BOAT SPECS GRID ═══ */}
                                {listing.boat_details &&
                                    listing.category === 'Boats' &&
                                    (() => {
                                        const b = listing.boat_details!;
                                        return (
                                            <>
                                                {/* Make/Model/Year headline */}
                                                {(b.make || b.model || b.year) && (
                                                    <div className="mt-2 flex items-center gap-2 text-xs">
                                                        {(b.make || b.model) && (
                                                            <span className="font-bold text-white/80">
                                                                {[b.make, b.model].filter(Boolean).join(' ')}
                                                            </span>
                                                        )}
                                                        {b.year && <span className="text-white/50">{b.year}</span>}
                                                        {b.surveyed && (
                                                            <span className="text-[11px] font-bold text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded-full">
                                                                ✅ Surveyed
                                                            </span>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Spec chips row */}
                                                <div className="mt-2 flex flex-wrap gap-1.5">
                                                    {b.loa_ft && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-white/70">
                                                            {b.loa_ft}ft
                                                        </span>
                                                    )}
                                                    {b.beam_ft && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-white/70">
                                                            B: {b.beam_ft}ft
                                                        </span>
                                                    )}
                                                    {b.draft_ft && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-white/70">
                                                            D: {b.draft_ft}ft
                                                        </span>
                                                    )}
                                                    {b.hull_material && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-white/70">
                                                            {b.hull_material}
                                                        </span>
                                                    )}
                                                    {b.engine_type && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-[11px] font-medium text-sky-300/80">
                                                            {b.engine_type}
                                                        </span>
                                                    )}
                                                    {(b.engine_make || b.engine_hp) && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-[11px] font-medium text-sky-300/80">
                                                            {[b.engine_make, b.engine_hp ? `${b.engine_hp}HP` : '']
                                                                .filter(Boolean)
                                                                .join(' ')}
                                                        </span>
                                                    )}
                                                    {b.engine_hours != null && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] font-medium text-amber-300/80">
                                                            {b.engine_hours.toLocaleString()}hrs
                                                        </span>
                                                    )}
                                                    {b.fuel_type && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-white/70">
                                                            {b.fuel_type}
                                                        </span>
                                                    )}
                                                    {b.berths && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-white/70">
                                                            {b.berths} berths
                                                        </span>
                                                    )}
                                                    {b.cabins && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-white/70">
                                                            {b.cabins} cabin{b.cabins > 1 ? 's' : ''}
                                                        </span>
                                                    )}
                                                    {b.heads && (
                                                        <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[11px] font-medium text-white/70">
                                                            {b.heads} head{b.heads > 1 ? 's' : ''}
                                                        </span>
                                                    )}
                                                </div>

                                                {/* Feature tags */}
                                                {b.features && b.features.length > 0 && (
                                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                                        {b.features.slice(0, expanded ? undefined : 6).map((f) => (
                                                            <span
                                                                key={f}
                                                                className="px-1.5 py-0.5 rounded bg-emerald-500/8 border border-emerald-500/15 text-[11px] font-medium text-emerald-400/70"
                                                            >
                                                                {f}
                                                            </span>
                                                        ))}
                                                        {!expanded && b.features.length > 6 && (
                                                            <button
                                                                aria-label="Expand listing details"
                                                                onClick={() => setExpanded(true)}
                                                                className="text-[11px] text-sky-400 font-medium"
                                                            >
                                                                +{b.features.length - 6} more
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </>
                                        );
                                    })()}

                                {/* Description (expandable) */}
                                {listing.description && (
                                    <button
                                        aria-label="Expand listing details"
                                        onClick={() => setExpanded(!expanded)}
                                        className="text-left mt-1.5"
                                    >
                                        <p
                                            className={`text-xs text-white/60 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}
                                        >
                                            {listing.description}
                                        </p>
                                        {listing.description.length > 100 && (
                                            <span className="text-[11px] text-sky-400 font-medium">
                                                {expanded ? 'Less' : 'More'}
                                            </span>
                                        )}
                                    </button>
                                )}

                                {/* Location + Distance + Time */}
                                <div className="flex items-center gap-2 mt-2.5 text-[11px] text-white/60">
                                    {listing.location_name && (
                                        <span className="flex items-center gap-1">
                                            <span className="text-white/60">📍</span>
                                            {listing.location_name}
                                        </span>
                                    )}
                                    {listing.distance_nm != null && (
                                        <span className="text-sky-400/70 font-medium">
                                            {listing.distance_nm}nm away
                                        </span>
                                    )}
                                    <span className="ml-auto">{timeAgo(listing.created_at)}</span>
                                </div>
                                {/* Report suspicious location — buyer only */}
                                {!isOwn && listing.location_name && onFlagLocation && (
                                    <button
                                        aria-label="Flag Location"
                                        onClick={() => onFlagLocation(listing)}
                                        className="mt-1.5 text-[11px] text-amber-400/50 hover:text-amber-400 transition-colors flex items-center gap-1"
                                    >
                                        ⚠️ Not the seller's actual location?
                                    </button>
                                )}

                                {/* Divider */}
                                <div className="h-px bg-white/[0.06] my-3" />

                                {/* Seller info + CTA row */}
                                <div className="flex items-center justify-between">
                                    {/* Seller */}
                                    <div className="flex items-center gap-2.5">
                                        {listing.seller_avatar ? (
                                            <img
                                                src={listing.seller_avatar}
                                                className="w-8 h-8 rounded-full object-cover border border-white/10"
                                                alt=""
                                            />
                                        ) : (
                                            <div
                                                className={`w-8 h-8 rounded-full bg-gradient-to-br ${getAvatarGradient(listing.seller_id)} flex items-center justify-center text-[11px] font-bold text-white shadow-inner`}
                                            >
                                                {(listing.seller_name || '?')[0].toUpperCase()}
                                            </div>
                                        )}
                                        <div className="flex flex-col">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-xs font-semibold text-white/80">
                                                    {(listing.seller_name || 'Sailor').split(' ')[0]}
                                                </span>
                                                {reputation && reputation.total_ratings > 0 && (
                                                    <span className="text-[11px] text-amber-400 flex items-center gap-0.5">
                                                        ★ {reputation.avg_stars}
                                                        <span className="text-white/40">
                                                            ({reputation.total_ratings})
                                                        </span>
                                                    </span>
                                                )}
                                            </div>
                                            {listing.seller_vessel && (
                                                <span className="text-[11px] text-white/60 flex items-center gap-0.5">
                                                    ⛵ {listing.seller_vessel}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {/* CTA */}
                                    {isOwn ? (
                                        <div className="flex items-center gap-2">
                                            {listing.status === 'available' && (
                                                <button
                                                    aria-label="Mark Sold"
                                                    onClick={() => onMarkSold(listing.id)}
                                                    className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-bold text-emerald-400 uppercase tracking-wider active:scale-95 transition-transform"
                                                >
                                                    Mark Sold
                                                </button>
                                            )}
                                            <button
                                                aria-label="Show Actions"
                                                onClick={() => setShowActions(!showActions)}
                                                className="w-8 h-8 flex items-center justify-center rounded-xl bg-white/[0.06] text-white/60"
                                            >
                                                ⋯
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-2">
                                            <div className="flex items-center gap-2">
                                                <button
                                                    aria-label="Message Seller"
                                                    onClick={() => onMessageSeller(listing)}
                                                    className="px-3 py-1.5 rounded-xl bg-sky-500/20 border border-sky-500/30 text-[11px] font-bold text-sky-300 uppercase tracking-wider active:scale-95 transition-all hover:bg-sky-500/30"
                                                >
                                                    💬 Message
                                                </button>
                                                {listing.status === 'available' && (
                                                    <button
                                                        aria-label="Show Offer Input"
                                                        onClick={() => setShowOfferInput(!showOfferInput)}
                                                        className={`px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider active:scale-95 transition-all ${
                                                            showOfferInput
                                                                ? 'bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
                                                                : 'bg-emerald-500/15 border-emerald-500/25 text-emerald-400'
                                                        }`}
                                                    >
                                                        💰 Offer
                                                    </button>
                                                )}
                                            </div>
                                            {/* Make an Offer inline input */}
                                            {showOfferInput && (
                                                <div className="flex items-center gap-2 mt-1">
                                                    <div className="flex-1 flex items-center bg-white/[0.06] border border-emerald-500/20 rounded-xl overflow-hidden">
                                                        <span className="pl-3 text-xs text-emerald-400/60 font-bold">
                                                            {listing.currency === 'AUD'
                                                                ? 'A$'
                                                                : listing.currency === 'USD'
                                                                  ? '$'
                                                                  : listing.currency === 'EUR'
                                                                    ? '€'
                                                                    : listing.currency === 'GBP'
                                                                      ? '£'
                                                                      : listing.currency === 'NZD'
                                                                        ? 'NZ$'
                                                                        : listing.currency}
                                                        </span>
                                                        <input
                                                            value={offerPrice}
                                                            onChange={(e) =>
                                                                setOfferPrice(e.target.value.replace(/[^0-9.]/g, ''))
                                                            }
                                                            onFocus={scrollInputAboveKeyboard}
                                                            placeholder="Your offer"
                                                            inputMode="decimal"
                                                            className="flex-1 px-2 py-2 bg-transparent text-sm text-emerald-400 font-mono placeholder-white/30 outline-none"
                                                        />
                                                    </div>
                                                    <button
                                                        aria-label="View listing price history"
                                                        onClick={() => {
                                                            if (!offerPrice || parseFloat(offerPrice) <= 0) return;
                                                            const sellerFirst = (listing.seller_name || 'Seller').split(
                                                                ' ',
                                                            )[0];
                                                            const offerFormatted = formatPrice(
                                                                parseFloat(offerPrice),
                                                                listing.currency,
                                                            );
                                                            const text = `Hi ${sellerFirst}! I'd like to offer ${offerFormatted} for your "${listing.title}" (listed at ${formatPrice(listing.price, listing.currency)}). Let me know!`;
                                                            ChatService.sendDM(listing.seller_id, text);
                                                            if (onMessageSeller) onMessageSeller(listing);
                                                            setShowOfferInput(false);
                                                            setOfferPrice('');
                                                        }}
                                                        disabled={!offerPrice || parseFloat(offerPrice) <= 0}
                                                        className={`px-3 py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider active:scale-95 transition-all ${
                                                            !offerPrice || parseFloat(offerPrice) <= 0
                                                                ? 'bg-white/[0.04] border border-white/10 text-white/30'
                                                                : 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-400'
                                                        }`}
                                                    >
                                                        Send
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Own listing actions dropdown */}
                                {showActions && isOwn && (
                                    <div className="mt-2 flex gap-2">
                                        <button
                                            aria-label="Delete marketplace listing"
                                            onClick={() => {
                                                onDelete(listing.id);
                                                setShowActions(false);
                                            }}
                                            className="flex-1 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-[11px] font-bold text-red-400 uppercase tracking-wider active:scale-95"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                )}

                                {/* Rate Seller — buyer only, sold listings only */}
                                {!isOwn && listing.status === 'sold' && !hasRated && (
                                    <button
                                        aria-label="Show Rate Modal"
                                        onClick={() => setShowRateModal(true)}
                                        className="mt-2 w-full py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] font-bold text-amber-400 uppercase tracking-wider active:scale-95 transition-transform"
                                    >
                                        ⭐ Rate This Seller
                                    </button>
                                )}
                                {!isOwn && hasRated && listing.status === 'sold' && (
                                    <p className="mt-2 text-[11px] text-emerald-400/60 text-center">
                                        ✅ You've rated this seller
                                    </p>
                                )}

                                {/* Inline rating modal */}
                                {showRateModal && (
                                    <div className="mt-3 p-3 rounded-xl bg-white/[0.04] border border-white/10 space-y-3">
                                        <p className="text-[11px] font-bold text-white/70 uppercase tracking-wider">
                                            Rate Seller
                                        </p>
                                        <div className="flex justify-center gap-1">
                                            {[1, 2, 3, 4, 5].map((s) => (
                                                <button
                                                    aria-label="Rate Stars"
                                                    key={s}
                                                    onClick={() => setRateStars(s)}
                                                    className={`text-2xl transition-transform active:scale-90 ${s <= rateStars ? 'text-amber-400' : 'text-white/40'}`}
                                                >
                                                    ★
                                                </button>
                                            ))}
                                        </div>
                                        <textarea
                                            value={rateComment}
                                            onChange={(e) => setRateComment(e.target.value)}
                                            placeholder="Optional comment..."
                                            rows={2}
                                            maxLength={300}
                                            className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white/80 placeholder-white/30 outline-none focus:border-amber-500/40 transition-colors resize-none"
                                        />
                                        <div className="flex gap-2">
                                            <button
                                                aria-label="Show Rate Modal"
                                                onClick={() => setShowRateModal(false)}
                                                className="flex-1 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[11px] font-bold text-white/60 uppercase tracking-wider active:scale-95"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                aria-label="Submit marketplace listing offer"
                                                onClick={handleSubmitRating}
                                                className="flex-1 py-2 rounded-xl bg-amber-500/20 border border-amber-500/30 text-[11px] font-bold text-amber-400 uppercase tracking-wider active:scale-95"
                                            >
                                                Submit
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                        {/* SOLD overlay */}
                        {listing.status === 'sold' && (
                            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center pointer-events-none">
                                <span className="text-2xl font-black text-white/80 uppercase tracking-[0.3em] -rotate-12">
                                    SOLD
                                </span>
                                {listing.sold_at && (
                                    <span className="text-[11px] text-white/50 mt-1">
                                        Auto-removes in{' '}
                                        {Math.max(
                                            0,
                                            Math.ceil(
                                                (new Date(listing.sold_at).getTime() + 48 * 3600000 - Date.now()) /
                                                    3600000,
                                            ),
                                        )}
                                        h
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    },
);
