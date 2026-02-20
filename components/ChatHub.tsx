/**
 * ChatHub — Split Inbox with Community / Marketplace toggle.
 *
 * Wraps existing ChatPage (community) and a new MarketplaceInbox.
 * Segmented control at the top toggles between the two views.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { ChatPage } from './ChatPage';
import { MarketplaceThread } from './MarketplaceThread';
import { MarketplaceService, type MarketplaceListing, CATEGORY_ICONS } from '../services/MarketplaceService';
import { supabase } from '../services/supabase';
import { triggerHaptic } from '../utils/system';

// ── Types ──────────────────────────────────────────────────────

type InboxTab = 'community' | 'marketplace';

interface MarketplaceConversation {
    listing: MarketplaceListing;
    lastMessage: string | null;
    lastMessageAt: string | null;
    unread: number;
    otherPartyName: string;
    otherPartyId: string;
}

// ── Component ──────────────────────────────────────────────────

export const ChatHub: React.FC = () => {
    const [activeTab, setActiveTab] = useState<InboxTab>('community');
    const [conversations, setConversations] = useState<MarketplaceConversation[]>([]);
    const [loading, setLoading] = useState(false);
    const [openThread, setOpenThread] = useState<{ listing: MarketplaceListing; otherPartyId: string } | null>(null);
    const [unreadMarketplace, setUnreadMarketplace] = useState(0);

    // ── Load marketplace conversations ──
    const loadConversations = useCallback(async () => {
        if (!supabase) return;
        setLoading(true);
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            // Get all marketplace messages grouped by listing
            const { data: threads, error } = await supabase
                .from('marketplace_messages')
                .select('listing_id, sender_id, recipient_id, content, created_at')
                .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
                .order('created_at', { ascending: false });

            if (error || !threads) {
                setConversations([]);
                return;
            }

            // Group by listing_id, keep latest message per listing
            const grouped = new Map<string, typeof threads[0]>();
            for (const msg of threads) {
                if (!grouped.has(msg.listing_id)) {
                    grouped.set(msg.listing_id, msg);
                }
            }

            // Fetch listing details for each conversation
            const convos: MarketplaceConversation[] = [];
            for (const [listingId, lastMsg] of grouped) {
                try {
                    const listing = await MarketplaceService.getListing(listingId);
                    if (!listing) continue;

                    const otherPartyId = lastMsg.sender_id === user.id
                        ? lastMsg.recipient_id
                        : lastMsg.sender_id;

                    convos.push({
                        listing,
                        lastMessage: lastMsg.content,
                        lastMessageAt: lastMsg.created_at,
                        unread: 0, // Simplified — would need read receipts for accurate count
                        otherPartyName: listing.seller_id === user.id
                            ? 'Buyer'
                            : listing.seller_name || 'Seller',
                        otherPartyId,
                    });
                } catch {
                    // Skip failed listing lookups
                }
            }

            setConversations(convos);
            setUnreadMarketplace(convos.filter(c => c.unread > 0).length);
        } catch (e) {
            console.error('Failed to load marketplace conversations:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (activeTab === 'marketplace') {
            loadConversations();
        }
    }, [activeTab, loadConversations]);

    // ── If a marketplace thread is open, show it fullscreen ──
    if (openThread) {
        return (
            <MarketplaceThread
                listing={openThread.listing}
                otherPartyId={openThread.otherPartyId}
                onBack={() => {
                    setOpenThread(null);
                    loadConversations(); // Refresh on return
                }}
            />
        );
    }

    return (
        <div className="flex flex-col h-full w-full">

            {/* ═══ SEGMENTED CONTROL ═══ */}
            <div className="px-4 pt-4 pb-2 shrink-0">
                <div className="bg-white/[0.06] rounded-2xl p-1 flex relative overflow-hidden border border-white/[0.08]">
                    {/* Sliding indicator */}
                    <div
                        className="absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-xl bg-white/[0.12] backdrop-blur-sm transition-transform duration-300 ease-out border border-white/[0.08]"
                        style={{
                            transform: activeTab === 'community' ? 'translateX(4px)' : 'translateX(calc(100% + 4px))',
                        }}
                    />

                    {/* Community tab */}
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            setActiveTab('community');
                        }}
                        className={`relative z-10 flex-1 py-2.5 flex items-center justify-center gap-2 rounded-xl transition-colors duration-200 ${activeTab === 'community' ? 'text-white' : 'text-gray-500'
                            }`}
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 1.136.845 2.1 1.976 2.193 1.708.143 3.443.218 5.201.222l3.799 3.072V18a.75.75 0 01.75-.748 48.484 48.484 0 005.232-.307c1.136-.094 1.98-1.057 1.98-2.193v-4.286c0-1.136-.844-2.1-1.976-2.192a48.616 48.616 0 00-8.048 0z" />
                        </svg>
                        <span className="text-xs font-black uppercase tracking-widest">Community</span>
                    </button>

                    {/* Marketplace tab */}
                    <button
                        onClick={() => {
                            triggerHaptic('light');
                            setActiveTab('marketplace');
                        }}
                        className={`relative z-10 flex-1 py-2.5 flex items-center justify-center gap-2 rounded-xl transition-colors duration-200 ${activeTab === 'marketplace' ? 'text-white' : 'text-gray-500'
                            }`}
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
                        </svg>
                        <span className="text-xs font-black uppercase tracking-widest">Marketplace</span>
                        {unreadMarketplace > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 px-1.5 py-0.5 rounded-full bg-red-500 text-[8px] font-black text-white min-w-[16px] text-center">
                                {unreadMarketplace}
                            </span>
                        )}
                    </button>
                </div>
            </div>

            {/* ═══ CONTENT ═══ */}
            <div className="flex-1 overflow-hidden">
                {activeTab === 'community' ? (
                    <ChatPage />
                ) : (
                    <div className="h-full overflow-y-auto">
                        {/* Marketplace conversation list */}
                        {loading ? (
                            <div className="flex items-center justify-center py-16">
                                <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                            </div>
                        ) : conversations.length === 0 ? (
                            <div className="text-center py-16 px-6">
                                <div className="p-4 bg-white/[0.04] rounded-2xl inline-block mb-4">
                                    <svg className="w-10 h-10 text-gray-600 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242" />
                                    </svg>
                                </div>
                                <p className="text-gray-500 text-sm font-bold">No active negotiations</p>
                                <p className="text-gray-600 text-xs mt-1">
                                    Message a seller from the Gear Exchange to start
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-1 p-4">
                                {conversations.map(convo => (
                                    <button
                                        key={convo.listing.id}
                                        onClick={() => {
                                            triggerHaptic('light');
                                            setOpenThread({
                                                listing: convo.listing,
                                                otherPartyId: convo.otherPartyId,
                                            });
                                        }}
                                        className="w-full flex items-center gap-3 p-3.5 rounded-2xl bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all active:scale-[0.98]"
                                    >
                                        {/* Item thumbnail */}
                                        <div className="w-14 h-14 rounded-xl bg-white/[0.06] shrink-0 overflow-hidden">
                                            {convo.listing.images?.[0] ? (
                                                <img
                                                    src={convo.listing.images[0]}
                                                    alt=""
                                                    className="w-full h-full object-cover"
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-2xl">
                                                    {CATEGORY_ICONS[convo.listing.category] || '📦'}
                                                </div>
                                            )}
                                        </div>

                                        {/* Info */}
                                        <div className="flex-1 text-left min-w-0">
                                            <div className="flex items-center gap-2 mb-0.5">
                                                <h4 className="text-sm font-black text-white truncate">{convo.listing.title}</h4>
                                                <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-400 text-[9px] font-black">
                                                    ${convo.listing.price}
                                                </span>
                                            </div>
                                            <p className="text-[10px] text-gray-500 truncate">
                                                {convo.otherPartyName}
                                                {convo.lastMessage ? ` · ${convo.lastMessage}` : ''}
                                            </p>
                                        </div>

                                        {/* Time + unread */}
                                        <div className="shrink-0 text-right">
                                            {convo.lastMessageAt && (
                                                <p className="text-[9px] text-gray-600 font-bold">
                                                    {timeAgo(convo.lastMessageAt)}
                                                </p>
                                            )}
                                            {convo.unread > 0 && (
                                                <span className="inline-block mt-1 px-1.5 py-0.5 rounded-full bg-sky-500 text-[8px] font-black text-white">
                                                    {convo.unread}
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// ── Helpers ─────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
}
