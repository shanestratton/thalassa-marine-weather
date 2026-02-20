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
import {
    MarketplaceService,
    MarketplaceListing,
    ListingCategory,
    LISTING_CATEGORIES,
    LISTING_CONDITIONS,
    CATEGORY_ICONS,
    CreateListingInput,
} from '../services/MarketplaceService';
import { ChatService } from '../services/ChatService';
import { BgGeoManager } from '../services/BgGeoManager';
import { CheckoutModal } from './marketplace/CheckoutModal';
import { t } from '../theme';

// --- HELPERS ---

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
        case 'Used - Fair': return 'text-orange-400 bg-orange-500/10 border-orange-500/20';
        case 'Needs Repair': return 'text-red-400 bg-red-500/10 border-red-500/20';
        default: return 'text-slate-400 bg-slate-500/10 border-slate-500/20';
    }
};

const AVATAR_GRADIENTS = [
    'from-sky-400 to-blue-600', 'from-emerald-400 to-teal-600', 'from-violet-400 to-purple-600',
    'from-rose-400 to-pink-600', 'from-amber-400 to-orange-600', 'from-cyan-400 to-sky-600',
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
    isNew?: boolean;
}

const ListingCard: React.FC<ListingCardProps> = ({ listing, isOwn, onMessageSeller, onMarkSold, onDelete, isNew }) => {
    const [expanded, setExpanded] = useState(false);
    const [imageIdx, setImageIdx] = useState(0);
    const [showActions, setShowActions] = useState(false);

    const hasImages = listing.images.length > 0;

    return (
        <div className={`mx-3 mb-3 ${isNew ? 'listing-enter' : ''}`}>
            <div className={`relative rounded-2xl overflow-hidden border ${t.border.default} bg-white/[0.04] backdrop-blur-xl shadow-lg`}>
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
                                            key={i}
                                            onClick={(e) => { e.stopPropagation(); setImageIdx(i); }}
                                            className={`w-1.5 h-1.5 rounded-full transition-all ${i === imageIdx ? 'bg-white w-4' : 'bg-white/40'}`}
                                        />
                                    ))}
                                </div>
                            )}
                            {/* Category badge */}
                            <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded-full bg-black/50 backdrop-blur-md border border-white/10 text-[10px] font-bold text-white/90 uppercase tracking-wider">
                                {CATEGORY_ICONS[listing.category]} {listing.category}
                            </div>
                            {/* Condition badge */}
                            <div className={`absolute top-2.5 right-2.5 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider backdrop-blur-md ${getConditionColor(listing.condition)}`}>
                                {listing.condition}
                            </div>
                        </div>
                    )}

                    {/* Content */}
                    <div className="p-3.5">
                        {/* If no image, show category inline */}
                        {!hasImages && (
                            <div className="flex items-center gap-2 mb-2">
                                <span className={`px-2 py-0.5 rounded-full bg-white/[0.06] border ${t.border.default} text-[10px] font-bold text-white/70 uppercase tracking-wider`}>
                                    {CATEGORY_ICONS[listing.category]} {listing.category}
                                </span>
                                <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${getConditionColor(listing.condition)}`}>
                                    {listing.condition}
                                </span>
                            </div>
                        )}

                        {/* Title + Price row */}
                        <div className="flex items-start justify-between gap-3">
                            <h3 className="text-[15px] font-semibold text-white leading-snug flex-1">{listing.title}</h3>
                            <span className="text-lg font-bold text-emerald-400 whitespace-nowrap tracking-tight">
                                {formatPrice(listing.price, listing.currency)}
                            </span>
                        </div>

                        {/* Description (expandable) */}
                        {listing.description && (
                            <button
                                onClick={() => setExpanded(!expanded)}
                                className="text-left mt-1.5"
                            >
                                <p className={`text-[12px] text-white/50 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
                                    {listing.description}
                                </p>
                                {listing.description.length > 100 && (
                                    <span className="text-[10px] text-sky-400 font-medium">{expanded ? 'Less' : 'More'}</span>
                                )}
                            </button>
                        )}

                        {/* Location + Distance + Time */}
                        <div className="flex items-center gap-2 mt-2.5 text-[11px] text-white/40">
                            {listing.location_name && (
                                <span className="flex items-center gap-1">
                                    <span className="text-white/30">📍</span>
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
                                    <span className="text-[12px] font-semibold text-white/80">{listing.seller_name || 'Sailor'}</span>
                                    {listing.seller_vessel && (
                                        <span className="text-[10px] text-white/30 flex items-center gap-0.5">
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
                                        className="w-8 h-8 flex items-center justify-center rounded-xl bg-white/[0.06] text-white/40"
                                    >
                                        ⋯
                                    </button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => onMessageSeller(listing)}
                                    className="px-4 py-2 rounded-xl bg-sky-500/20 border border-sky-500/30 text-[12px] font-bold text-sky-300 uppercase tracking-wider active:scale-95 transition-all hover:bg-sky-500/30"
                                >
                                    🛒 Buy
                                </button>
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
                    </div>
                </div>

                {/* SOLD overlay */}
                {listing.status === 'sold' && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center backdrop-blur-sm">
                        <span className="text-2xl font-black text-white/80 uppercase tracking-[0.3em] -rotate-12">SOLD</span>
                    </div>
                )}
            </div>
        </div>
    );
};

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
    const [locationName, setLocationName] = useState('');
    const [images, setImages] = useState<File[]>([]);
    const [imagePreviews, setImagePreviews] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [step, setStep] = useState<'details' | 'photos'>('details');
    const [gpsLat, setGpsLat] = useState<number | null>(null);
    const [gpsLon, setGpsLon] = useState<number | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    // Get GPS on open
    useEffect(() => {
        if (!isOpen) return;
        const pos = BgGeoManager.getLastPosition();
        if (pos) {
            setGpsLat(pos.latitude);
            setGpsLon(pos.longitude);
        }
    }, [isOpen]);

    const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        const newImages = [...images, ...files].slice(0, 4);
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
        setCategory(null); setCondition(null); setLocationName('');
        setImages([]); setImagePreviews([]); setStep('details');
        setError(null); setSubmitting(false);
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
            location_name: locationName.trim() || undefined,
        };

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

    return (
        <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div
                className="w-full max-w-lg bg-slate-900/98 border-t border-white/10 rounded-t-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-slate-900/95 backdrop-blur-xl border-b border-white/[0.06]">
                    <button onClick={() => { reset(); onClose(); }} className="text-[13px] text-white/50 font-medium">Cancel</button>
                    <h2 className="text-[15px] font-bold text-white">List Gear for Sale</h2>
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !title.trim() || !price || !category || !condition}
                        className={`text-[13px] font-bold ${submitting || !title.trim() || !price || !category || !condition ? 'text-white/20' : 'text-sky-400'}`}
                    >
                        {submitting ? '⏳' : 'Post'}
                    </button>
                </div>

                <div className="px-5 py-4 space-y-5">
                    {/* Error */}
                    {error && (
                        <div className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-[12px] text-red-400">
                            {error}
                        </div>
                    )}

                    {/* Photos */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider mb-2 block">Photos (up to 4)</label>
                        <div className="flex gap-2 flex-wrap">
                            {imagePreviews.map((url, i) => (
                                <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden border border-white/10">
                                    <img src={url} className="w-full h-full object-cover" alt="" />
                                    <button
                                        onClick={() => removeImage(i)}
                                        className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-black/70 text-white text-[10px]"
                                    >✕</button>
                                </div>
                            ))}
                            {images.length < 4 && (
                                <button
                                    onClick={() => fileRef.current?.click()}
                                    className="w-20 h-20 rounded-xl border-2 border-dashed border-white/10 flex flex-col items-center justify-center text-white/30 hover:border-sky-500/30 hover:text-sky-400/50 transition-colors"
                                >
                                    <span className="text-xl">+</span>
                                    <span className="text-[9px] mt-0.5">Add</span>
                                </button>
                            )}
                        </div>
                        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={handleImageSelect} />
                    </div>

                    {/* Title */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider mb-1.5 block">Title</label>
                        <input
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="e.g. Raymarine Axiom 12 MFD"
                            maxLength={100}
                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-[14px] text-white placeholder-white/20 outline-none focus:border-sky-500/40 transition-colors"
                        />
                    </div>

                    {/* Price + Currency */}
                    <div className="flex gap-3">
                        <div className="flex-1">
                            <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider mb-1.5 block">Price</label>
                            <input
                                value={price}
                                onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
                                placeholder="0.00"
                                inputMode="decimal"
                                className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-[14px] text-emerald-400 font-mono placeholder-white/20 outline-none focus:border-sky-500/40 transition-colors"
                            />
                        </div>
                        <div className="w-24">
                            <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider mb-1.5 block">Currency</label>
                            <select
                                value={currency}
                                onChange={e => setCurrency(e.target.value)}
                                className="w-full px-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-[14px] text-white outline-none"
                            >
                                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                    </div>

                    {/* Category */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider mb-2 block">Category</label>
                        <div className="flex flex-wrap gap-2">
                            {LISTING_CATEGORIES.map(cat => (
                                <button
                                    key={cat}
                                    onClick={() => setCategory(cat)}
                                    className={`px-3 py-1.5 rounded-xl border text-[12px] font-medium transition-all ${category === cat
                                        ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                                        : 'bg-white/[0.04] border-white/10 text-white/50 hover:border-white/20'}`}
                                >
                                    {CATEGORY_ICONS[cat]} {cat}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Condition */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider mb-2 block">Condition</label>
                        <div className="flex flex-wrap gap-2">
                            {LISTING_CONDITIONS.map(cond => (
                                <button
                                    key={cond}
                                    onClick={() => setCondition(cond)}
                                    className={`px-3 py-1.5 rounded-xl border text-[12px] font-medium transition-all ${condition === cond
                                        ? `${getConditionColor(cond)}`
                                        : 'bg-white/[0.04] border-white/10 text-white/50 hover:border-white/20'}`}
                                >
                                    {cond}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Description */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider mb-1.5 block">Description</label>
                        <textarea
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            placeholder="Describe the item, any defects, model year, etc."
                            rows={3}
                            maxLength={1000}
                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-[13px] text-white/80 placeholder-white/20 outline-none focus:border-sky-500/40 transition-colors resize-none"
                        />
                    </div>

                    {/* Location */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider mb-1.5 block">
                            Location {gpsLat ? '(GPS auto-filled)' : ''}
                        </label>
                        <input
                            value={locationName}
                            onChange={e => setLocationName(e.target.value)}
                            placeholder="e.g. Scarborough Marina, QLD"
                            className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-[14px] text-white placeholder-white/20 outline-none focus:border-sky-500/40 transition-colors"
                        />
                        {gpsLat && (
                            <p className="text-[10px] text-white/20 mt-1">
                                📍 {gpsLat.toFixed(4)}, {gpsLon?.toFixed(4)}
                            </p>
                        )}
                    </div>

                    {/* Submit button (mobile) */}
                    <button
                        onClick={handleSubmit}
                        disabled={submitting || !title.trim() || !price || !category || !condition}
                        className={`w-full py-3.5 rounded-2xl font-bold text-[14px] uppercase tracking-wider transition-all active:scale-[0.98] ${submitting || !title.trim() || !price || !category || !condition
                            ? 'bg-white/[0.04] text-white/20 border border-white/[0.06]'
                            : 'bg-gradient-to-r from-sky-500 to-cyan-500 text-white shadow-lg shadow-sky-500/20'}`}
                    >
                        {submitting ? '⏳ Creating Listing...' : '🏪 Post to Marketplace'}
                    </button>

                    {/* Bottom spacing for iOS safe area */}
                    <div className="h-8" />
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
    const [userId, setUserId] = useState<string | null>(null);
    const [checkoutListing, setCheckoutListing] = useState<MarketplaceListing | null>(null);
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
        // Open checkout modal instead of direct DM
        setCheckoutListing(listing);
    };

    const handleCashDeal = async (listing: MarketplaceListing) => {
        // Send auto-DM referencing the listing
        const text = `Hi! I'd like to buy "${listing.title}" (${formatPrice(listing.price, listing.currency)}) with cash. When can we meet?`;
        await ChatService.sendDM(listing.seller_id, text);
        if (onOpenDM) {
            onOpenDM(listing.seller_id, listing.seller_name || 'Seller');
        }
    };

    const handleMarkSold = async (id: string) => {
        const ok = await MarketplaceService.markSold(id);
        if (ok) {
            setListings(prev => prev.map(l => l.id === id ? { ...l, status: 'sold' as const } : l));
        }
    };

    const handleDelete = async (id: string) => {
        const ok = await MarketplaceService.deleteListing(id);
        if (ok) {
            setListings(prev => prev.filter(l => l.id !== id));
        }
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

    return (
        <div className="flex flex-col h-full bg-slate-950">
            {/* ═══════ HEADER ═══════ */}
            <div className="sticky top-0 z-20 bg-slate-950/95 backdrop-blur-xl border-b border-white/[0.06]">
                {/* Nav bar */}
                <div className="flex items-center justify-between px-4 py-3">
                    <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] text-sky-400 font-medium">
                        <svg width="8" height="14" viewBox="0 0 8 14" fill="none"><path d="M7 1L1 7L7 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                        Channels
                    </button>
                    <div className="flex items-center gap-2">
                        <span className="text-lg">🏪</span>
                        <span className="text-[15px] font-bold text-white">Marketplace</span>
                    </div>
                    <button
                        onClick={() => setShowCreate(true)}
                        className="px-3 py-1.5 rounded-xl bg-sky-500/20 border border-sky-500/30 text-[11px] font-bold text-sky-300 uppercase tracking-wider active:scale-95 transition-transform"
                    >
                        + Sell
                    </button>
                </div>

                {/* Category chips */}
                <div className="px-3 pb-2.5 -mt-0.5 overflow-x-auto flex gap-2 scrollbar-hide">
                    <button
                        onClick={() => handleCategoryFilter(null)}
                        className={`whitespace-nowrap px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all shrink-0 ${!activeCategory
                            ? 'bg-white/10 border-white/20 text-white'
                            : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:text-white/60'}`}
                    >
                        All
                    </button>
                    {LISTING_CATEGORIES.map(cat => (
                        <button
                            key={cat}
                            onClick={() => handleCategoryFilter(cat)}
                            className={`whitespace-nowrap px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all shrink-0 ${activeCategory === cat
                                ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                                : 'bg-white/[0.03] border-white/[0.06] text-white/40 hover:text-white/60'}`}
                        >
                            {CATEGORY_ICONS[cat]} {cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* ═══════ FEED ═══════ */}
            <div ref={feedRef} className="flex-1 overflow-y-auto overscroll-contain py-3">
                {loading ? (
                    /* Skeleton loader */
                    <div className="space-y-3 px-3">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="rounded-2xl border border-white/[0.06] bg-white/[0.03] overflow-hidden">
                                <div className="w-full aspect-[16/10] listing-shimmer bg-white/[0.04]" />
                                <div className="p-4 space-y-3">
                                    <div className="h-4 w-3/4 rounded-lg listing-shimmer bg-white/[0.04]" />
                                    <div className="h-3 w-1/3 rounded-lg listing-shimmer bg-white/[0.04]" />
                                    <div className="h-8 w-full rounded-xl listing-shimmer bg-white/[0.04]" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : listings.length === 0 ? (
                    /* Empty state */
                    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
                        <div className="text-5xl mb-4">⚓</div>
                        <h3 className="text-lg font-bold text-white/80 mb-2">No Gear Listed Yet</h3>
                        <p className="text-[13px] text-white/40 mb-6 max-w-xs leading-relaxed">
                            Be the first to list your marine gear. Electronics, sails, rigging — if it floats or helps you float, it belongs here.
                        </p>
                        <button
                            onClick={() => setShowCreate(true)}
                            className="px-6 py-3 rounded-2xl bg-gradient-to-r from-sky-500 to-cyan-500 text-[13px] font-bold text-white uppercase tracking-wider shadow-lg shadow-sky-500/20 active:scale-95 transition-transform"
                        >
                            🏪 List Something for Sale
                        </button>
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
                            isNew={newListingIds.has(listing.id)}
                        />
                    ))
                )}
            </div>

            {/* Floating sell button (visible when scrolled) */}
            {!showCreate && listings.length > 0 && (
                <button
                    onClick={() => setShowCreate(true)}
                    className="fixed bottom-24 right-5 z-30 w-14 h-14 rounded-2xl bg-gradient-to-br from-sky-500 to-cyan-600 shadow-xl shadow-sky-500/30 flex items-center justify-center text-2xl active:scale-90 transition-transform border border-sky-400/30"
                >
                    +
                </button>
            )}

            {/* Create listing modal */}
            <CreateListingModal
                isOpen={showCreate}
                onClose={() => setShowCreate(false)}
                onCreated={handleCreated}
            />

            {/* Checkout modal */}
            <CheckoutModal
                listing={checkoutListing}
                isOpen={!!checkoutListing}
                onClose={() => setCheckoutListing(null)}
                onCashDeal={handleCashDeal}
            />
        </div>
    );
};
