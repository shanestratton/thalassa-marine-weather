/**
 * ChatHeader — Nav bar with back button, view title, and action buttons.
 * Extracted from ChatPage to reduce monolith complexity.
 */
import React from 'react';
import { ChatChannel } from '../../services/ChatService';
import { useTheme } from '../../context/ThemeContext';

type ChatView = 'channels' | 'messages' | 'dm_inbox' | 'dm_thread' | 'profile' | 'find_crew' | 'marketplace' | 'admin_panel';

export interface ChatHeaderProps {
    view: ChatView;
    activeChannel: ChatChannel | null;
    dmPartnerName?: string;
    myAvatarUrl: string | null;
    unreadDMs: number;
    messageCount: number;
    isUserBlocked: boolean;
    hasDMPartner: boolean;
    onGoBack: () => void;
    onOpenProfile: () => void;
    onOpenDMInbox: () => void;
    onToggleBlock: () => void;
    onLeaveChannel?: () => void;
    onPropose?: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = React.memo(({
    view, activeChannel, dmPartnerName, myAvatarUrl, unreadDMs,
    messageCount, isUserBlocked, hasDMPartner,
    onGoBack, onOpenProfile, onOpenDMInbox, onToggleBlock, onLeaveChannel, onPropose,
}) => {
    const t = useTheme();

    return (
        <div className={t.header.bar}>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    {view !== 'channels' && (
                        <button
                            onClick={onGoBack}
                            className="w-8 h-8 rounded-full bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center transition-all active:scale-90"
                        >
                            <span className="text-sky-400 text-sm">‹</span>
                        </button>
                    )}
                    {view === 'channels' ? (
                        <span className={t.typography.pageTitle}>Crew Talk</span>
                    ) : (
                        <h1 className={`${t.typography.pageTitle} flex items-center gap-2`}>
                            {view === 'messages' && (activeChannel ? `${activeChannel.icon} ${activeChannel.name}` : 'Channel')}
                            {view === 'dm_inbox' && '✉️ Messages'}
                            {view === 'dm_thread' && `${dmPartnerName || 'DM'}`}
                            {view === 'profile' && '⚓ Sailor Profile'}

                            {view === 'find_crew' && '👥 Crew Finder'}
                            {view === 'marketplace' && '🏪 Marketplace'}
                        </h1>
                    )}
                    {view === 'messages' && activeChannel && (
                        <p className="text-xs text-white/60 ml-1">{activeChannel.description}</p>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {view === 'channels' && (
                        <>
                            {onPropose && (
                                <button
                                    onClick={onPropose}
                                    aria-label="Propose a new channel"
                                    className="w-10 h-10 rounded-xl bg-white/[0.08] hover:bg-sky-500/15 border border-white/[0.12] hover:border-sky-500/30 flex items-center justify-center transition-all active:scale-95"
                                >
                                    <svg className="w-5 h-5 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                                    </svg>
                                </button>
                            )}
                            <button
                                onClick={onOpenProfile}
                                className="relative w-10 h-10 rounded-xl overflow-hidden border border-white/[0.12] hover:border-white/[0.18] bg-white/[0.08] hover:bg-white/[0.12] transition-all active:scale-95"
                            >
                                {myAvatarUrl ? (
                                    <img src={myAvatarUrl} alt="" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-white/[0.04] flex items-center justify-center">
                                        <span className="text-xl">⚓</span>
                                    </div>
                                )}
                            </button>
                            <button
                                onClick={onOpenDMInbox}
                                className="relative w-10 h-10 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.12] flex items-center justify-center transition-all active:scale-95"
                            >
                                <span className="text-xl">✉️</span>
                                {unreadDMs > 0 && (
                                    <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] bg-gradient-to-r from-red-500 to-red-500 rounded-full text-[11px] font-bold flex items-center justify-center px-1 shadow-lg shadow-red-500/30">
                                        {unreadDMs > 9 ? '9+' : unreadDMs}
                                    </span>
                                )}
                            </button>
                        </>
                    )}
                    {view === 'messages' && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-white/60 tabular-nums">{messageCount} msgs</span>
                            {activeChannel?.is_private && onLeaveChannel && (
                                <button
                                    onClick={onLeaveChannel}
                                    className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] hover:bg-red-500/10 border border-white/[0.06] text-white/50 hover:text-red-400 text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95"
                                >
                                    Leave
                                </button>
                            )}
                        </div>
                    )}
                    {view === 'dm_thread' && hasDMPartner && (
                        <button
                            onClick={onToggleBlock}
                            className="px-3 py-2 rounded-xl bg-white/[0.04] hover:bg-red-500/10 border border-white/[0.06] text-white/60 hover:text-red-400 text-xs font-medium transition-all active:scale-95"
                        >
                            {isUserBlocked ? '🔓 Unblock' : '🚫 Block'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
});

ChatHeader.displayName = 'ChatHeader';
