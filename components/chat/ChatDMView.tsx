import React, { useCallback } from 'react';
import { DMConversation, DirectMessage, parsePinDrop } from '../../services/ChatService';
import { getAvatarGradient, timeAgo } from './chatUtils';

// Pin drop card component
const PinDropCard: React.FC<{ lat: number; lon: number; label: string }> = ({ lat, lon, label }) => {
    const handleTap = useCallback(() => {
        // Dispatch event for map to fly to this location
        window.dispatchEvent(new CustomEvent('pin-drop-navigate', {
            detail: { lat, lon, label },
        }));
    }, [lat, lon, label]);

    const latStr = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;

    return (
        <button
            onClick={handleTap}
            className="w-full text-left rounded-xl bg-sky-500/[0.08] border border-sky-500/20 p-3 transition-all active:scale-[0.97] hover:bg-sky-500/[0.12]"
            aria-label={`View ${label} on map`}
        >
            <div className="flex items-center gap-2 mb-1.5">
                <span className="text-base">📍</span>
                <span className="text-xs font-bold text-sky-300">{label}</span>
            </div>
            <p className="text-[11px] text-white/40 font-mono">{latStr}, {lonStr}</p>
            <p className="text-[10px] text-sky-400/60 mt-1.5 font-semibold">Tap to view on map →</p>
        </button>
    );
};

// Render message content — detects pin drops
function renderMessageContent(message: string): React.ReactNode {
    const pin = parsePinDrop(message);
    if (pin) {
        return <PinDropCard lat={pin.lat} lon={pin.lon} label={pin.label} />;
    }
    return <p className="text-xs text-white/70 leading-relaxed">{message}</p>;
}

// --- DM Inbox ---
export interface ChatDMInboxProps {
    conversations: DMConversation[];
    onOpenThread: (userId: string, name: string) => void;
}

export const ChatDMInbox: React.FC<ChatDMInboxProps> = React.memo(({ conversations, onOpenThread }) => (
    <div className="px-4 py-3 space-y-1.5" role="list" aria-label="Direct message conversations">
        {conversations.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20">
                <div className="relative mb-6">
                    <div className="w-16 h-16 rounded-full bg-purple-500/[0.06] border border-purple-500/10 flex items-center justify-center empty-ripple">
                        <span className="text-3xl empty-bob">✉️</span>
                    </div>
                </div>
                <p className="text-sm font-semibold text-white/70 mb-1">No messages in the bottle</p>
                <p className="text-[11px] text-white/30 max-w-[220px] text-center leading-relaxed">
                    Tap a sailor's avatar in any channel to start a private conversation
                </p>
            </div>
        )}
        {conversations.map((conv, i) => (
            <button
                key={conv.user_id}
                onClick={() => onOpenThread(conv.user_id, conv.display_name)}
                aria-label={`Message ${conv.display_name}${conv.unread_count > 0 ? `, ${conv.unread_count} unread` : ''}`}
                role="listitem"
                className="w-full flex items-center gap-3 p-3.5 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.03] hover:border-white/[0.08] transition-all duration-200 active:scale-[0.98] msg-enter min-h-[56px]"
                style={{ animationDelay: `${i * 50}ms` }}
            >
                <div
                    className={`w-11 h-11 rounded-xl bg-gradient-to-br ${getAvatarGradient(conv.user_id)} flex items-center justify-center text-sm font-bold flex-shrink-0 shadow-lg`}
                >
                    {conv.display_name.charAt(0).toUpperCase()}
                </div>
                <div className="text-left flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                        <p className="text-xs font-semibold text-white/85">{conv.display_name}</p>
                        <span className="text-[11px] text-white/15 tabular-nums">{timeAgo(conv.last_at)}</span>
                    </div>
                    <p className="text-[11px] text-white/60 truncate">
                        {parsePinDrop(conv.last_message) ? `📍 ${parsePinDrop(conv.last_message)!.label}` : conv.last_message}
                    </p>
                </div>
                {conv.unread_count > 0 && (
                    <span className="min-w-[20px] h-5 rounded-full bg-gradient-to-r from-sky-500 to-sky-500 text-[11px] font-bold flex items-center justify-center px-1.5 flex-shrink-0 shadow-lg shadow-sky-500/20">
                        {conv.unread_count}
                    </span>
                )}
            </button>
        ))}
    </div>
));
ChatDMInbox.displayName = 'ChatDMInbox';

// --- DM Thread ---
export interface ChatDMThreadProps {
    thread: DirectMessage[];
    partnerName?: string;
}

