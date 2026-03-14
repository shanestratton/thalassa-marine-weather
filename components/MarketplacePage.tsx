/**
 * MarketplacePage — Thalassa Gear Exchange
 * 
 * Premium peer-to-peer marine marketplace living inside Crew Talk.
 * Features:
 * - Card-based listing feed with rich thumbnails
 * - Real-time Supabase feed (new listings slide in)
 * - Category filter chips (sticky header)
 * - "Message Seller" → opens DM thread
 * - Create listing modal with photo upload + GPS location
 * - Seller trust badges (vessel name, avatar)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from './Toast';
import {
    MarketplaceService,
    MarketplaceListing,
    ListingCategory,
    LISTING_CATEGORIES,
    LISTING_CONDITIONS,
    CATEGORY_ICONS,
    CreateListingInput,
    BoatDetails,
    HullMaterial,
    EngineType,
    FuelType,
    HULL_MATERIALS,
    ENGINE_TYPES,
    FUEL_TYPES,
    BOAT_FEATURES,
} from '../services/MarketplaceService';
import { ChatService } from '../services/ChatService';
import { BgGeoManager } from '../services/BgGeoManager';
import { SellerRatingService, SellerReputation } from '../services/SellerRatingService';
import { Capacitor } from '@capacitor/core';
import { t } from '../theme';
import { SlideToAction } from './ui/SlideToAction';
import { UndoToast } from './ui/UndoToast';
import { triggerHaptic } from '../utils/system';
import { useSwipeable } from '../hooks/useSwipeable';
import { scrollInputAboveKeyboard } from '../utils/keyboardScroll';

// --- CONSTANTS ---
const MAX_PHOTOS = 20; // Pro users get 20 photos

// --- HELPERS ---

/** Haversine distance in nautical miles between two lat/lon pairs */
const haversineNm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 3440.065; // Earth radius in nm
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
};

const timeAgo = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
};

