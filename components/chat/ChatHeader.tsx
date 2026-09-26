/**
 * ChatHeader — Scuttlebutt's page header: back, title, and the view's actions.
 * Extracted from ChatPage to reduce monolith complexity.
 *
 * Built on the shared PageHeader (UX scorecard run 6). The hand-built bar
 * truncated the root title to 'SCUTTLEBU…' behind three 44 pt buttons and sat
 * on its own band in daylight; PageHeader steps the title down until the
 * whole word fits and sits on the page tint like every other page.
 */
import React from 'react';
import { PageHeader } from '../ui/PageHeader';
import { ChatChannel } from '../../services/ChatService';
import { SafeImage } from '../ui/SafeImage';
import { useAuthStore } from '../../stores/authStore';
import { ProhibitedIcon, SendIcon } from '../Icons';
import { UserIcon } from '../vesselHub/icons';
import { getChannelName } from './channelIcons';

type ChatView = 'channels' | 'messages' | 'dm_inbox' | 'dm_thread' | 'profile' | 'find_crew' | 'admin_panel';

export interface ChatHeaderProps {
    view: ChatView;
    activeChannel: ChatChannel | null;
    dmPartnerName?: string;
    isSelfConversation?: boolean;
    myAvatarUrl: string | null;
    unreadDMs: number;
    messageCount: number;
    isUserBlocked: boolean;
    blockActionDisabled?: boolean;
    hasDMPartner: boolean;
    onGoBack: () => void;
    /** Leaves Scuttlebutt entirely — shown on the root channel list. */
    onExit?: () => void;
    onOpenProfile: () => void;
    onOpenDMInbox: () => void;
    onToggleBlock: () => void;
    onLeaveChannel?: () => void;
    onPropose?: () => void;
}

/** The house 44 pt icon button, with a line icon in the accent colour. */
const HEADER_ICON_BUTTON =
    'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/12 bg-white/8 text-sky-400 transition-all hover:border-sky-500/30 hover:bg-sky-500/15 active:scale-95';

const viewTitle = (view: ChatView, activeChannel: ChatChannel | null, dmPartnerName?: string): string => {
    switch (view) {
        case 'channels':
            return 'Scuttlebutt';
        case 'messages':
            return activeChannel ? getChannelName(activeChannel) : 'Channel';
        case 'dm_inbox':
            return 'Messages';
        case 'dm_thread':
            return dmPartnerName || 'Direct message';
        case 'profile':
            return 'Sailor profile';
        case 'find_crew':
            return 'The Crew List';
        case 'admin_panel':
            return 'Admin panel';
    }
};

export const ChatHeader: React.FC<ChatHeaderProps> = React.memo(
    ({
        view,
        activeChannel,
        dmPartnerName,
        isSelfConversation,
        myAvatarUrl,
        unreadDMs,
        messageCount,
        isUserBlocked,
        blockActionDisabled,
        hasDMPartner,
        onGoBack,
        onExit,
        onOpenProfile,
        onOpenDMInbox,
        onToggleBlock,
        onLeaveChannel,
        onPropose,
    }) => {
        // The presence dot is a claim about the skipper: only draw it when
        // they are actually signed in to chat.
        const signedIn = useAuthStore((s) => !!s.user);

        // Intra-page back on the sub-views; on the ROOT channel list the same
        // chevron LEAVES Scuttlebutt, which previously had no header exit at all.
        const onBack = view === 'channels' ? onExit : onGoBack;

        const subtitle =
            view === 'channels' ? (
                'Community'
            ) : view === 'messages' && activeChannel?.description ? (
                // Sentence case, not the house uppercase caption: this is a
                // channel's own description, often a whole sentence.
                <p className="ui-caption line-clamp-2 text-xs text-gray-300">{activeChannel.description}</p>
            ) : undefined;

        let action: React.ReactNode = null;
        if (view === 'channels') {
            action = (
                <div className="flex shrink-0 items-center gap-2">
                    {onPropose && (
                        <button
                            type="button"
                            onClick={onPropose}
                            aria-label="Propose a new channel"
                            className={HEADER_ICON_BUTTON}
                        >
                            <svg
                                aria-hidden="true"
                                className="h-5 w-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                            </svg>
                        </button>
                    )}
                    <button
                        type="button"
                        aria-label="Open your profile"
                        onClick={onOpenProfile}
                        className={HEADER_ICON_BUTTON}
                    >
                        <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-xl">
                            {myAvatarUrl ? (
                                <SafeImage
                                    src={myAvatarUrl}
                                    loading="lazy"
                                    alt=""
                                    className="h-full w-full object-cover"
                                />
                            ) : (
                                // A person, not the anchor two channels also use.
                                <span aria-hidden="true" className="[&>svg]:h-5 [&>svg]:w-5">
                                    <UserIcon color="currentColor" />
                                </span>
                            )}
                        </span>
                        {signedIn && (
                            <span
                                aria-hidden="true"
                                className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-slate-950 bg-emerald-500 shadow-xs shadow-emerald-500/40 [.display-light_&]:border-slate-200"
                            />
                        )}
                    </button>
                    <button
                        type="button"
                        aria-label={
                            unreadDMs > 0 ? `Open direct messages, ${unreadDMs} unread` : 'Open direct messages'
                        }
                        onClick={onOpenDMInbox}
                        className={HEADER_ICON_BUTTON}
                    >
                        <SendIcon className="h-5 w-5" />
                        {unreadDMs > 0 && (
                            <span
                                aria-hidden="true"
                                className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-bold text-white shadow-lg shadow-red-500/30"
                            >
                                {unreadDMs > 9 ? '9+' : unreadDMs}
                            </span>
                        )}
                    </button>
                </div>
            );
        } else if (view === 'messages') {
            action = (
                <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-white/60 tabular-nums">{messageCount} msgs</span>
                    {activeChannel?.is_private && onLeaveChannel && (
                        <button
                            type="button"
                            aria-label="Leave channel"
                            onClick={onLeaveChannel}
                            className="min-h-[44px] rounded-lg border border-white/6 bg-white/4 px-3 text-xs font-bold uppercase tracking-wider text-white/60 transition-all hover:bg-red-500/10 hover:text-red-400 active:scale-95"
                        >
                            Leave
                        </button>
                    )}
                </div>
            );
        } else if (view === 'dm_thread' && hasDMPartner) {
            action = (
                <button
                    type="button"
                    aria-label={
                        isSelfConversation
                            ? isUserBlocked
                                ? 'Unblock self-test conversation'
                                : 'Block self-test conversation'
                            : isUserBlocked
                              ? 'Unblock user'
                              : 'Block user'
                    }
                    onClick={onToggleBlock}
                    disabled={blockActionDisabled}
                    className="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl border border-white/6 bg-white/4 px-3 py-2 text-xs font-medium text-white/60 transition-all hover:bg-red-500/10 hover:text-red-400 active:scale-95"
                >
                    {!isUserBlocked && <ProhibitedIcon className="h-4 w-4" />}
                    {isUserBlocked ? 'Unblock' : 'Block'}
                </button>
            );
        }

        return (
            <PageHeader
                title={viewTitle(view, activeChannel, dmPartnerName)}
                subtitle={subtitle}
                onBack={onBack}
                action={action}
            />
        );
    },
);

ChatHeader.displayName = 'ChatHeader';
