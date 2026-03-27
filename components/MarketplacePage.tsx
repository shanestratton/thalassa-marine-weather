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

import React, { useState, useEffect, useRef } from 'react';
import { toast } from './Toast';
import {
    MarketplaceService,
    MarketplaceListing,
    ListingCategory,
    LISTING_CATEGORIES,
    CATEGORY_ICONS,
} from '../services/MarketplaceService';
import { ChatService } from '../services/ChatService';

import { SlideToAction } from './ui/SlideToAction';
import { UndoToast } from './ui/UndoToast';
import { triggerHaptic } from '../utils/system';
import { formatPrice } from './marketplace/helpers';

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
// SUB-COMPONENTS (extracted to marketplace/)
// ═══════════════════════════════════════════════════════════════
import { ListingCard } from './marketplace/ListingCard';
import { CreateListingModal } from './marketplace/CreateListingModal';

// ═══════════════════════════════════════════════════════════════
// MAIN MARKETPLACE PAGE
// ═══════════════════════════════════════════════════════════════

interface MarketplacePageProps {
    onBack: () => void;
    onOpenDM?: (
        sellerId: string,
        sellerName: string,
        listingContext?: { title: string; price: string; image?: string },
    ) => void;
}

export const MarketplacePage: React.FC<MarketplacePageProps> = React.memo(({ onBack: _onBack, onOpenDM }) => {
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
            setListings((prev) => {
                // Deduplicate or update
                const existing = prev.findIndex((l) => l.id === newListing.id);
                if (existing >= 0) {
                    const next = [...prev];
                    next[existing] = newListing;
                    return next;
                }
                // Only add if it matches the active filter
                if (activeCategory && newListing.category !== activeCategory) return prev;
                // Mark as new for animation
                setNewListingIds((prev) => new Set(prev).add(newListing.id));
                setTimeout(
                    () =>
                        setNewListingIds((prev) => {
                            const next = new Set(prev);
                            next.delete(newListing.id);
                            return next;
                        }),
                    2000,
                );
                return [newListing, ...prev];
            });
        });

        return () => unsub();
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
            setListings((prev) => prev.map((l) => (l.id === id ? { ...l, status: 'sold' as const } : l)));
        }
    };

    // ── Soft-delete with undo ──
    const handleDelete = (id: string) => {
        const listing = listings.find((l) => l.id === id);
        if (!listing) return;
        triggerHaptic('medium');
        // Remove from UI immediately
        setListings((prev) => prev.filter((l) => l.id !== id));
        setDeletedListing(listing);
    };

    // Called by UndoToast after 5s — performs the actual API delete
    const handleDismissDelete = async () => {
        if (!deletedListing) return;
        const listing = deletedListing;
        setDeletedListing(null);
        try {
            await MarketplaceService.deleteListing(listing.id);
        } catch (e) {
            console.warn('Suppressed:', e);
            toast.error('Failed to delete listing');
            setListings((prev) => [listing, ...prev]);
        }
    };

    const handleUndoDelete = () => {
        if (deletedListing) {
            setListings((prev) => [deletedListing, ...prev]);
            toast.success('Listing restored');
        }
        setDeletedListing(null);
    };

    const handleCreated = (listing: MarketplaceListing) => {
        setNewListingIds((prev) => new Set(prev).add(listing.id));
        setListings((prev) => [listing, ...prev]);
        setTimeout(
            () =>
                setNewListingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(listing.id);
                    return next;
                }),
            2000,
        );
    };

    const handleFlagLocation = async (listing: MarketplaceListing) => {
        // DM the seller with a polite heads-up
        const sellerFirst = (listing.seller_name || 'Seller').split(' ')[0];
        await ChatService.sendDM(
            listing.seller_id,
            `Hi ${sellerFirst}, a buyer has flagged that the listed location for "${listing.title}" may not match your actual area. If this is intentional, no worries — just letting you know! 🙏`,
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
                        aria-label="Filter"
                        onClick={() => handleCategoryFilter(null)}
                        className={`whitespace-nowrap px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all shrink-0 ${
                            !activeCategory
                                ? 'bg-white/10 border-white/20 text-white'
                                : 'bg-white/[0.03] border-white/[0.06] text-white/60 hover:text-white/60'
                        }`}
                    >
                        All
                    </button>
                    {LISTING_CATEGORIES.map((cat) => (
                        <button
                            aria-label="Filter"
                            key={cat}
                            onClick={() => handleCategoryFilter(cat)}
                            className={`whitespace-nowrap px-3 py-1.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all shrink-0 ${
                                activeCategory === cat
                                    ? 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                                    : 'bg-white/[0.03] border-white/[0.06] text-white/60 hover:text-white/60'
                            }`}
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
                        {[1, 2, 3].map((i) => (
                            <div
                                key={i}
                                className="rounded-2xl border border-white/[0.06] bg-white/[0.03] overflow-hidden"
                            >
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
                            Be the first to list your marine gear. Electronics, sails, rigging — if it floats or helps
                            you float, it belongs here.
                        </p>
                    </div>
                ) : (
                    /* Listing cards */
                    listings.map((listing) => (
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
            <div
                className="fixed left-0 right-0 px-4 z-20"
                style={{ bottom: 'calc(64px + env(safe-area-inset-bottom) + 8px)' }}
            >
                <SlideToAction
                    label="Slide to List Something for Sale"
                    thumbIcon={
                        <svg
                            className="w-5 h-5 text-white"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                        >
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
            <CreateListingModal isOpen={showCreate} onClose={() => setShowCreate(false)} onCreated={handleCreated} />

            {/* Undo toast for delete */}
            <UndoToast
                isOpen={!!deletedListing}
                message={`"${deletedListing?.title}" deleted`}
                onUndo={handleUndoDelete}
                onDismiss={handleDismissDelete}
            />
        </div>
    );
});
