/**
 * ChannelList — Channel directory with sub-channel support.
 * Parent channels expand/collapse to show nested sub-channels.
 * Sub-channel cards are indented and smaller.
 */
import React, { useMemo, useState } from 'react';
import type { ChatChannel } from '../../services/ChatService';
import { ChannelProposalModal } from './ChannelProposalModal';
import { FEATURE_VISIBILITY } from '../../utils/featureVisibility';
import { ChannelGlyph, getChannelName } from './channelIcons';
import { ChatIcon, LockIcon, StarIcon, UsersIcon } from '../Icons';
import { EmptyState } from '../ui/EmptyState';

// Channels hidden from the directory. 'Lonely Hearts' is a legacy alias, and
// 'Chandlery'/'Marketplace' are retired features whose channels may still
// exist on older accounts — both are unconditional now that the surface is
// gone. The Crew List keeps its deliberate launch-visibility flag; see
// utils/featureVisibility.
const HIDDEN_CHANNEL_NAMES = new Set<string>([
    'Lonely Hearts',
    'Chandlery',
    'Marketplace',
    ...(FEATURE_VISIBILITY.crewFinder ? [] : ['Find Crew']),
]);

// Display names and glyphs live in ./channelIcons (shared with the header).

/* Chandlery and Marketplace are not listed: HIDDEN_CHANNEL_NAMES removes them
   before this sort ever runs, so their priorities could never be read. */
const CHANNEL_PRIORITY: Record<string, number> = {
    'Neighbourhood Watch': 1,
    'Find Crew': 2,
    General: 3,
};

/* Display wording for a stored channel description, by channel name. The
   Neighbourhood Watch line opened "Maritime safety alerts", which reads like
   official safety information on a channel that is sailors' own chat (UX
   scorecard run 10, copy-nits-bundle). The stored row is left alone. */
const DESCRIPTION_OVERRIDES: Record<string, string> = {
    'Neighbourhood Watch': 'Sailors’ own reports: suspicious activity and local hazards',
};
const channelDescription = (ch: ChatChannel) => DESCRIPTION_OVERRIDES[ch.name] ?? ch.description;

interface ChannelListProps {
    channels: ChatChannel[];
    onOpenChannel: (channel: ChatChannel) => void;
    onRequestAccess: (channel: ChatChannel) => void;
    isMod: boolean;
    showProposalForm: boolean;
    setShowProposalForm: (show: boolean) => void;
    proposalIcon: string;
    setProposalIcon: (icon: string) => void;
    proposalName: string;
    setProposalName: (name: string) => void;
    proposalDesc: string;
    setProposalDesc: (desc: string) => void;
    proposalIsPrivate: boolean;
    setProposalIsPrivate: (v: boolean) => void;
    proposalSent: boolean;
    onProposeChannel: () => void;
    isAdmin?: boolean;
    onOpenAdmin?: () => void;
    memberChannelIds: Set<string>;
    /** Parent channel ID for sub-channel proposals */
    proposalParentId: string | null;
    setProposalParentId: (id: string | null) => void;
    /** Whether the skipper has invited crew or the user is on a crew — gates the Crew Chat button */
    hasCrewInvited?: boolean;
    /** Vessel name from settings — shown in the Crew Chat subtitle. */
    vesselName?: string;
}

