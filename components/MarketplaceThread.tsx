/**
 * MarketplaceThread — Transaction negotiation room.
 *
 * Not a standard chat — a dedicated negotiation room with:
 *   1. Sticky item header (thumbnail, title, price)
 *   2. Message thread with buyer/seller distinction
 *   3. Escrow PIN system (Secure Funds / Enter PIN)
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { type MarketplaceListing, CATEGORY_ICONS } from '../services/MarketplaceService';
import { supabase } from '../services/supabase';
import { triggerHaptic } from '../utils/system';

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
    is_system?: boolean;        // System messages (escrow events)
    escrow_type?: 'funds_held' | 'pin_reveal' | 'pin_verified' | 'released';
    pin_code?: string;          // 4-digit PIN (visible only to buyer)
}

// ── Escrow states ──
type EscrowState = 'none' | 'holding' | 'released';

export const MarketplaceThread: React.FC<MarketplaceThreadProps> = ({
    listing,
    otherPartyId,
    onBack,
}) => {
    const [messages, setMessages] = useState<ThreadMessage[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(true);
    const [userId, setUserId] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    // Escrow
    const [escrowState, setEscrowState] = useState<EscrowState>('none');
    const [buyerPin, setBuyerPin] = useState<string | null>(null);
    const [pinInput, setPinInput] = useState('');
    const [showPinPad, setShowPinPad] = useState(false);
    const [pinError, setPinError] = useState(false);
    const [securingFunds, setSecuringFunds] = useState(false);

    const scrollRef = useRef<HTMLDivElement>(null);
    const isBuyer = userId !== listing.seller_id;

    // ── Load user + messages ──
    useEffect(() => {
        if (!supabase) return;

        (async () => {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) setUserId(user.id);

            // Load messages
            const { data } = await supabase
                .from('marketplace_messages')
                .select('*')
                .eq('listing_id', listing.id)
                .order('created_at', { ascending: true });

            if (data) {
                setMessages(data as ThreadMessage[]);

                // Check for existing escrow state from system messages
                const escrowMsgs = data.filter((m: ThreadMessage) => m.escrow_type);
                if (escrowMsgs.some((m: ThreadMessage) => m.escrow_type === 'released')) {
                    setEscrowState('released');
                } else if (escrowMsgs.some((m: ThreadMessage) => m.escrow_type === 'funds_held')) {
                    setEscrowState('holding');
                    // Find buyer's PIN
                    const pinMsg = escrowMsgs.find((m: ThreadMessage) => m.escrow_type === 'pin_reveal');
                    if (pinMsg?.pin_code) setBuyerPin(pinMsg.pin_code);
                }
            }
            setLoading(false);

            // Scroll to bottom
            setTimeout(() => {
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
            }, 100);
        })();

        // Realtime subscription for new messages
        const channel = supabase
            .channel(`mp_thread_${listing.id}`)
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'marketplace_messages',
                filter: `listing_id=eq.${listing.id}`,
            }, (payload: { new: ThreadMessage }) => {
                setMessages(prev => [...prev, payload.new]);
                setTimeout(() => {
                    scrollRef.current?.scrollTo({ top: scrollRef.current?.scrollHeight, behavior: 'smooth' });
                }, 50);
            })
            .subscribe();

        return () => { supabase?.removeChannel(channel); };
    }, [listing.id, listing.seller_id]);

    // ── Send message ──
    const sendMessage = useCallback(async () => {
        if (!input.trim() || !supabase || !userId || sending) return;
        setSending(true);

        try {
            await supabase
                .from('marketplace_messages')
                .insert({
                    listing_id: listing.id,
                    sender_id: userId,
                    recipient_id: otherPartyId,
                    content: input.trim(),
                });
            setInput('');
        } catch (e) {
            console.error('Failed to send:', e);
        } finally {
            setSending(false);
        }
    }, [input, listing.id, userId, otherPartyId, sending]);

    // ── Secure Funds (Buyer) ──
    const handleSecureFunds = useCallback(async () => {
        if (!supabase || !userId) return;
        setSecuringFunds(true);

        try {
            triggerHaptic('heavy');

            // Generate 4-digit PIN
            const pin = String(Math.floor(1000 + Math.random() * 9000));
            setBuyerPin(pin);
            setEscrowState('holding');

            // Insert system message: funds held
            await supabase.from('marketplace_messages').insert({
                listing_id: listing.id,
                sender_id: userId,
                recipient_id: otherPartyId,
                content: `💰 Funds secured — $${listing.price} held in escrow`,
                is_system: true,
                escrow_type: 'funds_held',
            });

            // Insert PIN reveal (buyer-visible only — in production, this
            // would be filtered server-side)
            await supabase.from('marketplace_messages').insert({
                listing_id: listing.id,
                sender_id: userId,
                recipient_id: otherPartyId,
                content: `🔐 Your handoff PIN is ready`,
                is_system: true,
                escrow_type: 'pin_reveal',
                pin_code: pin,
            });
        } catch (e) {
            console.error('Failed to secure funds:', e);
        } finally {
            setSecuringFunds(false);
        }
    }, [listing.id, listing.price, userId, otherPartyId]);

    // ── Verify PIN (Seller) ──
    const handleVerifyPin = useCallback(async () => {
        if (!supabase || !userId) return;

        if (pinInput === buyerPin) {
            triggerHaptic('heavy');
            setEscrowState('released');
            setPinError(false);
            setShowPinPad(false);

            // Insert release message
            await supabase.from('marketplace_messages').insert({
                listing_id: listing.id,
                sender_id: userId,
                recipient_id: otherPartyId,
                content: `✅ PIN verified — $${listing.price} released to seller`,
                is_system: true,
                escrow_type: 'released',
            });
        } else {
            triggerHaptic('heavy');
            setPinError(true);
            setPinInput('');
            setTimeout(() => setPinError(false), 2000);
        }
    }, [pinInput, buyerPin, listing.id, listing.price, userId, otherPartyId]);

    // ── Render ──
    return (
        <div className="flex flex-col h-full w-full bg-slate-900">

            {/* ═══ NAV BAR ═══ */}
            <div className="px-4 pt-4 pb-2 flex items-center gap-3 shrink-0">
                <button onClick={onBack} className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
                <div className="flex-1">
                    <h2 className="text-sm font-black text-white truncate">{listing.seller_name || 'Seller'}</h2>
                    <p className="text-[10px] text-gray-500 font-bold">Transaction Room</p>
                </div>
                {/* Escrow status badge */}
                {escrowState === 'holding' && (
                    <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-400 text-[9px] font-black border border-amber-500/20 animate-pulse">
                        💰 FUNDS HELD
                    </span>
                )}
                {escrowState === 'released' && (
                    <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-black border border-emerald-500/20">
                        ✅ RELEASED
                    </span>
                )}
            </div>

            {/* ═══ STICKY ITEM HEADER ═══ */}
            <div className="mx-4 mb-2 p-3 rounded-2xl bg-gradient-to-r from-white/[0.06] to-white/[0.03] border border-white/[0.08] flex items-center gap-3 shrink-0">
                {/* Thumbnail */}
                <div className="w-16 h-16 rounded-xl bg-white/[0.06] shrink-0 overflow-hidden">
                    {listing.images?.[0] ? (
                        <img src={listing.images[0]} alt="" className="w-full h-full object-cover" />
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
                        <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider">
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
                        <p className="text-gray-600 text-xs">Start the negotiation...</p>
                    </div>
                ) : (
                    messages.map(msg => {
                        const isOwn = msg.sender_id === userId;

                        // ── SYSTEM MESSAGE (Escrow events) ──
                        if (msg.is_system || msg.escrow_type) {
                            return (
                                <div key={msg.id} className="flex justify-center my-3">
                                    {msg.escrow_type === 'pin_reveal' && isOwn ? (
                                        // ── BUYER'S PIN BUBBLE ──
                                        <div className="w-full max-w-xs bg-gradient-to-br from-sky-500/20 to-cyan-500/20 border-2 border-sky-500/30 rounded-3xl p-5 text-center">
                                            <p className="text-[10px] text-sky-400/70 font-bold uppercase tracking-widest mb-2">Your Handoff PIN</p>
                                            <div className="flex items-center justify-center gap-3">
                                                {(msg.pin_code || buyerPin || '????').split('').map((digit, i) => (
                                                    <div key={i} className="w-12 h-14 rounded-xl bg-sky-500/20 border border-sky-400/30 flex items-center justify-center">
                                                        <span className="text-2xl font-black text-white">{digit}</span>
                                                    </div>
                                                ))}
                                            </div>
                                            <p className="text-[9px] text-gray-500 mt-3">
                                                Share this PIN with the seller at handoff
                                            </p>
                                        </div>
                                    ) : msg.escrow_type === 'pin_reveal' && !isOwn ? (
                                        // Seller sees "funds held" message only
                                        null
                                    ) : (
                                        // ── GENERIC SYSTEM BUBBLE ──
                                        <div className={`px-4 py-2 rounded-2xl text-center max-w-xs ${msg.escrow_type === 'released'
                                                ? 'bg-emerald-500/15 border border-emerald-500/20'
                                                : msg.escrow_type === 'funds_held'
                                                    ? 'bg-amber-500/15 border border-amber-500/20'
                                                    : 'bg-white/[0.04] border border-white/[0.06]'
                                            }`}>
                                            <p className={`text-xs font-bold ${msg.escrow_type === 'released' ? 'text-emerald-400'
                                                    : msg.escrow_type === 'funds_held' ? 'text-amber-400'
                                                        : 'text-gray-500'
                                                }`}>
                                                {msg.content}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            );
                        }

                        // ── REGULAR MESSAGE ──
                        return (
                            <div key={msg.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl ${isOwn
                                        ? 'bg-sky-600/30 border border-sky-500/20 rounded-br-md'
                                        : 'bg-white/[0.06] border border-white/[0.06] rounded-bl-md'
                                    }`}>
                                    <p className="text-sm text-white leading-relaxed">{msg.content}</p>
                                    <p className="text-[8px] text-gray-600 text-right mt-1">
                                        {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </p>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* ═══ SELLER PIN ENTRY (when funds are held) ═══ */}
            {!isBuyer && escrowState === 'holding' && (
                <div className="mx-4 mb-2">
                    {showPinPad ? (
                        <div className="bg-gradient-to-br from-amber-500/15 to-orange-500/15 border border-amber-500/20 rounded-2xl p-4">
                            <p className="text-[10px] text-amber-400/70 font-bold uppercase tracking-widest mb-3 text-center">
                                Enter Buyer's PIN
                            </p>
                            <div className="flex items-center justify-center gap-3 mb-4">
                                {[0, 1, 2, 3].map(i => (
                                    <div key={i} className={`w-12 h-14 rounded-xl border-2 flex items-center justify-center transition-all ${pinError
                                            ? 'border-red-500/50 bg-red-500/10 animate-[shake_0.3s_ease-in-out]'
                                            : pinInput[i]
                                                ? 'border-amber-400/40 bg-amber-500/15'
                                                : 'border-white/10 bg-white/[0.04]'
                                        }`}>
                                        <span className="text-2xl font-black text-white">
                                            {pinInput[i] || ''}
                                        </span>
                                    </div>
                                ))}
                            </div>

                            {/* Number pad */}
                            <div className="grid grid-cols-3 gap-2 max-w-[240px] mx-auto">
                                {[1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, 'del'].map((key, i) => (
                                    key === null ? <div key={i} /> : (
                                        <button
                                            key={i}
                                            onClick={() => {
                                                triggerHaptic('light');
                                                if (key === 'del') {
                                                    setPinInput(prev => prev.slice(0, -1));
                                                } else if (pinInput.length < 4) {
                                                    const next = pinInput + key;
                                                    setPinInput(next);
                                                    if (next.length === 4) {
                                                        setTimeout(() => handleVerifyPin(), 200);
                                                    }
                                                }
                                            }}
                                            className="h-12 rounded-xl bg-white/[0.06] text-white font-black text-lg hover:bg-white/10 active:scale-95 transition-all"
                                        >
                                            {key === 'del' ? '⌫' : key}
                                        </button>
                                    )
                                ))}
                            </div>

                            {pinError && (
                                <p className="text-xs text-red-400 font-bold text-center mt-3">Incorrect PIN — try again</p>
                            )}
                        </div>
                    ) : (
                        <button
                            onClick={() => {
                                triggerHaptic('medium');
                                setShowPinPad(true);
                            }}
                            className="w-full py-3.5 bg-gradient-to-r from-amber-600 to-orange-600 rounded-2xl text-sm font-black text-white uppercase tracking-widest shadow-lg shadow-amber-500/20 hover:from-amber-500 hover:to-orange-500 transition-all active:scale-[0.97]"
                        >
                            🔐 Enter Buyer's PIN to Release Funds
                        </button>
                    )}
                </div>
            )}

            {/* ═══ COMPOSE BAR ═══ */}
            <div className="px-4 pb-4 pt-2 flex items-center gap-2 shrink-0 border-t border-white/[0.06]">
                {/* Buyer: Secure Funds button */}
                {isBuyer && escrowState === 'none' && (
                    <button
                        onClick={handleSecureFunds}
                        disabled={securingFunds}
                        className="shrink-0 px-3 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 rounded-xl text-[10px] font-black text-white uppercase tracking-widest hover:from-emerald-500 hover:to-teal-500 transition-all active:scale-95 disabled:opacity-50"
                    >
                        {securingFunds ? (
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        ) : (
                            '💰 Secure'
                        )}
                    </button>
                )}

                {/* Text input */}
                <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') sendMessage(); }}
                    placeholder={escrowState === 'released' ? 'Transaction complete ✅' : 'Type a message...'}
                    className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-sky-500/30"
                    disabled={escrowState === 'released'}
                />

                {/* Send button */}
                <button
                    onClick={sendMessage}
                    disabled={!input.trim() || sending}
                    className="p-2.5 bg-sky-600/30 rounded-xl hover:bg-sky-600/50 transition-colors disabled:opacity-30 active:scale-95"
                >
                    <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                    </svg>
                </button>
            </div>
        </div>
    );
};
