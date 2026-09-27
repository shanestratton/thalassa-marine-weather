/**
 * ChatHeader — Scuttlebutt's page header: back, title, and the view's actions.
 * Extracted from ChatPage to reduce monolith complexity.
 *
 * Built on the shared PageHeader (UX scorecard run 6). The hand-built bar
 * truncated the root title to 'SCUTTLEBU…' behind three 44 pt buttons and sat
 * on its own band in daylight; PageHeader steps the title down until the
 * whole word fits and sits on the page tint like every other page.
 *
 * The root list has ONE header action, the ⋮ Page actions menu the Binder
 * pages use (UX scorecard run 7). Its three icon buttons squeezed the title
 * to ~150 pt, and two of the glyphs misled: a paper plane read as 'send' and
 * a bare '+' as 'new post'. In the menu each action has words. Unread direct
 * messages still show on the ⋮ button itself, so the menu hides nothing.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { PageHeader } from '../ui/PageHeader';
import { ChatChannel } from '../../services/ChatService';
import { SafeImage } from '../ui/SafeImage';
import { useAuthStore } from '../../stores/authStore';
import { ChatIcon, ProhibitedIcon } from '../Icons';
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

/** The Binder pages' ⋮ trigger (DocumentsHub, InventoryList, …). */
const PAGE_ACTIONS_BUTTON =
    'relative flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-xl bg-white/5 p-2 transition-colors hover:bg-white/10';

/** One row of the Page actions menu: 44 pt, icon plus words. */
const MENU_ITEM =
    'flex min-h-[44px] w-full items-center gap-3 px-4 py-3 text-left text-sm text-white transition-colors hover:bg-white/5 focus-visible:bg-white/5';

/** Every row's icon sits in the same 24 pt slot, so the labels line up. */
const MENU_ICON_SLOT = 'relative flex h-6 w-6 shrink-0 items-center justify-center text-sky-400';

const PlusGlyph: React.FC = () => (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
);

interface PageActionsMenuProps {
    myAvatarUrl: string | null;
    signedIn: boolean;
    unreadDMs: number;
    onOpenProfile: () => void;
    onOpenDMInbox: () => void;
    onPropose?: () => void;
}

/**
 * Scuttlebutt's ⋮ menu: direct messages, your profile, and proposing a
 * channel. Escape or a tap outside closes it and returns focus to ⋮.
 */
const PageActionsMenu: React.FC<PageActionsMenuProps> = ({
    myAvatarUrl,
    signedIn,
    unreadDMs,
    onOpenProfile,
    onOpenDMInbox,
    onPropose,
}) => {
    const [open, setOpen] = useState(false);
    const menuId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const unreadLabel = unreadDMs > 9 ? '9+' : String(unreadDMs);

    const close = (restoreFocus: boolean) => {
        setOpen(false);
        if (restoreFocus) triggerRef.current?.focus();
    };

    useEffect(() => {
        if (!open) return;
        menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
                return;
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
            if (items.length === 0) return;
            event.preventDefault();
            const at = items.indexOf(document.activeElement as HTMLElement);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            items[(at + step + items.length) % items.length].focus();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [open]);

    const choose = (action: () => void) => () => {
        close(false);
        action();
    };

    return (
        <div className="relative shrink-0">
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setOpen((was) => !was)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                aria-label={
                    unreadDMs > 0
                        ? `Page actions, ${unreadDMs} unread direct ${unreadDMs === 1 ? 'message' : 'messages'}`
                        : 'Page actions'
                }
                className={PAGE_ACTIONS_BUTTON}
            >
                <svg aria-hidden="true" className="h-5 w-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="1.5" />
                    <circle cx="12" cy="12" r="1.5" />
                    <circle cx="12" cy="19" r="1.5" />
                </svg>
                {unreadDMs > 0 && (
                    <span
                        aria-hidden="true"
                        className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-bold text-white shadow-lg shadow-red-500/30"
                    >
                        {unreadLabel}
                    </span>
                )}
            </button>
            {open && (
                <>
                    <div aria-hidden="true" className="fixed inset-0 z-40" onClick={() => close(false)} />
                    <div
                        ref={menuRef}
                        id={menuId}
                        role="menu"
                        aria-label="Scuttlebutt actions"
                        className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl border border-white/10 bg-slate-800 shadow-2xl"
                    >
                        <button
                            type="button"
                            role="menuitem"
                            onClick={choose(onOpenDMInbox)}
                            aria-label={unreadDMs > 0 ? `Direct messages, ${unreadDMs} unread` : 'Direct messages'}
                            className={MENU_ITEM}
                        >
                            <span aria-hidden="true" className={MENU_ICON_SLOT}>
                                <ChatIcon className="h-4 w-4" />
                            </span>
                            <span className="flex-1">Direct messages</span>
                            {unreadDMs > 0 && (
                                <span
                                    aria-hidden="true"
                                    className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-bold text-white"
                                >
                                    {unreadLabel}
                                </span>
                            )}
                        </button>
                        <div className="border-t border-white/5" />
                        <button type="button" role="menuitem" onClick={choose(onOpenProfile)} className={MENU_ITEM}>
                            <span aria-hidden="true" className={MENU_ICON_SLOT}>
                                {myAvatarUrl ? (
                                    <SafeImage
                                        src={myAvatarUrl}
                                        loading="lazy"
                                        alt=""
                                        className="h-6 w-6 rounded-full object-cover"
                                    />
                                ) : (
                                    // A person, not the anchor two channels also use.
                                    <span className="[&>svg]:h-4 [&>svg]:w-4">
                                        <UserIcon color="currentColor" />
                                    </span>
                                )}
                                {/* The presence dot is a claim about the skipper:
                                    only draw it when they are signed in to chat. */}
                                {signedIn && (
                                    <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-slate-800 bg-emerald-500 [.display-light_&]:border-slate-200" />
                                )}
                            </span>
                            <span className="flex-1">Your profile</span>
                        </button>
                        {onPropose && (
                            <>
                                <div className="border-t border-white/5" />
                                <button type="button" role="menuitem" onClick={choose(onPropose)} className={MENU_ITEM}>
                                    <span aria-hidden="true" className={MENU_ICON_SLOT}>
                                        <PlusGlyph />
                                    </span>
                                    <span className="flex-1">Propose a channel</span>
                                </button>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

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
                <PageActionsMenu
                    myAvatarUrl={myAvatarUrl}
                    signedIn={signedIn}
                    unreadDMs={unreadDMs}
                    onOpenProfile={onOpenProfile}
                    onOpenDMInbox={onOpenDMInbox}
                    onPropose={onPropose}
                />
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

        // Every Back names where it goes (UX scorecard run 8). The root list
        // leaves for the Vessel hub and wears the same VESSEL crumb as its twin
        // tile, Diary, so the two headers line up. Sub-views name their parent
        // on the chevron only: a crumb row there would cost the conversation
        // its height above the keyboard.
        const title = viewTitle(view, activeChannel, dmPartnerName);
        const breadcrumbs = view === 'channels' ? ['Vessel', title] : undefined;
        const backLabel =
            view === 'channels' ? undefined : view === 'dm_thread' ? 'Back to Messages' : 'Back to Scuttlebutt';

        return (
            <PageHeader
                title={title}
                subtitle={subtitle}
                onBack={onBack}
                action={action}
                breadcrumbs={breadcrumbs}
                backLabel={backLabel}
            />
        );
    },
);

ChatHeader.displayName = 'ChatHeader';
