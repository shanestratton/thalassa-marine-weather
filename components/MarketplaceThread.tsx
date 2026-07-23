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
import { useAuthStore } from '../stores/authStore';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SafeImage } from './ui/SafeImage';

interface MarketplaceThreadProps {
    listing: MarketplaceListing;
    otherPartyId: string;
    onBack: () => void;
}

interface ThreadMessage {
    id: string;
    listing_id: string;
    sender_id: string;
    recipient_id: string;
    content: string;
    created_at: string;
}

const SAFE_POSTGREST_FILTER_TOKEN = /^[A-Za-z0-9_-]+$/;

function identityIsCurrent(scope: AuthIdentityScope, ownerId: string): boolean {
    return (
        isAuthIdentityScopeCurrent(scope) && scope.userId === ownerId && useAuthStore.getState().user?.id === ownerId
    );
}

async function remoteIdentityMatches(scope: AuthIdentityScope, ownerId: string): Promise<boolean> {
    if (!supabase || !identityIsCurrent(scope, ownerId)) return false;
    try {
        const {
            data: { user },
            error,
        } = await supabase.auth.getUser();
        return !error && user?.id === ownerId && identityIsCurrent(scope, ownerId);
    } catch {
        return false;
    }
}

function isExactThreadMessage(
    message: ThreadMessage,
    listingId: string,
    ownerId: string,
    otherPartyId: string,
): boolean {
    if (message.listing_id !== listingId) return false;
    return (
        (message.sender_id === ownerId && message.recipient_id === otherPartyId) ||
        (message.sender_id === otherPartyId && message.recipient_id === ownerId)
    );
}

