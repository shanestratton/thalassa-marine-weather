/**
 * ChatMessageList — Channel message rendering with pins, tracks, mod actions.
 * Extracted from ChatPage to reduce monolith complexity.
 */
import React, { useState, useCallback } from 'react';
import { ChatMessage } from '../../services/ChatService';
import {
    getAvatarGradient,
    timeAgo,
    getCrewRank,
    getStaticMapUrl,
    parsePinMessage,
    parseTrackMessage,
    exportPinAsGPX,
} from './chatUtils';
import { useUI } from '../../context/UIContext';
import { LocationStore } from '../../stores/LocationStore';

/** Messages shown per page — keeps the DOM lean while preserving scroll feel */
const PAGE_SIZE = 50;

// --- Types ---
export interface ChatMessageListProps {
    messages: ChatMessage[];
    pinnedMessages: ChatMessage[];
    isMod: boolean;
    isAdmin: boolean;
    isModerator: boolean;
    likedMessages: Set<string>;
    showModMenu: string | null;
    showRankTooltip: string | null;
    importingTrackId: string | null;
    getAvatar: (userId: string) => string | null;
    onOpenDMThread: (userId: string, name: string) => void;
    onMarkHelpful: (msgId: string) => void;
    onReportMsg: (msg: ChatMessage) => void;
    onToggleModMenu: (msgId: string) => void;
    onDeleteMessage: (msgId: string) => void;
    onPinMessage: (msgId: string, pinned: boolean) => void;
    onMuteUser: (userId: string, hours: number) => void;
    onBlockUser: (userId: string, name: string) => void;
    onMakeAdmin: (userId: string, name: string) => void;
    onSetRankTooltip: (id: string | null) => void;
    onShowTrackDisclaimer: (track: { trackId: string; title: string }) => void;
    messageEndRef: React.RefObject<HTMLDivElement>;
}

