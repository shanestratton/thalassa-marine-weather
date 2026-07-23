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
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../services/authIdentityScope';

import { SlideToAction } from './ui/SlideToAction';
import { UndoToast } from './ui/UndoToast';
import { EmptyState } from './ui/EmptyState';
import { ShimmerBlock } from './ui/ShimmerBlock';
import { triggerHaptic } from '../utils/system';
import { formatPrice } from './marketplace/helpers';
import { AnchorIcon } from './Icons';

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
    // Search query — client-side filter on title + description + seller +
    // make/model. Added 2026-05-17 because the feed could return dozens of
    // category-matched listings with no way to drill further.
    const [searchQuery, setSearchQuery] = useState('');
    const feedRef = useRef<HTMLDivElement>(null);

    // Filter listings by search query. Matches against title, description,
    // seller name, vessel name, and boat make/model — anything a user
    // would naturally type ("Hood mainsail", "Bavaria 38", "Sarah").
    // Case-insensitive, trims whitespace. Empty query returns all.
    const filteredListings = React.useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return listings;
        return listings.filter((l) => {
            const haystack = [
                l.title,
                l.description,
                l.seller_name,
                l.seller_vessel,
                l.boat_details?.make,
                l.boat_details?.model,
                l.location_name,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(q);
        });
    }, [listings, searchQuery]);

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

    const handleMessageSeller = async (listing: MarketplaceListing, message?: string): Promise<boolean> => {
        const scope = getAuthIdentityScope();
        const sellerFirst = (listing.seller_name || 'Seller').split(' ')[0];
        // A button labelled "Message" opens the conversation; it must not send
        // an unsolicited template on the buyer's behalf. Explicit offer text is
        // sent once before opening the same thread.
        if (message) {
            const result = await ChatService.sendDM(listing.seller_id, message).catch(() => null);
            if (!isAuthIdentityScopeCurrent(scope)) return false;
            if (result === 'blocked') {
                toast.error('This seller cannot receive your direct messages.');
                return false;
            }
            if (!result) {
                toast.error("Your offer wasn't sent. Please check your connection and try again.");
                return false;
            }
            if (result === 'queued') {
                toast.info('Offer queued — it will send when the connection returns.');
            }
        }
        if (!isAuthIdentityScopeCurrent(scope)) return false;
        if (onOpenDM) {
            onOpenDM(listing.seller_id, sellerFirst, {
                title: listing.title,
                price: formatPrice(listing.price, listing.currency),
                image: listing.images[0],
            });
        }
        return true;
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
        const scope = getAuthIdentityScope();
        const sellerFirst = (listing.seller_name || 'Seller').split(' ')[0];
        const result = await ChatService.sendDM(
            listing.seller_id,
            `Hi ${sellerFirst}, a buyer has flagged that the listed location for "${listing.title}" may not match your actual area. If this is intentional, no worries — just letting you know! 🙏`,
        ).catch(() => null);
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (result === 'blocked') {
            toast.error('This seller cannot receive your direct messages.');
        } else if (result === 'queued') {
            toast.info('Location flag queued — the seller will be notified when you reconnect.');
        } else if (result) {
            toast.success('Location flagged — seller has been notified');
        } else {
            toast.error("The seller couldn't be notified. Please try again.");
        }
    };

    return (
        <div className="flex flex-col bg-slate-950">
            {/* ═══════ HEADER ═══════ */}
            <div className="sticky top-0 z-20 bg-slate-950/95 border-b border-white/[0.06]">
                {/* Search — added 2026-05-17. Sits above the category chips
                    so it's the first interaction the user sees. Filters
                    title + description + seller name + vessel name + make/
                    model + location, all client-side over whatever the
                    current category-filter returned. */}
                <div className="px-3 pt-2.5">
                    <div className="relative">
                        <svg
                            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M21 21l-4.34-4.34m0 0A8 8 0 103.32 12.32a8 8 0 0013.34 4.34z"
                            />
                        </svg>
                        <input
                            type="search"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search gear, boats, sellers…"
                            className="w-full h-10 pl-9 pr-9 rounded-xl bg-white/[0.04] border border-white/10 text-[13px] text-white placeholder-slate-500 focus:outline-none focus:border-sky-500/40 focus:bg-white/[0.06] transition-colors"
                            aria-label="Search marketplace listings"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                aria-label="Clear search"
                                className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white/10 hover:bg-white/15 flex items-center justify-center text-slate-300"
                            >
                                <svg
                                    className="w-3.5 h-3.5"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2.5}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        )}
                    </div>
                </div>
                {/* Category chips */}
                <div className="px-3 pt-2 pb-2.5 flex flex-wrap gap-2">
                    <button
                        aria-label="Filter results"
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
                            aria-label="Filter results"
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
                    <div className="space-y-3 px-3">
                        <ShimmerBlock variant="card" />
                        <ShimmerBlock variant="card" />
                        <ShimmerBlock variant="card" />
                    </div>
                ) : listings.length === 0 ? (
                    // Truly empty — no listings at all from the API. The
                    // first-time "be the first to list" experience.
                    <EmptyState
                        icon={<AnchorIcon className="w-10 h-10 text-sky-400/60" />}
                        title="No Gear Listed Yet"
                        description="Be the first to list your marine gear. Electronics, sails, rigging — if it floats or helps you float, it belongs here."
                    />
                ) : filteredListings.length === 0 ? (
                    // Listings exist but the user's search/category filter
                    // hides them all. Different copy + "Clear filters" CTA
                    // so they don't think the marketplace is dead. Added
                    // 2026-05-17 alongside search.
                    <EmptyState
                        icon={
                            <svg
                                className="w-10 h-10 text-slate-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M21 21l-4.34-4.34m0 0A8 8 0 103.32 12.32a8 8 0 0013.34 4.34z"
                                />
                            </svg>
                        }
                        title={
                            searchQuery
                                ? `No results for "${searchQuery}"`
                                : `Nothing in ${activeCategory ?? 'this category'}`
                        }
                        description={
                            searchQuery
                                ? `Try a different search, or browse without filters.`
                                : `No listings in this category right now. Try ALL or another category.`
                        }
                        actionLabel="Clear filters"
                        onAction={() => {
                            setSearchQuery('');
                            setActiveCategory(null);
                            loadListings(null);
                        }}
                    />
                ) : (
                    /* Listing cards */
                    filteredListings.map((listing) => (
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
