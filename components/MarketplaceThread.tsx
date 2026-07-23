/**
 * MarketplaceThread — Transaction negotiation room.
 *
 * Dedicated negotiation room with:
 *   1. Sticky item header (thumbnail, title, price)
 *   2. Message thread with buyer/seller distinction
 *
 * Payment state deliberately does not live in chat messages. The former
 * client-only "escrow" controls generated a local PIN without charging a
 * card and could display a false funds-held state. Checkout remains launch-
 * gated until the native Stripe confirmation sheet is wired end to end.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createLogger } from '../utils/createLogger';

const log = createLogger('MarketplaceThread');
import { type MarketplaceListing, CATEGORY_ICONS } from '../services/MarketplaceService';
import { supabase } from '../services/supabase';
import { toast } from './Toast';

interface MarketplaceThreadProps {
    listing: MarketplaceListing;
    otherPartyId: string;
    onBack: () => void;
}

interface ThreadMessage {
    id: string;
    sender_id: string;
    content: string;
    created_at: string;
}

export const MarketplaceThread: React.FC<MarketplaceThreadProps> = ({ listing, otherPartyId, onBack }) => {
    const [messages, setMessages] = useState<ThreadMessage[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(true);
    const [userId, setUserId] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    const scrollRef = useRef<HTMLDivElement>(null);

    // ── Load user + messages ──
    useEffect(() => {
        if (!supabase) return;

        (async () => {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (user) setUserId(user.id);

            // Load messages
            const { data } = await supabase
                .from('marketplace_messages')
                .select('*')
                .eq('listing_id', listing.id)
                .order('created_at', { ascending: true });

            if (data) setMessages(data as ThreadMessage[]);
            setLoading(false);

            // Scroll to bottom
            setTimeout(() => {
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
            }, 100);
        })();

        // Realtime subscription for new messages
        const channel = supabase
            .channel(`mp_thread_${listing.id}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'marketplace_messages',
                    filter: `listing_id=eq.${listing.id}`,
                },
                (payload: { new: ThreadMessage }) => {
                    setMessages((prev) => [...prev, payload.new]);
                    setTimeout(() => {
                        scrollRef.current?.scrollTo({ top: scrollRef.current?.scrollHeight, behavior: 'smooth' });
                    }, 50);
                },
            )
            .subscribe();

        return () => {
            supabase?.removeChannel(channel);
        };
    }, [listing.id, listing.seller_id]);

    // ── Send message ──
    const sendMessage = useCallback(async () => {
        if (!input.trim() || !supabase || !userId || sending) return;
        setSending(true);

        try {
            await supabase.from('marketplace_messages').insert({
                listing_id: listing.id,
                sender_id: userId,
                recipient_id: otherPartyId,
                content: input.trim(),
            });
            setInput('');
        } catch (e) {
            log.error('Failed to send:', e);
            toast.error('Failed to send message');
        } finally {
            setSending(false);
        }
    }, [input, listing.id, userId, otherPartyId, sending]);

    // ── Render ──
    return (
        <div className="flex flex-col h-full w-full bg-slate-900">
            {/* ═══ NAV BAR ═══ */}
            <div className="px-4 pt-4 pb-2 flex items-center gap-3 shrink-0">
                <button
                    onClick={onBack}
                    aria-label="Go back"
                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
                >
                    <svg
                        className="w-5 h-5 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h2 className="text-sm font-black text-white truncate">{listing.seller_name || 'Seller'}</h2>
                    <p className="text-[11px] text-gray-400 font-bold">Transaction Room</p>
                </div>
            </div>

            {/* ═══ STICKY ITEM HEADER ═══ */}
            <div className="mx-4 mb-2 p-3 rounded-2xl bg-gradient-to-r from-white/[0.06] to-white/[0.03] border border-white/[0.08] flex items-center gap-3 shrink-0">
                {/* Thumbnail */}
                <div className="w-16 h-16 rounded-xl bg-white/[0.06] shrink-0 overflow-hidden">
                    {listing.images?.[0] ? (
                        <img src={listing.images[0]} loading="lazy" alt="" className="w-full h-full object-cover" />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-3xl">
                            {CATEGORY_ICONS[listing.category] || '📦'}
                        </div>
                    )}
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-black text-white truncate">{listing.title}</h3>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="px-2 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-400 text-xs font-black">
                            ${listing.price}
                        </span>
                        <span className="text-[11px] text-gray-400 font-bold uppercase tracking-wider">
                            {listing.condition}
                        </span>
                    </div>
                </div>

                {/* Category icon */}
                <div className="p-2.5 bg-white/[0.04] rounded-xl shrink-0">
                    <span className="text-2xl">{CATEGORY_ICONS[listing.category] || '📦'}</span>
                </div>
            </div>

            {/* ═══ MESSAGE THREAD ═══ */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
                {loading ? (
                    <div className="flex items-center justify-center py-16">
                        <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : messages.length === 0 ? (
                    <div className="text-center py-16">
                        <p className="text-gray-400 text-xs">Start the negotiation...</p>
                    </div>
                ) : (
                    messages.map((msg) => {
                        const isOwn = msg.sender_id === userId;

                        return (
                            <div key={msg.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                                <div
                                    className={`max-w-[80%] px-4 py-2.5 rounded-2xl ${
                                        isOwn
                                            ? 'bg-sky-600/30 border border-sky-500/20 rounded-br-md'
                                            : 'bg-white/[0.06] border border-white/[0.06] rounded-bl-md'
                                    }`}
                                >
                                    <p className="text-sm text-white leading-relaxed">{msg.content}</p>
                                    <p className="text-[11px] text-gray-400 text-right mt-1">
                                        {new Date(msg.created_at).toLocaleTimeString([], {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
                                    </p>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* ═══ COMPOSE BAR ═══ */}
            <div className="px-4 pb-4 pt-2 flex items-center gap-2 shrink-0 border-t border-white/[0.06]">
                {/* Text input */}
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') sendMessage();
                    }}
                    placeholder="Type a message..."
                    className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-sky-500/30"
                />

                {/* Send button */}
                <button
                    aria-label="Send message"
                    onClick={sendMessage}
                    disabled={!input.trim() || sending}
                    className="p-2.5 bg-sky-600/30 rounded-xl hover:bg-sky-600/50 transition-colors disabled:opacity-30 active:scale-95"
                >
                    <svg
                        className="w-5 h-5 text-sky-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
                        />
                    </svg>
                </button>
            </div>
        </div>
    );
};