export const ChatMessageList: React.FC<ChatMessageListProps> = React.memo(
    ({
        messages,
        pinnedMessages,
        isMod,
        isAdmin: _isAdmin,
        isModerator,
        likedMessages,
        showModMenu,
        showRankTooltip,
        importingTrackId,
        getAvatar: getAvatarProp,
        onOpenDMThread,
        onMarkHelpful,
        onReportMsg,
        onToggleModMenu,
        onDeleteMessage,
        onPinMessage,
        onMuteUser,
        onBlockUser,
        onMakeAdmin,
        onSetRankTooltip,
        onShowTrackDisclaimer,
        messageEndRef,
    }) => {
        const { setPage } = useUI();
        const regularMessages = messages.filter((m) => !m.is_pinned);

        // Windowed rendering — show only last PAGE_SIZE messages, expand on demand
        const [visiblePages, setVisiblePages] = useState(1);
        const visibleCount = visiblePages * PAGE_SIZE;
        const hasMore = regularMessages.length > visibleCount;
        const windowedMessages = hasMore
            ? regularMessages.slice(regularMessages.length - visibleCount)
            : regularMessages;

        const loadMore = useCallback(() => {
            setVisiblePages((p) => p + 1);
        }, []);

        // Real online status — users who posted in the last 15 minutes
        const recentlyActiveUsers = React.useMemo(() => {
            const cutoff = Date.now() - 15 * 60 * 1000;
            const active = new Set<string>();
            for (const m of messages) {
                if (m.user_id !== 'self' && new Date(m.created_at).getTime() > cutoff) {
                    active.add(m.user_id);
                }
            }
            return active;
        }, [messages]);

        /** Date separator label — "Today", "Yesterday", or "Mon 3 Mar" */
        const getDateLabel = (dateStr: string): string => {
            const d = new Date(dateStr);
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            const diff = today.getTime() - msgDay.getTime();
            if (diff === 0) return 'Today';
            if (diff === 86400000) return 'Yesterday';
            return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
        };

        /** Whether a date separator should render before message at index i in the windowed array */
        const shouldShowDateSep = (i: number): boolean => {
            if (i === 0) return true;
            const prev = windowedMessages[i - 1];
            const curr = windowedMessages[i];
            const prevDay = new Date(prev.created_at).toDateString();
            const currDay = new Date(curr.created_at).toDateString();
            return prevDay !== currDay;
        };

        const navigateToPin = (lat: number, lng: number) => {
            // Save current channel so ChatPage can restore on return
            const lastChannel = localStorage.getItem('chat_last_channel');
            if (lastChannel) sessionStorage.setItem('chat_return_to_channel', lastChannel);
            // Set pin-view flag so MapHub opens in clean mode (no weather FABs)

            window.__thalassaPinView = { lat, lng };
            // Set the pin in the LocationStore so MapHub picks it up
            LocationStore.setFromMapPin(lat, lng);
            // Navigate to the Map tab
            setPage('map');
            // After a brief delay (let MapHub mount/render), center the map on the pin
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent('map-recenter', { detail: { lat, lon: lng, zoom: 7 } }));
            }, 500);
        };

        return (
            <>
                <div className="flex flex-col min-h-full">
                    {/* Pinned bar */}
                    {pinnedMessages.length > 0 && (
                        <div className="mx-4 mt-2 p-3 rounded-xl bg-amber-500/[0.04] border border-amber-500/[0.08] fade-slide-down">
                            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-400/40 mb-1.5">
                                📌 Pinned
                            </p>
                            {pinnedMessages.map((pm) => (
                                <div key={pm.id} className="flex items-center gap-2 py-0.5">
                                    <span className="text-base font-medium text-amber-300/70">{pm.display_name}:</span>
                                    <span className="text-base text-white/60 truncate">{pm.message}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Messages list */}
                    <div className="flex-1 px-4 py-3 space-y-1" role="list" aria-label="Channel messages">
                        {/* Load earlier messages — pagination trigger */}
                        {hasMore && (
                            <div className="flex justify-center py-3">
                                <button
                                    onClick={loadMore}
                                    className="px-4 py-2 rounded-xl bg-white/[0.04] border border-white/[0.06] text-[11px] font-bold text-white/40 uppercase tracking-wider hover:bg-white/[0.08] active:scale-95 transition-all min-h-[40px]"
                                    aria-label="Load earlier messages"
                                >
                                    ↑ Load earlier messages ({regularMessages.length - visibleCount} more)
                                </button>
                            </div>
                        )}

                        {windowedMessages.length === 0 && (
                            <div className="flex-1 flex flex-col items-center justify-center py-28">
                                <div className="relative mb-8">
                                    <div className="w-20 h-20 rounded-full bg-sky-500/[0.06] border border-sky-500/10 flex items-center justify-center empty-ripple">
                                        <span className="text-4xl empty-bob">⛵</span>
                                    </div>
                                </div>
                                <p className="text-lg font-semibold text-white/70 mb-1">All quiet on deck</p>
                                <p className="text-sm text-white/30 max-w-[220px] text-center leading-relaxed">
                                    Be the first to break radio silence — say ahoy to the crew!
                                </p>
                                <div className="flex items-center gap-3 mt-5">
                                    <span className="w-8 h-px bg-gradient-to-r from-transparent to-white/10" />
                                    <span className="text-[11px] text-white/40 uppercase tracking-[0.2em]">
                                        fair winds
                                    </span>
                                    <span className="w-8 h-px bg-gradient-to-l from-transparent to-white/10" />
                                </div>
                            </div>
                        )}

                        {windowedMessages.map((msg, i) => {
                            const isDeleted = !!msg.deleted_at;
                            const isSelf = msg.user_id === 'self';
                            const rank = getCrewRank(msg.helpful_count);
                            const dateSep = shouldShowDateSep(i);

                            // Message grouping — consecutive same-user messages within 5 minutes cluster
                            // Break grouping across date boundaries
                            const prevMsg = i > 0 ? windowedMessages[i - 1] : null;
                            const isGroupContinuation = !!(
                                prevMsg &&
                                !prevMsg.deleted_at &&
                                !isDeleted &&
                                !dateSep &&
                                prevMsg.user_id === msg.user_id &&
                                !msg.is_question &&
                                !prevMsg.is_question &&
                                new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() <
                                    5 * 60 * 1000
                            );

                            return (
                                <React.Fragment key={msg.id}>
                                    {/* Date separator */}
                                    {dateSep && (
                                        <div
                                            className="flex items-center gap-3 py-3"
                                            role="separator"
                                            aria-label={getDateLabel(msg.created_at)}
                                        >
                                            <span className="flex-1 h-px bg-gradient-to-r from-transparent to-white/[0.06]" />
                                            <span className="text-[11px] font-bold text-white/40 uppercase tracking-[0.15em]">
                                                {getDateLabel(msg.created_at)}
                                            </span>
                                            <span className="flex-1 h-px bg-gradient-to-l from-transparent to-white/[0.06]" />
                                        </div>
                                    )}
                                    <div
                                        className={`msg-enter group relative ${isGroupContinuation ? 'py-0.5' : 'py-2'} ${
                                            msg.is_question && !isDeleted
                                                ? 'question-glow bg-amber-500/[0.04] border border-amber-500/[0.08] rounded-2xl px-3 mx-[-4px] my-2'
                                                : ''
                                        }`}
                                        style={
                                            {
                                                animationDelay: `${Math.min(i * 30, 300)}ms`,
                                                contentVisibility: 'auto',
                                                containIntrinsicSize: 'auto 60px',
                                            } as React.CSSProperties
                                        }
                                    >
                                        {/* Question header */}
                                        {msg.is_question && !isDeleted && (
                                            <div className="flex items-center gap-1.5 mb-2">
                                                <span className="text-sm font-bold text-amber-400/80 uppercase tracking-[0.15em]">
                                                    📢 Question
                                                </span>
                                                {msg.helpful_count > 0 && (
                                                    <span className="text-sm text-emerald-400/50 ml-auto">
                                                        {msg.helpful_count} found this helpful
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        <div className="flex items-start gap-2.5">
                                            {/* Avatar — hidden for grouped continuation messages */}
                                            {isGroupContinuation ? (
                                                <div className="w-12 flex-shrink-0" /> /* spacer for alignment */
                                            ) : (
                                                <div className="relative flex-shrink-0">
                                                    <button
                                                        onClick={() =>
                                                            !isSelf && onOpenDMThread(msg.user_id, msg.display_name)
                                                        }
                                                        aria-label={
                                                            isSelf ? 'Your avatar' : `Message ${msg.display_name}`
                                                        }
                                                        className={`w-12 h-12 rounded-xl overflow-hidden shadow-lg hover:scale-105 transition-transform duration-150 ${!isSelf ? 'cursor-pointer' : 'cursor-default'}`}
                                                        title={isSelf ? undefined : `DM ${msg.display_name}`}
                                                    >
                                                        {getAvatarProp(msg.user_id) ? (
                                                            <img
                                                                src={getAvatarProp(msg.user_id)!}
                                                                alt=""
                                                                className="w-full h-full object-cover"
                                                            />
                                                        ) : (
                                                            <div
                                                                className={`w-full h-full bg-gradient-to-br ${getAvatarGradient(msg.user_id)} flex items-center justify-center text-xs font-bold`}
                                                            >
                                                                {msg.display_name.charAt(0).toUpperCase()}
                                                            </div>
                                                        )}
                                                    </button>
                                                    {/* Online status dot — based on real message recency (last 15min) */}
                                                    {!isSelf && !isDeleted && recentlyActiveUsers.has(msg.user_id) && (
                                                        <span
                                                            className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-slate-900 status-pulse"
                                                            aria-label="Recently active"
                                                        />
                                                    )}
                                                </div>
                                            )}

                                            <div className="flex-1 min-w-0">
                                                {/* Name row — hidden for grouped continuation messages */}
                                                {!isGroupContinuation && (
                                                    <div className="flex items-center gap-1.5 mb-0.5">
                                                        <span
                                                            className={`text-base font-bold ${isSelf ? 'text-sky-400' : 'text-white/80'}`}
                                                        >
                                                            {msg.display_name}
                                                        </span>
                                                        <button
                                                            aria-label="View rank"
                                                            className="relative"
                                                            onMouseEnter={() => onSetRankTooltip(msg.id)}
                                                            onMouseLeave={() => onSetRankTooltip(null)}
                                                            onClick={() =>
                                                                onSetRankTooltip(
                                                                    showRankTooltip === msg.id ? null : msg.id,
                                                                )
                                                            }
                                                        >
                                                            <span className="text-[11px]">{rank.badge}</span>
                                                            {showRankTooltip === msg.id && (
                                                                <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-lg bg-slate-700 text-[11px] text-white/70 whitespace-nowrap z-10 shadow-xl">
                                                                    {rank.title} • {msg.helpful_count} helpful
                                                                </span>
                                                            )}
                                                        </button>
                                                        {isMod && msg.user_id !== 'self' && (
                                                            <span className="text-[11px] opacity-30">🛡️</span>
                                                        )}
                                                        <span className="text-sm text-white/60 ml-auto tabular-nums">
                                                            {timeAgo(msg.created_at)}
                                                        </span>
                                                    </div>
                                                )}

                                                {/* Message body */}
                                                {isDeleted ? (
                                                    <p className="text-sm text-white/40 italic py-0.5">
                                                        [removed by moderator]
                                                    </p>
                                                ) : (
                                                    (() => {
                                                        const pin = parsePinMessage(msg.message);
                                                        const track = parseTrackMessage(msg.message);
                                                        if (pin) {
                                                            const isLoc = pin.caption.startsWith('[LOC]');
                                                            const isPoi = pin.caption.startsWith('[POI]');
                                                            const cleanCaption = pin.caption.replace(
                                                                /^\[(LOC|POI)\]\s*/,
                                                                '',
                                                            );
                                                            return (
                                                                <div
                                                                    className={`mt-1.5 rounded-2xl overflow-hidden border ${isLoc ? 'border-emerald-500/20' : isPoi ? 'border-purple-500/20' : 'border-white/[0.08]'} bg-white/[0.02] max-w-[280px]`}
                                                                >
                                                                    <button
                                                                        aria-label="Pin"
                                                                        onClick={() => navigateToPin(pin.lat, pin.lng)}
                                                                        className="w-full cursor-pointer hover:opacity-90 transition-opacity relative"
                                                                    >
                                                                        <img
                                                                            src={getStaticMapUrl(
                                                                                pin.lat,
                                                                                pin.lng,
                                                                                13,
                                                                                300,
                                                                                180,
                                                                                isLoc ? '22c55e' : 'ef4444',
                                                                            )}
                                                                            alt="Pin location"
                                                                            className="w-full h-[140px] object-cover"
                                                                            loading="lazy"
                                                                        />
                                                                        {/* Source badge */}
                                                                        <span
                                                                            className={`absolute top-2 left-2 px-2.5 py-1 rounded-lg text-[11px] font-black uppercase tracking-wider shadow-lg ${
                                                                                isLoc
                                                                                    ? 'bg-emerald-900/90 text-emerald-300 border border-emerald-400/30'
                                                                                    : isPoi
                                                                                      ? 'bg-purple-900/90 text-purple-300 border border-purple-400/30'
                                                                                      : 'bg-slate-900/90 text-white/60 border border-white/15'
                                                                            }`}
                                                                        >
                                                                            {isLoc
                                                                                ? '📍 Live Location'
                                                                                : isPoi
                                                                                  ? '🗺️ Shared Pin'
                                                                                  : '📍 Pin'}
                                                                        </span>
                                                                    </button>
                                                                    <div className="px-3 py-2">
                                                                        <p className="text-lg text-white/70 font-medium leading-snug">
                                                                            {cleanCaption}
                                                                        </p>
                                                                        <div className="flex items-center justify-between mt-0.5">
                                                                            <p className="text-sm text-white/40 tabular-nums">
                                                                                📍 {Math.abs(pin.lat).toFixed(4)}°
                                                                                {pin.lat < 0 ? 'S' : 'N'},{' '}
                                                                                {Math.abs(pin.lng).toFixed(4)}°
                                                                                {pin.lng < 0 ? 'W' : 'E'}
                                                                            </p>
                                                                            <button
                                                                                onClick={() =>
                                                                                    exportPinAsGPX(
                                                                                        pin.lat,
                                                                                        pin.lng,
                                                                                        pin.caption,
                                                                                    )
                                                                                }
                                                                                aria-label="Export pin as GPX"
                                                                                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-500/10 border border-sky-500/15 active:scale-95 transition-transform min-h-[36px]"
                                                                            >
                                                                                <span className="text-[11px]">📥</span>
                                                                                <span className="text-[11px] font-bold text-sky-300 uppercase">
                                                                                    GPX
                                                                                </span>
                                                                            </button>
                                                                        </div>
                                                                        {isPoi && (
                                                                            <p className="text-[11px] text-purple-400/50 mt-1.5 uppercase tracking-wider font-bold">
                                                                                ⚠️ Shared place — not the user's
                                                                                location
                                                                            </p>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            );
                                                        }
                                                        if (track) {
                                                            const isImporting = importingTrackId === track.trackId;
                                                            return (
                                                                <button
                                                                    aria-label="Show Track Disclaimer"
                                                                    onClick={() => onShowTrackDisclaimer(track)}
                                                                    disabled={isImporting}
                                                                    className="mt-1.5 rounded-2xl overflow-hidden border border-sky-500/[0.15] bg-gradient-to-r from-sky-500/[0.06] to-sky-500/[0.04] max-w-[280px] px-3 py-2.5 text-left w-full hover:from-sky-500/[0.12] hover:to-sky-500/[0.08] transition-all active:scale-[0.98] disabled:opacity-50"
                                                                >
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="text-lg">
                                                                            {isImporting ? '' : '🗺️'}
                                                                        </span>
                                                                        {isImporting && (
                                                                            <div className="w-5 h-5 border-2 border-sky-400/30 rounded-full border-t-sky-400 animate-spin shrink-0" />
                                                                        )}
                                                                        <div className="min-w-0 flex-1">
                                                                            <p className="text-lg text-sky-300/80 font-semibold truncate">
                                                                                {track.title}
                                                                            </p>
                                                                            <p className="text-xs text-white/40 mt-0.5">
                                                                                {isImporting
                                                                                    ? 'Importing…'
                                                                                    : 'Tap to import voyage track'}
                                                                            </p>
                                                                        </div>
                                                                        <span className="text-sky-400/30 text-sm">
                                                                            ⬇
                                                                        </span>
                                                                    </div>
                                                                </button>
                                                            );
                                                        }
                                                        return (
                                                            <div className="flex items-end gap-1">
                                                                <p className="text-lg text-white/70 leading-relaxed break-words">
                                                                    {msg.message}
                                                                </p>
                                                                {isSelf && (
                                                                    <span
                                                                        className="text-[11px] text-sky-400/40 flex-shrink-0 mb-0.5"
                                                                        aria-label="Delivered"
                                                                    >
                                                                        ✓✓
                                                                    </span>
                                                                )}
                                                            </div>
                                                        );
                                                    })()
                                                )}

                                                {/* Action row */}
                                                {!isDeleted && !isSelf && (
                                                    <div className="flex items-center gap-3 mt-1.5 h-6 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                                                        <button
                                                            onClick={() => onMarkHelpful(msg.id)}
                                                            disabled={likedMessages.has(msg.id)}
                                                            aria-label={`Mark as helpful${msg.helpful_count > 0 ? `, ${msg.helpful_count} found helpful` : ''}`}
                                                            className={`text-sm transition-colors flex items-center gap-1 active:scale-95 min-h-[36px] ${likedMessages.has(msg.id) ? 'text-emerald-400/70 cursor-default' : 'text-emerald-400/40 hover:text-emerald-400'}`}
                                                        >
                                                            {likedMessages.has(msg.id) ? '✅' : '👍'} Helpful
                                                            {msg.helpful_count > 0 && ` (${msg.helpful_count})`}
                                                        </button>
                                                        <button
                                                            onClick={() => onReportMsg(msg)}
                                                            aria-label="Report message"
                                                            className="text-sm text-white/10 hover:text-amber-400/60 transition-colors min-h-[36px]"
                                                        >
                                                            🚩 Report
                                                        </button>
                                                        {isMod && (
                                                            <button
                                                                aria-label="Toggle"
                                                                onClick={() => onToggleModMenu(msg.id)}
                                                                className="text-[11px] text-white/40 hover:text-red-400/60 transition-colors"
                                                            >
                                                                🛡️ Mod
                                                            </button>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Mod menu */}
                                                {showModMenu === msg.id && isMod && (
                                                    <div className="mt-2 p-2.5 rounded-xl bg-slate-800/90 border border-white/[0.08] space-y-1 fade-slide-down shadow-2xl">
                                                        <button
                                                            onClick={() => onDeleteMessage(msg.id)}
                                                            aria-label="Delete message"
                                                            className="w-full text-left text-[11px] text-red-400/80 hover:bg-red-500/10 px-2.5 py-2 rounded-lg transition-colors min-h-[40px]"
                                                        >
                                                            🗑 Delete message
                                                        </button>
                                                        <button
                                                            onClick={() => onPinMessage(msg.id, msg.is_pinned)}
                                                            aria-label={msg.is_pinned ? 'Unpin message' : 'Pin message'}
                                                            className="w-full text-left text-[11px] text-amber-400/80 hover:bg-amber-500/10 px-2.5 py-2 rounded-lg transition-colors min-h-[40px]"
                                                        >
                                                            {msg.is_pinned ? '📌 Unpin' : '📌 Pin message'}
                                                        </button>
                                                        <div className="h-px bg-white/[0.04] my-1" />
                                                        <p className="text-[11px] text-white/60 px-2.5 uppercase tracking-wider">
                                                            Mute {msg.display_name}
                                                        </p>
                                                        <div className="flex gap-1 px-2">
                                                            {[
                                                                { hrs: 1, label: '1h' },
                                                                { hrs: 24, label: '24h' },
                                                                { hrs: 168, label: '7d' },
                                                            ].map(({ hrs, label }) => (
                                                                <button
                                                                    aria-label="Mute"
                                                                    key={hrs}
                                                                    onClick={() => onMuteUser(msg.user_id, hrs)}
                                                                    className="text-[11px] text-amber-400/70 hover:bg-amber-500/10 px-2.5 py-1.5 rounded-lg border border-amber-500/10 transition-colors min-h-[36px]"
                                                                >
                                                                    {label}
                                                                </button>
                                                            ))}
                                                        </div>
                                                        {/* Moderator-only actions */}
                                                        {isModerator && (
                                                            <>
                                                                <div className="h-px bg-white/[0.04] my-1" />
                                                                <button
                                                                    onClick={() =>
                                                                        onBlockUser(msg.user_id, msg.display_name)
                                                                    }
                                                                    aria-label={`Block ${msg.display_name}`}
                                                                    className="w-full text-left text-[11px] text-red-500/80 hover:bg-red-500/10 px-2.5 py-2 rounded-lg transition-colors min-h-[40px]"
                                                                >
                                                                    🚫 Block {msg.display_name}
                                                                </button>
                                                                <button
                                                                    onClick={() =>
                                                                        onMakeAdmin(msg.user_id, msg.display_name)
                                                                    }
                                                                    aria-label={`Make ${msg.display_name} admin`}
                                                                    className="w-full text-left text-[11px] text-sky-400/80 hover:bg-sky-500/10 px-2.5 py-2 rounded-lg transition-colors min-h-[40px]"
                                                                >
                                                                    👑 Make Admin
                                                                </button>
                                                            </>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </React.Fragment>
                            );
                        })}
                        <div ref={messageEndRef as React.RefObject<HTMLDivElement>} />
                    </div>
                </div>
            </>
        );
    },
);

ChatMessageList.displayName = 'ChatMessageList';