const formatPrice = (price: number, currency: string): string => {
    const symbols: Record<string, string> = { AUD: 'A$', USD: '$', EUR: '€', GBP: '£', NZD: 'NZ$' };
    const sym = symbols[currency] || `${currency} `;
    // No decimals if whole number
    return price % 1 === 0 ? `${sym}${price.toLocaleString()}` : `${sym}${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const getConditionColor = (condition: string): string => {
    switch (condition) {
        case 'New': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
        case 'Like New': return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
        case 'Used - Good': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
        case 'Used - Fair': return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
        case 'Needs Repair': return 'text-red-400 bg-red-500/10 border-red-500/20';
        default: return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
    }
};

const AVATAR_GRADIENTS = [
    'from-sky-400 to-sky-600', 'from-emerald-400 to-emerald-600', 'from-purple-400 to-purple-600',
    'from-red-400 to-red-600', 'from-amber-400 to-amber-600', 'from-sky-400 to-sky-600',
];

const getAvatarGradient = (id: string): string => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) { hash = ((hash << 5) - hash) + id.charCodeAt(i); hash |= 0; }
    return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
};

// --- CSS ANIMATIONS ---
const STYLE_ID = 'marketplace-animations';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        @keyframes listingSlideIn {
            from { opacity: 0; transform: translateY(-20px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes shimmer {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
        }
        .listing-enter { animation: listingSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both; }
        .listing-shimmer { background: linear-gradient(90deg, transparent 25%, rgba(255,255,255,0.05) 50%, transparent 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    `;
    document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════
// LISTING CARD COMPONENT
// ═══════════════════════════════════════════════════════════════

interface ListingCardProps {
    listing: MarketplaceListing;
    isOwn: boolean;
    onMessageSeller: (listing: MarketplaceListing) => void;
    onMarkSold: (id: string) => void;
    onDelete: (id: string) => void;
    onFlagLocation?: (listing: MarketplaceListing) => void;
    isNew?: boolean;
}

const ListingCard: React.FC<ListingCardProps> = React.memo(({ listing, isOwn, onMessageSeller, onMarkSold, onDelete, onFlagLocation, isNew }) => {
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
        <div className={`mx-3 mb-3 transition-all duration-300 ${isNew ? 'animate-in slide-in-from-top-4 fade-in' : ''}`}>
            <div className="relative overflow-hidden rounded-2xl">
                {/* Delete button revealed on swipe (owner only) */}
                {isOwnerSwipeable && (
                    <div
                        className={`absolute right-0 top-0 bottom-0 w-20 bg-red-600 flex items-center justify-center rounded-r-2xl transition-opacity ${swipeOffset > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                        onClick={() => { resetSwipe(); onDelete(listing.id); }}
                    >
                        <div className="text-center text-white">
                            <svg className="w-5 h-5 mx-auto mb-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            <span className="text-[10px] font-bold uppercase">Delete</span>
                        </div>
                    </div>
                )}
                <div
                    className={`relative border border-white/[0.06] rounded-2xl bg-slate-800/40 overflow-hidden ${listing.status === 'sold' ? 'opacity-60' : ''} transition-transform ${isSwiping ? '' : 'duration-200'}`}
                    ref={isOwnerSwipeable ? swipeRef : undefined}
                    style={isOwnerSwipeable ? { transform: `translateX(-${swipeOffset}px)` } : undefined}
                >    {/* Subtle gradient bg */}
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
                                                key={i}
                                                onClick={(e) => { e.stopPropagation(); setImageIdx(i); }}
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
                                <div className={`absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wider ${getConditionColor(listing.condition)}`}>
                                    {listing.condition}
                                </div>
                            </div>
                        )}

                        {/* Content */}
                        <div className="p-3.5">
                            {/* If no image, show category inline */}
                            {!hasImages && (
                                <div className="flex items-center gap-2 mb-2">
                                    <span className={`px-2 py-0.5 rounded-full bg-white/[0.06] border ${t.border.default} text-[11px] font-bold text-white/70 uppercase tracking-wider`}>
                                        {CATEGORY_ICONS[listing.category]} {listing.category}
                                    </span>
                                    <span className={`px-2 py-0.5 rounded-full border text-[11px] font-bold uppercase tracking-wider ${getConditionColor(listing.condition)}`}>
                                        {listing.condition}
                                    </span>
                                </div>
                            )}

                            {/* Title + Price row */}
                            <div className="flex items-start justify-between gap-3">
                                <h3 className="text-sm font-semibold text-white leading-snug flex-1">{listing.title}</h3>
                                <div className="text-right shrink-0">
                                    <span className="text-lg font-bold text-emerald-400 whitespace-nowrap tracking-tight">
                                        {formatPrice(listing.price, listing.currency)}
                                    </span>
                                    {listing.boat_details?.price_reduced && listing.boat_details?.original_price && (
                                        <div className="flex items-center gap-1 justify-end mt-0.5">
                                            <span className="text-[10px] text-white/40 line-through">{formatPrice(listing.boat_details.original_price, listing.currency)}</span>
                                            <span className="text-[9px] font-bold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded-full uppercase">Reduced</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* \u2550\u2550\u2550 BOAT SPECS GRID \u2550\u2550\u2550 */}
                            {listing.boat_details && listing.category === 'Boats' && (() => {
                                const b = listing.boat_details!;
                                return (
                                    <>
                                        {/* Make/Model/Year headline */}
                                        {(b.make || b.model || b.year) && (
                                            <div className="mt-2 flex items-center gap-2 text-xs">
                                                {(b.make || b.model) && (
                                                    <span className="font-bold text-white/80">{[b.make, b.model].filter(Boolean).join(' ')}</span>
                                                )}
                                                {b.year && <span className="text-white/50">{b.year}</span>}
                                                {b.surveyed && (
                                                    <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded-full">\u2705 Surveyed</span>
                                                )}
                                            </div>
                                        )}

                                        {/* Spec chips row */}
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                            {b.loa_ft && (
                                                <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[10px] font-medium text-white/70">{b.loa_ft}ft</span>
                                            )}
                                            {b.beam_ft && (
                                                <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[10px] font-medium text-white/70">B: {b.beam_ft}ft</span>
                                            )}
                                            {b.draft_ft && (
                                                <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[10px] font-medium text-white/70">D: {b.draft_ft}ft</span>
                                            )}
                                            {b.hull_material && (
                                                <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[10px] font-medium text-white/70">{b.hull_material}</span>
                                            )}
                                            {b.engine_type && (
                                                <span className="px-2 py-0.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-[10px] font-medium text-sky-300/80">{b.engine_type}</span>
                                            )}
                                            {(b.engine_make || b.engine_hp) && (
                                                <span className="px-2 py-0.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-[10px] font-medium text-sky-300/80">
                                                    {[b.engine_make, b.engine_hp ? `${b.engine_hp}HP` : ''].filter(Boolean).join(' ')}
                                                </span>
                                            )}
                                            {b.engine_hours != null && (
                                                <span className="px-2 py-0.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] font-medium text-amber-300/80">{b.engine_hours.toLocaleString()}hrs</span>
                                            )}
                                            {b.fuel_type && (
                                                <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[10px] font-medium text-white/70">{b.fuel_type}</span>
                                            )}
                                            {b.berths && (
                                                <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[10px] font-medium text-white/70">{b.berths} berths</span>
                                            )}
                                            {b.cabins && (
                                                <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[10px] font-medium text-white/70">{b.cabins} cabin{b.cabins > 1 ? 's' : ''}</span>
                                            )}
                                            {b.heads && (
                                                <span className="px-2 py-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08] text-[10px] font-medium text-white/70">{b.heads} head{b.heads > 1 ? 's' : ''}</span>
                                            )}
                                        </div>

                                        {/* Feature tags */}
                                        {b.features && b.features.length > 0 && (
                                            <div className="mt-1.5 flex flex-wrap gap-1">
                                                {b.features.slice(0, expanded ? undefined : 6).map(f => (
                                                    <span key={f} className="px-1.5 py-0.5 rounded bg-emerald-500/8 border border-emerald-500/15 text-[9px] font-medium text-emerald-400/70">{f}</span>
                                                ))}
                                                {!expanded && b.features.length > 6 && (
                                                    <button onClick={() => setExpanded(true)} className="text-[9px] text-sky-400 font-medium">+{b.features.length - 6} more</button>
                                                )}
                                            </div>
                                        )}
                                    </>
                                );
                            })()}

                            {/* Description (expandable) */}
                            {listing.description && (
                                <button
                                    onClick={() => setExpanded(!expanded)}
                                    className="text-left mt-1.5"
                                >
                                    <p className={`text-xs text-white/60 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
                                        {listing.description}
                                    </p>
                                    {listing.description.length > 100 && (
                                        <span className="text-[11px] text-sky-400 font-medium">{expanded ? 'Less' : 'More'}</span>
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
                                    onClick={() => onFlagLocation(listing)}
                                    className="mt-1.5 text-[10px] text-amber-400/50 hover:text-amber-400 transition-colors flex items-center gap-1"
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
                                        <img src={listing.seller_avatar} className="w-8 h-8 rounded-full object-cover border border-white/10" alt="" />
                                    ) : (
                                        <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${getAvatarGradient(listing.seller_id)} flex items-center justify-center text-[11px] font-bold text-white shadow-inner`}>
                                            {(listing.seller_name || '?')[0].toUpperCase()}
                                        </div>
                                    )}
                                    <div className="flex flex-col">
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-xs font-semibold text-white/80">{(listing.seller_name || 'Sailor').split(' ')[0]}</span>
                                            {reputation && reputation.total_ratings > 0 && (
                                                <span className="text-[10px] text-amber-400 flex items-center gap-0.5">
                                                    ★ {reputation.avg_stars}
                                                    <span className="text-white/40">({reputation.total_ratings})</span>
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
                                                onClick={() => onMarkSold(listing.id)}
                                                className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-bold text-emerald-400 uppercase tracking-wider active:scale-95 transition-transform"
                                            >
                                                Mark Sold
                                            </button>
                                        )}
                                        <button
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
                                                onClick={() => onMessageSeller(listing)}
                                                className="px-3 py-1.5 rounded-xl bg-sky-500/20 border border-sky-500/30 text-[11px] font-bold text-sky-300 uppercase tracking-wider active:scale-95 transition-all hover:bg-sky-500/30"
                                            >
                                                💬 Message
                                            </button>
                                            {listing.status === 'available' && (
                                                <button
                                                    onClick={() => setShowOfferInput(!showOfferInput)}
                                                    className={`px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider active:scale-95 transition-all ${showOfferInput
                                                        ? 'bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
                                                        : 'bg-emerald-500/15 border-emerald-500/25 text-emerald-400'}`}
                                                >
                                                    💰 Offer
                                                </button>
                                            )}
                                        </div>
                                        {/* Make an Offer inline input */}
                                        {showOfferInput && (
                                            <div className="flex items-center gap-2 mt-1">
                                                <div className="flex-1 flex items-center bg-white/[0.06] border border-emerald-500/20 rounded-xl overflow-hidden">
                                                    <span className="pl-3 text-xs text-emerald-400/60 font-bold">{listing.currency === 'AUD' ? 'A$' : listing.currency === 'USD' ? '$' : listing.currency === 'EUR' ? '€' : listing.currency === 'GBP' ? '£' : listing.currency === 'NZD' ? 'NZ$' : listing.currency}</span>
                                                    <input
                                                        value={offerPrice}
                                                        onChange={e => setOfferPrice(e.target.value.replace(/[^0-9.]/g, ''))}
                                                        onFocus={scrollInputAboveKeyboard}
                                                        placeholder="Your offer"
                                                        inputMode="decimal"
                                                        className="flex-1 px-2 py-2 bg-transparent text-sm text-emerald-400 font-mono placeholder-white/30 outline-none"
                                                    />
                                                </div>
                                                <button
                                                    onClick={() => {
                                                        if (!offerPrice || parseFloat(offerPrice) <= 0) return;
                                                        const sellerFirst = (listing.seller_name || 'Seller').split(' ')[0];
                                                        const offerFormatted = formatPrice(parseFloat(offerPrice), listing.currency);
                                                        const text = `Hi ${sellerFirst}! I'd like to offer ${offerFormatted} for your "${listing.title}" (listed at ${formatPrice(listing.price, listing.currency)}). Let me know!`;
                                                        ChatService.sendDM(listing.seller_id, text);
                                                        if (onMessageSeller) onMessageSeller(listing);
                                                        setShowOfferInput(false);
                                                        setOfferPrice('');
                                                    }}
                                                    disabled={!offerPrice || parseFloat(offerPrice) <= 0}
                                                    className={`px-3 py-2 rounded-xl text-[11px] font-bold uppercase tracking-wider active:scale-95 transition-all ${!offerPrice || parseFloat(offerPrice) <= 0
                                                        ? 'bg-white/[0.04] border border-white/10 text-white/30'
                                                        : 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-400'}`}
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
                                        onClick={() => { onDelete(listing.id); setShowActions(false); }}
                                        className="flex-1 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-[11px] font-bold text-red-400 uppercase tracking-wider active:scale-95"
                                    >
                                        Delete
                                    </button>
                                </div>
                            )}

                            {/* Rate Seller — buyer only, sold listings only */}
                            {!isOwn && listing.status === 'sold' && !hasRated && (
                                <button
                                    onClick={() => setShowRateModal(true)}
                                    className="mt-2 w-full py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] font-bold text-amber-400 uppercase tracking-wider active:scale-95 transition-transform"
                                >
                                    ⭐ Rate This Seller
                                </button>
                            )}
                            {!isOwn && hasRated && listing.status === 'sold' && (
                                <p className="mt-2 text-[10px] text-emerald-400/60 text-center">✅ You've rated this seller</p>
                            )}

                            {/* Inline rating modal */}
                            {showRateModal && (
                                <div className="mt-3 p-3 rounded-xl bg-white/[0.04] border border-white/10 space-y-3">
                                    <p className="text-[11px] font-bold text-white/70 uppercase tracking-wider">Rate Seller</p>
                                    <div className="flex justify-center gap-1">
                                        {[1, 2, 3, 4, 5].map(s => (
                                            <button
                                                key={s}
                                                onClick={() => setRateStars(s)}
                                                className={`text-2xl transition-transform active:scale-90 ${s <= rateStars ? 'text-amber-400' : 'text-white/20'}`}
                                            >
                                                ★
                                            </button>
                                        ))}
                                    </div>
                                    <textarea
                                        value={rateComment}
                                        onChange={e => setRateComment(e.target.value)}
                                        placeholder="Optional comment..."
                                        rows={2}
                                        maxLength={300}
                                        className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white/80 placeholder-white/30 outline-none focus:border-amber-500/40 transition-colors resize-none"
                                    />
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setShowRateModal(false)}
                                            className="flex-1 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[11px] font-bold text-white/60 uppercase tracking-wider active:scale-95"
                                        >
                                            Cancel
                                        </button>
                                        <button
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
                            <span className="text-2xl font-black text-white/80 uppercase tracking-[0.3em] -rotate-12">SOLD</span>
                            {listing.sold_at && (
                                <span className="text-[10px] text-white/50 mt-1">Auto-removes in {Math.max(0, Math.ceil((new Date(listing.sold_at).getTime() + 48 * 3600000 - Date.now()) / 3600000))}h</span>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});

// ═══════════════════════════════════════════════════════════════
// CREATE LISTING MODAL
// ═══════════════════════════════════════════════════════════════

interface CreateListingModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated: (listing: MarketplaceListing) => void;
}

const CreateListingModal: React.FC<CreateListingModalProps> = ({ isOpen, onClose, onCreated }) => {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [price, setPrice] = useState('');
    const [currency, setCurrency] = useState<string>('AUD');
    const [category, setCategory] = useState<ListingCategory | null>(null);
    const [condition, setCondition] = useState<string | null>(null);
    const [locCountry, setLocCountry] = useState('');
    const [locState, setLocState] = useState('');
    const [locSuburb, setLocSuburb] = useState('');
    const [images, setImages] = useState<File[]>([]);
    const [imagePreviews, setImagePreviews] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<'details' | 'photos'>('details');
    const [gpsLat, setGpsLat] = useState<number | null>(null);
    const [gpsLon, setGpsLon] = useState<number | null>(null);
    const [locationWarning, setLocationWarning] = useState<string | null>(null);
    const autoFilledLocRef = useRef<{ lat: number; lon: number } | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // ── Keyboard height detection — same pattern as DiaryPage/AuthModal ──
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    useEffect(() => {
        if (!isOpen) { setKeyboardHeight(0); return; }
        let cleanup: (() => void) | undefined;

        if (Capacitor.isNativePlatform()) {
            import('@capacitor/keyboard').then(({ Keyboard }) => {
                const showHandle = Keyboard.addListener('keyboardDidShow', (info) => {
                    setKeyboardHeight(info.keyboardHeight > 0 ? info.keyboardHeight : 0);
                    // Scroll focused input into view WITHIN the scroll container only
                    setTimeout(() => {
                        const focused = document.activeElement as HTMLElement;
                        const container = scrollRef.current;
                        if (!focused || !container) return;
                        if (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA') return;
                        // Calculate position of focused element relative to scroll container
                        const focusRect = focused.getBoundingClientRect();
                        const containerRect = container.getBoundingClientRect();
                        const offsetInContainer = focusRect.top - containerRect.top + container.scrollTop;
                        // Scroll so the input sits roughly 1/3 from the top of the container
                        const targetScroll = offsetInContainer - containerRect.height * 0.3;
                        container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
                    }, 50);
                });
                const hideHandle = Keyboard.addListener('keyboardWillHide', () => {
                    setKeyboardHeight(0);
                });
                cleanup = () => {
                    showHandle.then(h => h.remove());
                    hideHandle.then(h => h.remove());
                };
            }).catch(() => { /* Keyboard plugin not available */ });
        } else {
            const vp = window.visualViewport;
            if (vp) {
                const handleResize = () => {
                    const kbHeight = window.innerHeight - vp.height;
                    setKeyboardHeight(kbHeight > 50 ? kbHeight : 0);
                };
                vp.addEventListener('resize', handleResize);
                cleanup = () => vp.removeEventListener('resize', handleResize);
            }
        }

        return () => { cleanup?.(); setKeyboardHeight(0); };
    }, [isOpen]);

    // ── Boat-specific state ──
    const [boatMake, setBoatMake] = useState('');
    const [boatModel, setBoatModel] = useState('');
    const [boatYear, setBoatYear] = useState('');
    const [boatLoa, setBoatLoa] = useState('');
    const [boatBeam, setBoatBeam] = useState('');
    const [boatDraft, setBoatDraft] = useState('');
    const [boatHull, setBoatHull] = useState<HullMaterial | null>(null);
    const [boatEngineType, setBoatEngineType] = useState<EngineType | null>(null);
    const [boatEngineMake, setBoatEngineMake] = useState('');
    const [boatHp, setBoatHp] = useState('');
    const [boatHours, setBoatHours] = useState('');
    const [boatFuel, setBoatFuel] = useState<FuelType | null>(null);
    const [boatBerths, setBoatBerths] = useState('');
    const [boatCabins, setBoatCabins] = useState('');
    const [boatHeads, setBoatHeads] = useState('');
    const [boatRego, setBoatRego] = useState('');
    const [boatSurveyed, setBoatSurveyed] = useState(false);
    const [boatFeatures, setBoatFeatures] = useState<string[]>([]);

    const isBoat = category === 'Boats';

    // Get GPS + auto-fill location on open
    useEffect(() => {
        if (!isOpen) return;
        const pos = BgGeoManager.getLastPosition();
        if (pos) {
            setGpsLat(pos.latitude);
            setGpsLon(pos.longitude);
            autoFilledLocRef.current = { lat: pos.latitude, lon: pos.longitude };
            // Reverse-geocode to auto-fill Country / State / Suburb
            fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.latitude}&lon=${pos.longitude}&format=json&zoom=10`)
                .then(r => r.json())
                .then(data => {
                    if (data?.address) {
                        setLocCountry(data.address.country || '');
                        setLocState(data.address.state || data.address.region || '');
                        setLocSuburb(data.address.suburb || data.address.town || data.address.city || data.address.village || '');
                    }
                })
                .catch(() => { /* best effort */ });
        }
    }, [isOpen]);

    /** Check if user-edited location is suspiciously far from GPS */
    const checkLocationDistance = useCallback(async (country: string, state: string, suburb: string) => {
        if (!autoFilledLocRef.current) { setLocationWarning(null); return; }
        const query = [suburb, state, country].filter(Boolean).join(', ');
        if (!query) { setLocationWarning(null); return; }
        try {
            const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`);
            const results = await r.json();
            if (results?.[0]) {
                const dist = haversineNm(autoFilledLocRef.current.lat, autoFilledLocRef.current.lon, parseFloat(results[0].lat), parseFloat(results[0].lon));
                if (dist > 100) {
                    setLocationWarning(`⚠️ This location is ~${Math.round(dist)}nm from your current GPS position. Buyers may see this as suspicious.`);
                } else {
                    setLocationWarning(null);
                }
            }
        } catch { setLocationWarning(null); }
    }, []);

    const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        const newImages = [...images, ...files].slice(0, MAX_PHOTOS);
        setImages(newImages);
        // Generate previews
        const previews: string[] = [];
        for (const f of newImages) {
            previews.push(URL.createObjectURL(f));
        }
        setImagePreviews(previews);
    };

    const removeImage = (idx: number) => {
        const newImages = images.filter((_, i) => i !== idx);
        const newPreviews = imagePreviews.filter((_, i) => i !== idx);
        setImages(newImages);
        setImagePreviews(newPreviews);
    };

    const reset = () => {
        setTitle(''); setDescription(''); setPrice(''); setCurrency('AUD');
        setCategory(null); setCondition(null);
        setLocCountry(''); setLocState(''); setLocSuburb('');
        setLocationWarning(null); autoFilledLocRef.current = null;
        setImages([]); setImagePreviews([]); setStep('details');
        setError(null); setSubmitting(false);
        // Boat fields
        setBoatMake(''); setBoatModel(''); setBoatYear(''); setBoatLoa('');
        setBoatBeam(''); setBoatDraft(''); setBoatHull(null);
        setBoatEngineType(null); setBoatEngineMake(''); setBoatHp('');
        setBoatHours(''); setBoatFuel(null); setBoatBerths('');
        setBoatCabins(''); setBoatHeads(''); setBoatRego('');
        setBoatSurveyed(false); setBoatFeatures([]);
    };

    const handleSubmit = async () => {
        if (!title.trim()) { setError('Title is required'); return; }
        if (!price || parseFloat(price) <= 0) { setError('Valid price is required'); return; }
        if (!category) { setError('Select a category'); return; }
        if (!condition) { setError('Select condition'); return; }

        setSubmitting(true);
        setError(null);

        const input: CreateListingInput = {
            title: title.trim(),
            description: description.trim() || undefined,
            price: parseFloat(price),
            currency,
            category,
            condition: condition as any,
            images: images.length > 0 ? images : undefined,
            latitude: gpsLat || undefined,
            longitude: gpsLon || undefined,
            location_name: [locSuburb.trim(), locState.trim(), locCountry.trim()].filter(Boolean).join(', ') || undefined,
        };

        // Attach boat details if Boats category
        if (isBoat) {
            input.boat_details = {
                make: boatMake.trim() || undefined,
                model: boatModel.trim() || undefined,
                year: boatYear ? parseInt(boatYear) : undefined,
                loa_ft: boatLoa ? parseFloat(boatLoa) : undefined,
                beam_ft: boatBeam ? parseFloat(boatBeam) : undefined,
                draft_ft: boatDraft ? parseFloat(boatDraft) : undefined,
                hull_material: boatHull || undefined,
                engine_type: boatEngineType || undefined,
                engine_make: boatEngineMake.trim() || undefined,
                engine_hp: boatHp ? parseInt(boatHp) : undefined,
                engine_hours: boatHours ? parseInt(boatHours) : undefined,
                fuel_type: boatFuel || undefined,
                berths: boatBerths ? parseInt(boatBerths) : undefined,
                cabins: boatCabins ? parseInt(boatCabins) : undefined,
                heads: boatHeads ? parseInt(boatHeads) : undefined,
                rego_number: boatRego.trim() || undefined,
                surveyed: boatSurveyed || undefined,
                features: boatFeatures.length > 0 ? boatFeatures : undefined,
            };
        }

        const result = await MarketplaceService.createListing(input);
        setSubmitting(false);

        if (result) {
            onCreated(result);
            reset();
            onClose();
        } else {
            setError('Failed to create listing. Try again.');
        }
    };

    if (!isOpen) return null;

    const CURRENCIES = ['AUD', 'USD', 'EUR', 'GBP', 'NZD'];

    // Keyboard padding for scroll area — same as DiaryPage approach
    // Don't move the modal, just shrink the scroll area
    const scrollPadBottom = keyboardHeight > 0 ? `${keyboardHeight}px` : '0px';

    return (
        <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70" onClick={onClose}>
            <div
                className="w-full max-w-lg bg-slate-950 border-t border-white/10 rounded-3xl shadow-2xl flex flex-col"
                style={{
                    maxHeight: 'calc(100dvh - 5rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 8px)',
                    marginBottom: 'calc(4rem + env(safe-area-inset-bottom, 0px) + 8px)',
                }}
                onClick={e => e.stopPropagation()}
            >
                {/* Header — sticky at top of modal */}
                <div className="shrink-0 flex items-center justify-between px-5 py-4 bg-slate-900/95 border-b border-white/[0.06] rounded-t-3xl">
                    <button onClick={() => { reset(); onClose(); }} className="text-xs text-white/60 font-medium">Cancel</button>
                    <h2 className="text-sm font-bold text-white">{isBoat ? 'List a Boat for Sale' : 'List Gear for Sale'}</h2>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !title.trim() || !price || !category || !condition}
                        className={`text-xs font-bold ${submitting || !title.trim() || !price || !category || !condition ? 'text-white/30' : 'text-sky-400'}`}
                    >
                        {submitting ? '⏳' : 'Post'}
                    </button>
                </div>

                <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-5" style={{ paddingBottom: scrollPadBottom, WebkitOverflowScrolling: 'touch' as any }}>
                    {/* Error */}
                    {error && (
                        <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                            {error}
                        </div>
                    )}

                    {/* Category */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">Category</label>
                        <div className="flex flex-wrap gap-2">
                            {LISTING_CATEGORIES.map(cat => (
                                <button
                                    key={cat}
                                    onClick={() => setCategory(cat)}
                                    className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${category === cat
                                        ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                                        : 'bg-white/[0.04] border-white/10 text-white/60 hover:border-white/20'}`}
                                >
                                    {CATEGORY_ICONS[cat]} {cat}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Title */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">{isBoat ? 'Listing Title' : 'Title'}</label>
                        <input
                            value={title}
                            onChange={e => setTitle(e.target.value)}

                            placeholder={isBoat ? 'e.g. 2019 Beneteau Oceanis 40.1' : 'e.g. Raymarine Axiom 12 MFD'}
                            maxLength={100}
                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                        />
                    </div>

                    {/* Description */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Description</label>
                        <textarea
                            value={description}
                            onChange={e => setDescription(e.target.value)}

                            placeholder="Describe the item, any defects, model year, etc."
                            rows={3}
                            maxLength={1000}
                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white/80 placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors resize-none"
                        />
                    </div>

                    {/* ═══ BOAT-SPECIFIC FIELDS ═══ */}
                    {isBoat && (
                        <>
                            {/* Make & Model */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Make</label>
                                    <input value={boatMake} onChange={e => setBoatMake(e.target.value)} placeholder="Beneteau" maxLength={60}
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Model</label>
                                    <input value={boatModel} onChange={e => setBoatModel(e.target.value)} placeholder="Oceanis 40.1" maxLength={60}
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                            </div>

                            {/* Year & LOA */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Year Built</label>
                                    <input value={boatYear} onChange={e => setBoatYear(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="2019" inputMode="numeric"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Length (ft)</label>
                                    <input value={boatLoa} onChange={e => setBoatLoa(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="40" inputMode="decimal"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                            </div>

                            {/* Beam & Draft */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Beam (ft)</label>
                                    <input value={boatBeam} onChange={e => setBoatBeam(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="13" inputMode="decimal"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Draft (ft)</label>
                                    <input value={boatDraft} onChange={e => setBoatDraft(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="6.5" inputMode="decimal"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                            </div>

                            {/* Hull Material */}
                            <div>
                                <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">Hull Material</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {HULL_MATERIALS.map(h => (
                                        <button key={h} onClick={() => setBoatHull(h)}
                                            className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-all ${boatHull === h
                                                ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                                                : 'bg-white/[0.04] border-white/10 text-white/60'}`}
                                        >{h}</button>
                                    ))}
                                </div>
                            </div>

                            {/* Engine section */}
                            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] space-y-3">
                                <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider block">Engine</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {ENGINE_TYPES.map(et => (
                                        <button key={et} onClick={() => setBoatEngineType(et)}
                                            className={`px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-all ${boatEngineType === et
                                                ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                                                : 'bg-white/[0.04] border-white/10 text-white/60'}`}
                                        >{et}</button>
                                    ))}
                                </div>
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <input value={boatEngineMake} onChange={e => setBoatEngineMake(e.target.value)} placeholder="Engine make (e.g. Yanmar)" maxLength={40}
                                            className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                    </div>
                                    <div className="w-20">
                                        <input value={boatHp} onChange={e => setBoatHp(e.target.value.replace(/\D/g, ''))} placeholder="HP" inputMode="numeric"
                                            className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <div className="flex-1">
                                        <input value={boatHours} onChange={e => setBoatHours(e.target.value.replace(/\D/g, ''))} placeholder="Engine hours" inputMode="numeric"
                                            className="w-full px-3 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex flex-wrap gap-1">
                                            {FUEL_TYPES.map(f => (
                                                <button key={f} onClick={() => setBoatFuel(f)}
                                                    className={`px-2 py-1 rounded-lg border text-[10px] font-medium transition-all ${boatFuel === f
                                                        ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                                                        : 'bg-white/[0.04] border-white/10 text-white/50'}`}
                                                >{f}</button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Accommodation */}
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Berths</label>
                                    <input value={boatBerths} onChange={e => setBoatBerths(e.target.value.replace(/\D/g, ''))} placeholder="6" inputMode="numeric"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Cabins</label>
                                    <input value={boatCabins} onChange={e => setBoatCabins(e.target.value.replace(/\D/g, ''))} placeholder="3" inputMode="numeric"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Heads</label>
                                    <input value={boatHeads} onChange={e => setBoatHeads(e.target.value.replace(/\D/g, ''))} placeholder="2" inputMode="numeric"
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                            </div>

                            {/* Rego & Survey */}
                            <div className="flex gap-2 items-end">
                                <div className="flex-1">
                                    <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Rego Number</label>
                                    <input value={boatRego} onChange={e => setBoatRego(e.target.value)} placeholder="Optional" maxLength={30}
                                        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                                </div>
                                <button
                                    onClick={() => setBoatSurveyed(!boatSurveyed)}
                                    className={`px-3 py-2.5 rounded-xl border text-xs font-bold transition-all ${boatSurveyed
                                        ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                                        : 'bg-white/[0.04] border-white/10 text-white/50'}`}
                                >
                                    {boatSurveyed ? '✅ Surveyed' : '📋 Surveyed?'}
                                </button>
                            </div>

                            {/* Features (tag chips) */}
                            <div>
                                <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">Features & Equipment</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {BOAT_FEATURES.filter((v, i, a) => a.indexOf(v) === i).map(feat => {
                                        const selected = boatFeatures.includes(feat);
                                        return (
                                            <button key={feat}
                                                onClick={() => setBoatFeatures(prev => selected ? prev.filter(f => f !== feat) : [...prev, feat])}
                                                className={`px-2 py-1 rounded-lg border text-[10px] font-medium transition-all ${selected
                                                    ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                                                    : 'bg-white/[0.03] border-white/[0.06] text-white/40'}`}
                                            >
                                                {selected ? '✓ ' : ''}{feat}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </>
                    )}

                    {/* Condition */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">Condition</label>
                        <div className="flex flex-wrap gap-2">
                            {LISTING_CONDITIONS.map(cond => (
                                <button
                                    key={cond}
                                    onClick={() => setCondition(cond)}
                                    className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${condition === cond
                                        ? `${getConditionColor(cond)}`
                                        : 'bg-white/[0.04] border-white/10 text-white/60 hover:border-white/20'}`}
                                >
                                    {cond}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Price + Currency */}
                    <div className="flex gap-3">
                        <div className="flex-1">
                            <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Price</label>
                            <input
                                value={price}
                                onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
    
                                placeholder="0.00"
                                inputMode="decimal"
                                className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-emerald-400 font-mono placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                            />
                        </div>
                        <div className="w-24">
                            <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">Currency</label>
                            <select
                                value={currency}
                                onChange={e => setCurrency(e.target.value)}
                                className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white outline-none"
                            >
                                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                    </div>

                    {/* Location (Country / State / Suburb — privacy safe, auto-filled from GPS) */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-1.5 block">
                            Location {gpsLat ? '(auto-filled from GPS)' : ''}
                        </label>
                        <div className="flex gap-2 flex-wrap">
                            <input
                                value={locCountry}
                                onChange={e => { setLocCountry(e.target.value); checkLocationDistance(e.target.value, locState, locSuburb); }}
    
                                placeholder="Country"
                                className="flex-1 px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                            />
                            <input
                                value={locState}
                                onChange={e => { setLocState(e.target.value); checkLocationDistance(locCountry, e.target.value, locSuburb); }}
    
                                placeholder="State"
                                className="flex-1 px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                            />
                            <input
                                value={locSuburb}
                                onChange={e => { setLocSuburb(e.target.value); checkLocationDistance(locCountry, locState, e.target.value); }}
    
                                placeholder="Suburb"
                                className="flex-1 px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                            />
                        </div>
                        {locationWarning && (
                            <div className="mt-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-400 leading-relaxed">
                                {locationWarning}
                            </div>
                        )}
                    </div>



                    {/* Photos */}
                    <div>
                        <label className="text-[11px] font-bold text-white/60 uppercase tracking-wider mb-2 block">Photos (up to {MAX_PHOTOS})</label>
                        <div className="flex gap-2 flex-wrap">
                            {imagePreviews.map((url, i) => (
                                <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden border border-white/10">
                                    <img src={url} className="w-full h-full object-cover" alt="" />
                                    <button
                                        onClick={() => removeImage(i)}
                                        className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-black/70 text-white text-[11px]"
                                    >✕</button>
                                </div>
                            ))}
                            {images.length < MAX_PHOTOS && (
                                <button
                                    onClick={() => fileRef.current?.click()}
                                    className="w-20 h-20 rounded-xl border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-white/60 hover:border-sky-500/30 hover:text-sky-400/50 transition-colors"
                                >
                                    <span className="text-xl">+</span>
                                    <span className="text-[11px] mt-0.5">Add</span>
                                </button>
                            )}
                        </div>
                        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={handleImageSelect} />
                    </div>

                    {/* Bottom spacer inside scroll area */}
                    <div className="h-2" />
                </div>

                {/* Submit button — pinned outside scroll area */}
                <div className="shrink-0 px-5 py-3 border-t border-white/[0.06] bg-slate-950">
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !title.trim() || !price || !category || !condition}
                        className={`w-full py-3.5 rounded-2xl font-bold text-sm uppercase tracking-wider transition-all active:scale-[0.98] ${submitting || !title.trim() || !price || !category || !condition
                            ? 'bg-white/[0.04] text-white/60 border border-white/[0.06]'
                            : 'bg-gradient-to-r from-sky-500 to-sky-500 text-white shadow-lg shadow-sky-500/20'}`}
                    >
                        {submitting ? '⏳ Creating Listing...' : '🏪 Post to Marketplace'}
                    </button>
                </div>
            </div>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════
// MAIN MARKETPLACE PAGE
// ═══════════════════════════════════════════════════════════════

interface MarketplacePageProps {
    onBack: () => void;
    onOpenDM?: (sellerId: string, sellerName: string, listingContext?: { title: string; price: string; image?: string }) => void;
}

export const MarketplacePage: React.FC<MarketplacePageProps> = ({ onBack, onOpenDM }) => {
    const [listings, setListings] = useState<MarketplaceListing[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeCategory, setActiveCategory] = useState<ListingCategory | null>(null);
    const [showCreate, setShowCreate] = useState(false);
    const [newListingIds, setNewListingIds] = useState<Set<string>>(new Set());
    const [deletedListing, setDeletedListing] = useState<MarketplaceListing | null>(null);
    const [userId, setUserId] = useState<string | null>(null);
    const feedRef = useRef<HTMLDivElement>(null);

    // Initialize
    useEffect(() => {
        const init = async () => {
            await MarketplaceService.initialize();
            setUserId(MarketplaceService.getCurrentUserId());
            await loadListings();
        };
        init();

        // Subscribe to Realtime
        const unsub = MarketplaceService.subscribeToFeed((newListing) => {
            setListings(prev => {
                // Deduplicate or update
                const existing = prev.findIndex(l => l.id === newListing.id);
                if (existing >= 0) {
                    const next = [...prev];
                    next[existing] = newListing;
                    return next;
                }
                // Only add if it matches the active filter
                if (activeCategory && newListing.category !== activeCategory) return prev;
                // Mark as new for animation
                setNewListingIds(prev => new Set(prev).add(newListing.id));
                setTimeout(() => setNewListingIds(prev => {
                    const next = new Set(prev);
                    next.delete(newListing.id);
                    return next;
                }), 2000);
                return [newListing, ...prev];
            });
        });

        return () => unsub();
    }, []);

    const loadListings = async (cat?: ListingCategory | null) => {
        setLoading(true);
        const data = await MarketplaceService.getListings(cat, 30);
        setListings(data);
        setLoading(false);
    };

    const handleCategoryFilter = (cat: ListingCategory | null) => {
        setActiveCategory(cat);
        loadListings(cat);
    };

    const handleMessageSeller = async (listing: MarketplaceListing) => {
        // Auto-DM the seller with item context and open the DM thread
        const sellerFirst = (listing.seller_name || 'Seller').split(' ')[0];
        const text = `Hi ${sellerFirst}! I'm interested in your "${listing.title}" (${formatPrice(listing.price, listing.currency)}). Is it still available?`;
        await ChatService.sendDM(listing.seller_id, text);
        if (onOpenDM) {
            onOpenDM(listing.seller_id, sellerFirst);
        }
    };

    const handleMarkSold = async (id: string) => {
        const ok = await MarketplaceService.markSold(id);
        if (ok) {
            setListings(prev => prev.map(l => l.id === id ? { ...l, status: 'sold' as const } : l));
        }
    };

    // ── Soft-delete with undo ──
    const handleDelete = (id: string) => {
        const listing = listings.find(l => l.id === id);
        if (!listing) return;
        triggerHaptic('medium');
        // Remove from UI immediately
        setListings(prev => prev.filter(l => l.id !== id));
        setDeletedListing(listing);
    };

    // Called by UndoToast after 5s — performs the actual API delete
    const handleDismissDelete = async () => {
        if (!deletedListing) return;
        const listing = deletedListing;
        setDeletedListing(null);
        try {
            await MarketplaceService.deleteListing(listing.id);
        } catch {
            toast.error('Failed to delete listing');
            setListings(prev => [listing, ...prev]);
        }
    };

    const handleUndoDelete = () => {
        if (deletedListing) {
            setListings(prev => [deletedListing, ...prev]);
            toast.success('Listing restored');
        }
        setDeletedListing(null);
    };

    const handleCreated = (listing: MarketplaceListing) => {
        setNewListingIds(prev => new Set(prev).add(listing.id));
        setListings(prev => [listing, ...prev]);
        setTimeout(() => setNewListingIds(prev => {
            const next = new Set(prev);
            next.delete(listing.id);
            return next;
        }), 2000);
    };

    const handleFlagLocation = async (listing: MarketplaceListing) => {
        // DM the seller with a polite heads-up
        const sellerFirst = (listing.seller_name || 'Seller').split(' ')[0];
        await ChatService.sendDM(
            listing.seller_id,
            `Hi ${sellerFirst}, a buyer has flagged that the listed location for "${listing.title}" may not match your actual area. If this is intentional, no worries — just letting you know! 🙏`
        );
        toast.success('Location flagged — seller has been notified');
    };

    return (
        <div className="flex flex-col bg-slate-950">
            {/* ═══════ HEADER ═══════ */}
            <div className="sticky top-0 z-20 bg-slate-950/95 border-b border-white/[0.06]">


                {/* Category chips */}
                <div className="px-3 pt-2 pb-2.5 flex flex-wrap gap-2">
                    <button
                        onClick={() => handleCategoryFilter(null)}
                        className={`whitespace-nowrap px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all shrink-0 ${!activeCategory
                            ? 'bg-white/10 border-white/20 text-white'
                            : 'bg-white/[0.03] border-white/[0.06] text-white/60 hover:text-white/60'}`}
                    >
                        All
                    </button>
                    {LISTING_CATEGORIES.map(cat => (
                        <button
                            key={cat}
                            onClick={() => handleCategoryFilter(cat)}
                            className={`whitespace-nowrap px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all shrink-0 ${activeCategory === cat
                                ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                                : 'bg-white/[0.03] border-white/[0.06] text-white/60 hover:text-white/60'}`}
                        >
                            {CATEGORY_ICONS[cat]} {cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* ═══════ FEED ═══════ */}
            <div ref={feedRef} className="flex-1 py-3 pb-36">
                {loading ? (
                    /* Skeleton loader */
                    <div className="space-y-3 px-3">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="rounded-2xl border border-white/[0.06] bg-white/[0.03] overflow-hidden">
                                <div className="w-full aspect-[16/10] skeleton-shimmer" />
                                <div className="p-4 space-y-3">
                                    <div className="h-4 w-3/4 rounded-lg skeleton-shimmer" />
                                    <div className="h-3 w-1/3 rounded-lg skeleton-shimmer" />
                                    <div className="h-8 w-full rounded-xl skeleton-shimmer" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : listings.length === 0 ? (
                    /* Empty state */
                    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
                        <div className="text-3xl mb-4">⚓</div>
                        <h3 className="text-lg font-bold text-white/80 mb-2">No Gear Listed Yet</h3>
                        <p className="text-xs text-white/60 mb-2 max-w-xs leading-relaxed">
                            Be the first to list your marine gear. Electronics, sails, rigging — if it floats or helps you float, it belongs here.
                        </p>
                    </div>
                ) : (
                    /* Listing cards */
                    listings.map(listing => (
                        <ListingCard
                            key={listing.id}
                            listing={listing}
                            isOwn={listing.seller_id === userId}
                            onMessageSeller={handleMessageSeller}
                            onMarkSold={handleMarkSold}
                            onDelete={handleDelete}
                            onFlagLocation={handleFlagLocation}
                            isNew={newListingIds.has(listing.id)}
                        />
                    ))
                )}
            </div>

            {/* Slide to add listing CTA */}
            <div className="fixed left-0 right-0 px-4 z-20" style={{ bottom: 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}>
                <SlideToAction
                    label="Slide to List Something for Sale"
                    thumbIcon={
                        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                    }
                    onConfirm={() => {
                        triggerHaptic('medium');
                        setShowCreate(true);
                    }}
                    theme="sky"
                />
            </div>

            {/* Create listing modal */}
            <CreateListingModal
                isOpen={showCreate}
                onClose={() => setShowCreate(false)}
                onCreated={handleCreated}
            />

            {/* Undo toast for delete */}
            <UndoToast
                isOpen={!!deletedListing}
                message={`"${deletedListing?.title}" deleted`}
                onUndo={handleUndoDelete}
                onDismiss={handleDismissDelete}
            />

        </div>
    );
};