function mergeThreadMessages(current: ThreadMessage[], incoming: ThreadMessage[]): ThreadMessage[] {
    const byId = new Map(current.map((message) => [message.id, message]));
    for (const message of incoming) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

export const MarketplaceThread: React.FC<MarketplaceThreadProps> = ({ listing, otherPartyId, onBack }) => {
    const authUserId = useAuthStore((state) => state.user?.id ?? null);
    const threadScopeRef = useRef<AuthIdentityScope>(getAuthIdentityScope());
    const threadOwnerId = threadScopeRef.current.userId;
    const [messageState, setMessageState] = useState<{ ownerId: string | null; rows: ThreadMessage[] }>({
        ownerId: threadOwnerId,
        rows: [],
    });
    const [draftState, setDraftState] = useState<{ ownerId: string | null; value: string }>({
        ownerId: threadOwnerId,
        value: '',
    });
    const [loadingState, setLoadingState] = useState<{ ownerId: string | null; loading: boolean }>({
        ownerId: threadOwnerId,
        loading: true,
    });
    const [sendingState, setSendingState] = useState<{ ownerId: string | null; sending: boolean }>({
        ownerId: threadOwnerId,
        sending: false,
    });
    const scrollRef = useRef<HTMLDivElement>(null);
    const scrollTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
    const sendingScopeRef = useRef<AuthIdentityScope | null>(null);

    const threadIsCurrent =
        !!threadOwnerId && authUserId === threadOwnerId && identityIsCurrent(threadScopeRef.current, threadOwnerId);

    const clearScrollTimers = useCallback(() => {
        for (const timer of scrollTimersRef.current) clearTimeout(timer);
        scrollTimersRef.current.clear();
    }, []);

    const scheduleScroll = useCallback(
        (scope: AuthIdentityScope, ownerId: string, delayMs: number, behavior?: ScrollBehavior) => {
            const timer = setTimeout(() => {
                scrollTimersRef.current.delete(timer);
                if (threadScopeRef.current !== scope || !identityIsCurrent(scope, ownerId)) {
                    return;
                }
                scrollRef.current?.scrollTo({
                    top: scrollRef.current.scrollHeight,
                    behavior,
                });
            }, delayMs);
            scrollTimersRef.current.add(timer);
        },
        [],
    );

    useEffect(() => {
        const unsubscribeIdentity = subscribeAuthIdentityScope(() => {
            clearScrollTimers();
            sendingScopeRef.current = null;
            setMessageState({ ownerId: null, rows: [] });
            setDraftState({ ownerId: null, value: '' });
            setLoadingState({ ownerId: null, loading: false });
            setSendingState({ ownerId: null, sending: false });
        });
        return () => {
            unsubscribeIdentity();
            clearScrollTimers();
        };
    }, [clearScrollTimers]);

    // ── Load user + messages ──
    useEffect(() => {
        const client = supabase;
        const scope = threadScopeRef.current;
        const ownerId = scope.userId;
        const listingId = listing.id;
        const counterpartyId = otherPartyId;
        let active = true;
        let channel: RealtimeChannel | null = null;

        const operationIsCurrent = () =>
            active && threadScopeRef.current === scope && !!ownerId && identityIsCurrent(scope, ownerId);

        clearScrollTimers();
        setMessageState({ ownerId, rows: [] });
        setDraftState({ ownerId, value: '' });
        setSendingState({ ownerId, sending: false });
        setLoadingState({ ownerId, loading: !!ownerId });

        if (
            !client ||
            !ownerId ||
            !SAFE_POSTGREST_FILTER_TOKEN.test(ownerId) ||
            !SAFE_POSTGREST_FILTER_TOKEN.test(counterpartyId) ||
            !SAFE_POSTGREST_FILTER_TOKEN.test(listingId) ||
            counterpartyId === ownerId ||
            !operationIsCurrent()
        ) {
            setLoadingState({ ownerId, loading: false });
            return () => {
                active = false;
            };
        }

        void (async () => {
            if (!(await remoteIdentityMatches(scope, ownerId)) || !operationIsCurrent()) {
                if (operationIsCurrent()) setLoadingState({ ownerId, loading: false });
                return;
            }

            // Subscribe before the initial read, then merge/dedupe the read so
            // a message arriving in the subscribe/query gap cannot disappear.
            channel = client
                .channel(`mp_thread_${scope.generation}_${listingId}_${ownerId}_${counterpartyId}`)
                .on(
                    'postgres_changes',
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'marketplace_messages',
                        filter: `listing_id=eq.${listingId}`,
                    },
                    (payload: { new: ThreadMessage }) => {
                        const message = payload.new;
                        if (
                            !operationIsCurrent() ||
                            !isExactThreadMessage(message, listingId, ownerId, counterpartyId)
                        ) {
                            return;
                        }
                        setMessageState((current) => ({
                            ownerId,
                            rows:
                                current.ownerId === ownerId ? mergeThreadMessages(current.rows, [message]) : [message],
                        }));
                        scheduleScroll(scope, ownerId, 50, 'smooth');
                    },
                )
                .subscribe();

            const { data, error } = await client
                .from('marketplace_messages')
                .select('*')
                .eq('listing_id', listingId)
                .or(
                    `and(sender_id.eq.${ownerId},recipient_id.eq.${counterpartyId}),and(sender_id.eq.${counterpartyId},recipient_id.eq.${ownerId})`,
                )
                .order('created_at', { ascending: true });

            if (!operationIsCurrent()) return;
            const rows = error
                ? []
                : ((data || []) as ThreadMessage[]).filter((message) =>
                      isExactThreadMessage(message, listingId, ownerId, counterpartyId),
                  );
            setMessageState((current) => ({
                ownerId,
                rows: current.ownerId === ownerId ? mergeThreadMessages(current.rows, rows) : rows,
            }));
            setLoadingState({ ownerId, loading: false });
            scheduleScroll(scope, ownerId, 100);
        })().catch((error) => {
            if (!operationIsCurrent()) return;
            log.error('Failed to load marketplace thread:', error);
            setLoadingState({ ownerId, loading: false });
        });

        return () => {
            active = false;
            clearScrollTimers();
            if (channel) void client.removeChannel(channel);
        };
    }, [authUserId, clearScrollTimers, listing.id, otherPartyId, scheduleScroll]);

    // ── Send message ──
    const sendMessage = useCallback(async () => {
        const client = supabase;
        const scope = threadScopeRef.current;
        const ownerId = scope.userId;
        const content = draftState.ownerId === ownerId ? draftState.value.trim() : '';
        if (
            !content ||
            !client ||
            !ownerId ||
            !otherPartyId ||
            !SAFE_POSTGREST_FILTER_TOKEN.test(ownerId) ||
            !SAFE_POSTGREST_FILTER_TOKEN.test(otherPartyId) ||
            !SAFE_POSTGREST_FILTER_TOKEN.test(listing.id) ||
            otherPartyId === ownerId ||
            sendingScopeRef.current === scope ||
            !identityIsCurrent(scope, ownerId)
        ) {
            return;
        }
        sendingScopeRef.current = scope;
        setSendingState({ ownerId, sending: true });

        try {
            if (!(await remoteIdentityMatches(scope, ownerId)) || !identityIsCurrent(scope, ownerId)) return;

            const { error } = await client.from('marketplace_messages').insert({
                listing_id: listing.id,
                sender_id: ownerId,
                recipient_id: otherPartyId,
                content,
            });

            if (!identityIsCurrent(scope, ownerId)) return;
            if (error) {
                log.error('Failed to send:', error);
                toast.error('Failed to send message');
                return;
            }
            setDraftState((current) => ({
                ownerId,
                value: current.ownerId === ownerId && current.value.trim() === content ? '' : current.value,
            }));
        } catch (e) {
            if (identityIsCurrent(scope, ownerId)) {
                log.error('Failed to send:', e);
                toast.error('Failed to send message');
            }
        } finally {
            if (sendingScopeRef.current === scope) sendingScopeRef.current = null;
            if (identityIsCurrent(scope, ownerId)) {
                setSendingState({ ownerId, sending: false });
            }
        }
    }, [draftState, listing.id, otherPartyId]);

    const messages = threadIsCurrent && messageState.ownerId === threadOwnerId ? messageState.rows : [];
    const input = threadIsCurrent && draftState.ownerId === threadOwnerId ? draftState.value : '';
    const loading = threadIsCurrent && loadingState.ownerId === threadOwnerId && loadingState.loading;
    const sending = threadIsCurrent && sendingState.ownerId === threadOwnerId && sendingState.sending;

    if (!threadIsCurrent) {
        return <div className="h-full w-full bg-slate-900" aria-label="Marketplace conversation closed" />;
    }

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
                        <SafeImage
                            src={listing.images[0]}
                            loading="lazy"
                            alt=""
                            className="w-full h-full object-cover"
                        />
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
                        const isOwn = msg.sender_id === threadOwnerId;

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
                    onChange={(e) => {
                        if (threadIsCurrent && threadOwnerId) {
                            setDraftState({ ownerId: threadOwnerId, value: e.target.value });
                        }
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void sendMessage();
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