const ChannelListInner: React.FC<ChannelListProps> = ({
    channels,
    onOpenChannel,
    onRequestAccess,
    isMod: _isMod,
    showProposalForm,
    setShowProposalForm,
    proposalIcon,
    setProposalIcon,
    proposalName,
    setProposalName,
    proposalDesc,
    setProposalDesc,
    proposalIsPrivate,
    setProposalIsPrivate,
    proposalSent,
    onProposeChannel,
    isAdmin,
    onOpenAdmin,
    memberChannelIds,
    proposalParentId,
    setProposalParentId,
    hasCrewInvited = false,
    vesselName,
}) => {
    const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

    const toggleExpand = (parentId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpandedParents((prev) => {
            const next = new Set(prev);
            if (next.has(parentId)) next.delete(parentId);
            else next.add(parentId);
            return next;
        });
    };

    const handleChannelClick = (ch: ChatChannel) => {
        if (ch.is_private && !memberChannelIds.has(ch.id) && !isAdmin) {
            onRequestAccess(ch);
        } else {
            onOpenChannel(ch);
        }
    };

    // Separate top-level and sub-channels
    // Exclude voyage crew channels (private + 👥 icon) — they're handled by the dedicated Crew Chat button
    // Exclude launch-hidden features (Marketplace / The Crew List) — see
    // utils/featureVisibility. Hiding the channel removes the only path
    // into the ChandleryPage / LonelyHeartsPage views (openChannel
    // routes on channel name), so the pages stay code-complete but
    // unreachable until we flip the flag.
    /* Memoised on `channels`: this list re-renders on every expand/collapse and
       on every keystroke in the proposal form (its inputs are controlled from
       props), and none of that changes the channel set. */
    const topLevel = useMemo(
        () =>
            channels
                .filter(
                    (ch) => !HIDDEN_CHANNEL_NAMES.has(ch.name) && !ch.parent_id && !(ch.is_private && ch.icon === '👥'),
                )
                .sort((a, b) => (CHANNEL_PRIORITY[a.name] ?? 99) - (CHANNEL_PRIORITY[b.name] ?? 99)),
        [channels],
    );

    const subChannelMap = useMemo(() => {
        const map = new Map<string, ChatChannel[]>();
        channels
            .filter((ch) => ch.parent_id)
            .forEach((ch) => {
                const subs = map.get(ch.parent_id!) || [];
                subs.push(ch);
                map.set(ch.parent_id!, subs);
            });
        return map;
    }, [channels]);

    // Top-level channels that can be parents (for proposal dropdown).
    // Marketplace and Chandlery are already gone from topLevel — see above.
    const parentOptions = useMemo(() => topLevel.filter((ch) => ch.name !== 'Find Crew'), [topLevel]);

    const renderChannelCard = (ch: ChatChannel, isSub: boolean) => {
        const isPrivateLocked = ch.is_private && !memberChannelIds.has(ch.id) && !isAdmin;
        const subs = subChannelMap.get(ch.id) || [];
        const hasSubs = subs.length > 0;
        const isExpanded = expandedParents.has(ch.id);

        return (
            <div key={ch.id}>
                {/* The expand toggle is a SIBLING of the card, not a child of it:
                    a <button> inside a <button> is invalid, WebKit rewrites the
                    markup, and VoiceOver announces the pair as one control. */}
                <div className={`flex items-center gap-1 ${isSub ? 'pl-6' : ''}`}>
                    {/* Sub-channel connector line */}
                    {isSub && <div className="absolute left-[2.4rem] w-3 h-px bg-white/6" />}
                    <button
                        onClick={() => handleChannelClick(ch)}
                        aria-label={`${getChannelName(ch)}${ch.is_private ? ' — Private channel' : ''}${isPrivateLocked ? ' — Request access' : ''}`}
                        aria-describedby={isPrivateLocked ? undefined : `channel-desc-${ch.id}`}
                        className={`flex-1 min-w-0 group flex items-center gap-3 ${isSub ? 'p-3 min-h-[48px]' : 'p-3.5 min-h-[56px]'} rounded-2xl transition-all duration-200 card-press stagger-item ${
                            isPrivateLocked
                                ? 'bg-white/1 border border-white/4 opacity-70'
                                : isSub
                                  ? 'bg-white/1.5 hover:bg-white/4 border border-white/2 hover:border-white/6'
                                  : 'bg-white/2 hover:bg-white/5 border border-white/3 hover:border-white/8'
                        }`}
                    >
                        {/* Icon — a stroke glyph in a tinted chip, decorative */}
                        <div
                            aria-hidden="true"
                            className={`${isSub ? 'w-8 h-8 text-base' : 'w-11 h-11 text-xl'} shrink-0 rounded-xl bg-linear-to-br border flex items-center justify-center group-hover:scale-110 transition-transform duration-200 ${
                                ch.is_private
                                    ? 'from-purple-500/12 to-indigo-500/5 border-purple-500/20 text-purple-300'
                                    : 'from-sky-500/12 to-sky-500/4 border-sky-400/15 text-sky-300'
                            }`}
                        >
                            <ChannelGlyph channel={ch} className={isSub ? 'h-4 w-4' : 'h-5 w-5'} />
                        </div>

                        {/* Name + description */}
                        <div className="text-left flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                                <p
                                    className={`${isSub ? 'text-sm' : 'text-lg'} font-semibold text-white/85 group-hover:text-white transition-colors`}
                                >
                                    {getChannelName(ch)}
                                </p>
                                {ch.is_private && (
                                    <span className="text-xs font-bold text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded-full">
                                        PRIVATE
                                    </span>
                                )}
                            </div>
                            <p
                                id={`channel-desc-${ch.id}`}
                                className={`${isSub ? 'text-xs' : 'text-sm'} text-white/60 line-clamp-2 ${isSub ? '' : 'mt-0.5'}`}
                            >
                                {isPrivateLocked ? 'Request access to join' : channelDescription(ch)}
                            </p>
                        </div>

                        {/* Open chevron */}
                        <div
                            aria-hidden="true"
                            className="w-6 h-6 shrink-0 rounded-full bg-white/3 group-hover:bg-white/6 flex items-center justify-center transition-all group-hover:translate-x-0.5"
                        >
                            {isPrivateLocked ? (
                                <LockIcon className="h-3 w-3 text-white/60" />
                            ) : (
                                <span className="text-white/40 group-hover:text-white/60 text-xs transition-colors">
                                    ›
                                </span>
                            )}
                        </div>
                    </button>

                    {/* Expand arrow — parents with sub-channels only */}
                    {!isSub && hasSubs && (
                        <button
                            onClick={(e) => toggleExpand(ch.id, e)}
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${getChannelName(ch)} sub-channels`}
                            aria-expanded={isExpanded}
                            className="shrink-0 min-h-[44px] min-w-[44px] rounded-full bg-white/4 hover:bg-white/8 flex items-center justify-center transition-all"
                        >
                            <span
                                aria-hidden="true"
                                className={`text-white/40 text-xs transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                            >
                                ▼
                            </span>
                        </button>
                    )}
                </div>

                {/* Sub-channels (indented, smaller) */}
                {!isSub && isExpanded && subs.length > 0 && (
                    <div className="relative ml-4 mt-1 mb-1 space-y-1 border-l border-white/4 pl-0">
                        {subs.map((sub) => renderChannelCard(sub, true))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="px-4 py-3 pb-24 space-y-1.5">
            {/* Admin Panel — gold crown card */}
            {isAdmin && onOpenAdmin && (
                <button
                    aria-label="Open Admin"
                    onClick={onOpenAdmin}
                    className="w-full group flex items-center gap-3.5 p-3.5 rounded-2xl bg-linear-to-r from-amber-500/8 to-yellow-500/4 hover:from-amber-500/15 hover:to-yellow-500/8 border border-amber-500/20 hover:border-amber-500/40 transition-all duration-200 active:scale-[0.98] mb-3"
                >
                    <div
                        aria-hidden="true"
                        className="w-11 h-11 rounded-xl bg-linear-to-br from-amber-500/20 to-yellow-600/10 border border-amber-500/30 flex items-center justify-center text-amber-300 group-hover:scale-110 transition-transform duration-200"
                    >
                        <StarIcon className="h-5 w-5" />
                    </div>
                    <div className="text-left flex-1 min-w-0">
                        <p className="text-lg font-semibold text-amber-400/90 group-hover:text-amber-300 transition-colors">
                            Admin Panel
                        </p>
                        <p className="text-sm text-amber-400/40 truncate mt-0.5">Manage roles, mute & block users</p>
                    </div>
                    <div className="w-6 h-6 rounded-full bg-amber-500/10 group-hover:bg-amber-500/20 flex items-center justify-center transition-all group-hover:translate-x-0.5">
                        <span className="text-amber-400/30 group-hover:text-amber-400/70 text-xs transition-colors">
                            ›
                        </span>
                    </div>
                </button>
            )}

            {/* ── Crew Chat (Private Group) — only visible when crew have been invited ── */}
            {hasCrewInvited && (
                <button
                    aria-label="Crew Chat (Private Group)"
                    onClick={async () => {
                        try {
                            const { getActivePassageId } = await import('../../services/PassagePlanService');
                            const { getDraftVoyages } = await import('../../services/VoyageService');
                            const { ChatService } = await import('../../services/ChatService');

                            const passageId = getActivePassageId();
                            if (!passageId) {
                                const { toast } = await import('../Toast');
                                toast.error('Select a passage in Passage Planning first');
                                return;
                            }

                            const drafts = await getDraftVoyages();
                            const voyage = drafts.find((v) => v.id === passageId);
                            // Operator-precedence note: keep voyage_name preferred; fall back to
                            // a port pair only when no name is set.
                            const voyageName =
                                voyage?.voyage_name ||
                                (voyage?.departure_port && voyage?.destination_port
                                    ? `${voyage.departure_port} → ${voyage.destination_port}`
                                    : 'Crew Chat');

                            const channel = await ChatService.createVoyageChannel(passageId, voyageName);
                            if (channel) {
                                onOpenChannel(channel);
                            } else {
                                const { toast } = await import('../Toast');
                                toast.error('Sign in to use Crew Chat');
                            }
                        } catch (e) {
                            console.error('Crew chat error:', e);
                        }
                    }}
                    className="w-full group flex items-center gap-3.5 p-3.5 rounded-2xl bg-linear-to-r from-emerald-500/6 to-teal-500/3 hover:from-emerald-500/12 hover:to-teal-500/6 border border-emerald-500/15 hover:border-emerald-500/30 transition-all duration-200 active:scale-[0.98] mb-3"
                >
                    <div
                        aria-hidden="true"
                        className="w-11 h-11 rounded-xl bg-linear-to-br from-emerald-500/20 to-teal-600/10 border border-emerald-500/25 flex items-center justify-center text-emerald-300 group-hover:scale-110 transition-transform duration-200"
                    >
                        <UsersIcon className="h-5 w-5" />
                    </div>
                    <div className="text-left flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                            <p className="text-lg font-semibold text-white/85 group-hover:text-white transition-colors">
                                Crew Chat
                            </p>
                            <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                                PRIVATE GROUP
                            </span>
                        </div>
                        <p className="text-sm text-white/60 truncate mt-0.5">
                            Only visible to crew on the {vesselName || 'vessel'}
                        </p>
                    </div>
                    <div className="w-6 h-6 rounded-full bg-emerald-500/10 group-hover:bg-emerald-500/20 flex items-center justify-center transition-all group-hover:translate-x-0.5">
                        <span className="text-emerald-400/30 group-hover:text-emerald-400/70 text-xs transition-colors">
                            ›
                        </span>
                    </div>
                </button>
            )}

            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-white/60 px-1 mb-2">Channels</h2>

            {/* Channel list. Empty state added 2026-05-17 — before, when
                the channels API returned an empty array (rare but real:
                first launch before any channels seeded, or a filter
                state that hides everything), the list simply rendered
                nothing and the user saw a confusing blank pane. */}
            {topLevel.length === 0 ? (
                // The shared empty-state recipe, with its centred action (UX
                // scorecard run 7): the '+' this copy pointed at now lives in
                // the header's Page actions menu.
                <EmptyState
                    icon={<ChatIcon />}
                    title="No channels yet"
                    description="Channels appear here once sailors join Scuttlebutt. You can propose the first one."
                    actionLabel="Propose a channel"
                    onAction={() => setShowProposalForm(true)}
                />
            ) : (
                topLevel.map((ch) => renderChannelCard(ch, false))
            )}

            {/* Proposal Modal */}
            {showProposalForm && (
                <ChannelProposalModal
                    onClose={() => {
                        setShowProposalForm(false);
                        setProposalParentId(null);
                    }}
                    proposalIcon={proposalIcon}
                    setProposalIcon={setProposalIcon}
                    proposalName={proposalName}
                    setProposalName={setProposalName}
                    proposalDesc={proposalDesc}
                    setProposalDesc={setProposalDesc}
                    proposalIsPrivate={proposalIsPrivate}
                    setProposalIsPrivate={setProposalIsPrivate}
                    proposalSent={proposalSent}
                    onProposeChannel={onProposeChannel}
                    isAdmin={isAdmin}
                    parentOptions={parentOptions}
                    proposalParentId={proposalParentId}
                    setProposalParentId={setProposalParentId}
                />
            )}
        </div>
    );
};

export const ChannelList = React.memo(ChannelListInner);
export default ChannelList;
