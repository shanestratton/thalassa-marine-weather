/**
 * ChatHeader — Nav bar with back button, view title, and action buttons.
 * Extracted from ChatPage to reduce monolith complexity.
 */
import React from 'react';
import { ChatChannel } from '../../services/ChatService';
import { useTheme } from '../../context/ThemeContext';

type ChatView = 'channels' | 'messages' | 'dm_inbox' | 'dm_thread' | 'profile' | 'lonely_hearts' | 'find_crew' | 'marketplace';

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
}

export const ChatHeader: React.FC<ChatHeaderProps> = React.memo(({
    view, activeChannel, dmPartnerName, myAvatarUrl, unreadDMs,
    messageCount, isUserBlocked, hasDMPartner,
    onGoBack, onOpenProfile, onOpenDMInbox, onToggleBlock,
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
                            {view === 'lonely_hearts' && <><span className="text-[#FF7F50]">♥</span> First Mates</>}
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
                        <span className="text-xs text-white/60 tabular-nums">{messageCount} msgs</span>
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