export const ChatDMThread: React.FC<ChatDMThreadProps> = React.memo(({ thread, partnerName }) => (
    <div className="flex flex-col min-h-full" role="log" aria-label="Direct messages">
        <div className="flex-1 px-4 py-3 space-y-2">
            {thread.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20">
                    <div className="relative mb-6">
                        <div className="w-16 h-16 rounded-full bg-sky-500/[0.06] border border-sky-500/10 flex items-center justify-center">
                            <span className="text-3xl empty-bob">👋</span>
                        </div>
                    </div>
                    <p className="text-sm font-semibold text-white/70 mb-1">Start a conversation</p>
                    <p className="text-[11px] text-white/30 max-w-[200px] text-center leading-relaxed">
                        Say ahoy to {partnerName} — they're just a message away!
                    </p>
                </div>
            )}
            {thread.map((dm, i) => {
                const isSelf = dm.sender_id === 'self';
                return (
                    <div
                        key={dm.id}
                        className={`flex ${isSelf ? 'justify-end' : 'justify-start'} msg-enter`}
                        style={{ animationDelay: `${Math.min(i * 25, 200)}ms` }}
                    >
                        <div
                            className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
                                isSelf
                                    ? 'bg-gradient-to-br from-sky-500/15 to-sky-500/15 border border-sky-500/15 rounded-br-lg'
                                    : 'bg-white/[0.04] border border-white/[0.04] rounded-bl-lg'
                            }`}
                        >
                            {renderMessageContent(dm.message)}
                            <p className="text-[11px] text-white/15 mt-1 tabular-nums">{timeAgo(dm.created_at)}</p>
                        </div>
                    </div>
                );
            })}
        </div>
    </div>
));
ChatDMThread.displayName = 'ChatDMThread';

// --- DM Compose Bar ---
export interface ChatDMComposeProps {
    dmText: string;
    setDmText: (v: string) => void;
    partnerName?: string;
    keyboardOffset: number;
    isUserBlocked: boolean;
    showBlockConfirm: boolean;
    setShowBlockConfirm: (v: boolean) => void;
    onSendDM: () => void;
    onBlock: () => void;
    onUnblock: () => void;
}

export const ChatDMCompose: React.FC<ChatDMComposeProps> = React.memo(
    ({
        dmText,
        setDmText,
        partnerName,
        keyboardOffset,
        isUserBlocked,
        showBlockConfirm,
        setShowBlockConfirm,
        onSendDM,
        onBlock,
        onUnblock,
    }) => (
        <div className="flex-shrink-0 relative">
            <div className="absolute inset-0 bg-gradient-to-t from-[#050a18] via-[#050a18]/95 to-transparent" />
            <div
                className={`relative px-4 py-3 ${keyboardOffset > 0 ? 'pb-2' : 'pb-[max(0.75rem,env(safe-area-inset-bottom))]'}`}
            >
                {/* Block confirmation dialog */}
                {showBlockConfirm && (
                    <div className="mb-3 p-4 rounded-2xl bg-red-500/5 border border-red-400/15">
                        <p className="text-sm text-white/60 mb-3">
                            {isUserBlocked
                                ? `Unblock ${partnerName}? They'll be able to DM you again.`
                                : `Block ${partnerName}? They won't be able to send you DMs.`}
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={isUserBlocked ? onUnblock : onBlock}
                                aria-label={isUserBlocked ? `Unblock ${partnerName}` : `Block ${partnerName}`}
                                className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all active:scale-95 min-h-[44px] ${
                                    isUserBlocked
                                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/20'
                                        : 'bg-red-500/15 text-red-300 border border-red-400/20'
                                }`}
                            >
                                {isUserBlocked ? '🔓 Unblock' : '🚫 Block'}
                            </button>
                            <button
                                onClick={() => setShowBlockConfirm(false)}
                                aria-label="Cancel"
                                className="flex-1 py-3 rounded-xl bg-white/[0.04] text-white/60 text-sm font-medium border border-white/[0.06] transition-all active:scale-95 min-h-[44px]"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Blocked state */}
                {isUserBlocked && !showBlockConfirm ? (
                    <div className="flex items-center justify-between py-2">
                        <p className="text-xs text-red-300/50">🚫 This user is blocked</p>
                        <button
                            onClick={() => setShowBlockConfirm(true)}
                            aria-label="Unblock user"
                            className="text-xs text-white/25 hover:text-emerald-300/60 transition-colors min-h-[44px] px-2"
                        >
                            Unblock
                        </button>
                    </div>
                ) : (
                    !showBlockConfirm && (
                        <div className="flex items-center gap-2" role="toolbar" aria-label="Message compose">
                            <input
                                type="text"
                                value={dmText}
                                onChange={(e) => setDmText(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && onSendDM()}
                                placeholder={`Message ${partnerName || ''}...`}
                                aria-label={`Message ${partnerName || 'user'}`}
                                className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-purple-500/30 focus:bg-white/[0.06] transition-all duration-200 min-h-[48px]"
                            />
                            <button
                                onClick={onSendDM}
                                disabled={!dmText.trim()}
                                aria-label="Send direct message"
                                className="w-11 h-11 rounded-xl bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-400 hover:to-purple-500 disabled:from-white/[0.03] disabled:to-white/[0.03] disabled:border disabled:border-white/[0.04] flex items-center justify-center transition-all duration-200 active:scale-90 disabled:active:scale-100 shadow-lg shadow-purple-500/20 disabled:shadow-none"
                            >
                                <svg
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    className={dmText.trim() ? 'text-white' : 'text-white/15'}
                                >
                                    <path d="M22 2L11 13" />
                                    <path d="M22 2l-7 20-4-9-9-4z" />
                                </svg>
                            </button>
                        </div>
                    )
                )}
            </div>
        </div>
    ),
);
ChatDMCompose.displayName = 'ChatDMCompose';
