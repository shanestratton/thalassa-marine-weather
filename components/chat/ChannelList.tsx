/**
 * ChannelList — Channel directory with sub-channel support.
 * Parent channels expand/collapse to show nested sub-channels.
 * Sub-channel cards are indented and smaller.
 */
import React, { useState } from 'react';
import type { ChatChannel } from '../../services/ChatService';
import { ChannelProposalModal } from './ChannelProposalModal';

// --- Client-side display overrides ---
const ICON_OVERRIDES: Record<string, string> = {
    SOLAS: '🛟',
    Safety: '🛟',
    'Find Crew': '👥',
};
const NAME_OVERRIDES: Record<string, string> = {
    'Find Crew': 'Crew Finder',
};
const getChannelIcon = (ch: { name: string; icon: string }) => ICON_OVERRIDES[ch.name] ?? ch.icon;
const getChannelName = (ch: { name: string }) => NAME_OVERRIDES[ch.name] ?? ch.name;

const CHANNEL_PRIORITY: Record<string, number> = {
    Chandlery: 0,
    Marketplace: 0,
    'Neighbourhood Watch': 1,
    'Find Crew': 2,
    General: 3,
};

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
    onOpenCaptainsTable?: () => void;
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
    onOpenCaptainsTable,
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
    const topLevel = channels
        .filter((ch) => ch.name !== 'Lonely Hearts' && !ch.parent_id && !(ch.is_private && ch.icon === '👥'))
        .sort((a, b) => (CHANNEL_PRIORITY[a.name] ?? 99) - (CHANNEL_PRIORITY[b.name] ?? 99));

    const subChannelMap = new Map<string, ChatChannel[]>();
    channels
        .filter((ch) => ch.parent_id)
        .forEach((ch) => {
            const subs = subChannelMap.get(ch.parent_id!) || [];
            subs.push(ch);
            subChannelMap.set(ch.parent_id!, subs);
        });

    // Top-level channels that can be parents (for proposal dropdown)
    const parentOptions = topLevel.filter(
        (ch) => ch.name !== 'Marketplace' && ch.name !== 'Chandlery' && ch.name !== 'Find Crew',
    );

    const renderChannelCard = (ch: ChatChannel, isSub: boolean, _index: number) => {
        const isPrivateLocked = ch.is_private && !memberChannelIds.has(ch.id) && !isAdmin;
        const subs = subChannelMap.get(ch.id) || [];
        const hasSubs = subs.length > 0;
        const isExpanded = expandedParents.has(ch.id);

        return (
            <div key={ch.id}>
                <div className={`flex items-center ${isSub ? 'pl-6' : ''}`}>
                    {/* Sub-channel connector line */}
                    {isSub && <div className="absolute left-[2.4rem] w-3 h-[1px] bg-white/[0.06]" />}
                    <button
                        onClick={() => handleChannelClick(ch)}
                        aria-label={`${getChannelName(ch)}${ch.is_private ? ' — Private channel' : ''}${isPrivateLocked ? ' — Request access' : ''}`}
                        className={`w-full group flex items-center gap-3 ${isSub ? 'p-3' : 'p-3.5'} rounded-2xl transition-all duration-200 card-press stagger-item min-h-[${isSub ? '48' : '56'}px] ${
                            isPrivateLocked
                                ? 'bg-white/[0.01] border border-white/[0.04] opacity-70'
                                : isSub
                                  ? 'bg-white/[0.015] hover:bg-white/[0.04] border border-white/[0.02] hover:border-white/[0.06]'
                                  : 'bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.03] hover:border-white/[0.08]'
                        }`}
                        style={undefined}
                    >
                        {/* Icon */}
                        <div
                            className={`${isSub ? 'w-8 h-8 text-base' : 'w-11 h-11 text-xl'} rounded-xl bg-gradient-to-br border flex items-center justify-center group-hover:scale-110 transition-transform duration-200 ${
                                ch.is_private
                                    ? 'from-purple-500/[0.12] to-indigo-500/[0.05] border-purple-500/20'
                                    : 'from-white/[0.06] to-white/[0.02] border-white/[0.05]'
                            }`}
                        >
                            {ch.is_private ? '🔒' : getChannelIcon(ch)}
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
                                    <span className="text-[11px] font-bold text-purple-400/70 bg-purple-500/10 px-1.5 py-0.5 rounded-full">
                                        PRIVATE
                                    </span>
                                )}
                            </div>
                            <p
                                className={`${isSub ? 'text-[11px]' : 'text-sm'} text-white/60 truncate ${isSub ? '' : 'mt-0.5'}`}
                            >
                                {isPrivateLocked ? '🔒 Request access to join' : ch.description}
                            </p>
                        </div>

                        {/* Expand arrow (for parents with subs) or chevron */}
                        <div className="flex items-center gap-1">
                            {!isSub && hasSubs && (
                                <button
                                    onClick={(e) => toggleExpand(ch.id, e)}
                                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${getChannelName(ch)} sub-channels`}
                                    aria-expanded={isExpanded}
                                    className="w-8 h-8 rounded-full bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-all min-h-[44px] min-w-[44px]"
                                >
                                    <span
                                        className={`text-white/40 text-[11px] transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                                    >
                                        ▼
                                    </span>
                                </button>
                            )}
                            <div className="w-6 h-6 rounded-full bg-white/[0.03] group-hover:bg-white/[0.06] flex items-center justify-center transition-all group-hover:translate-x-0.5">
                                <span className="text-white/40 group-hover:text-white/60 text-xs transition-colors">
                                    {isPrivateLocked ? '🔒' : '›'}
                                </span>
                            </div>
                        </div>
                    </button>
                </div>

                {/* Sub-channels (indented, smaller) */}
                {!isSub && isExpanded && subs.length > 0 && (
                    <div className="relative ml-4 mt-1 mb-1 space-y-1 border-l border-white/[0.04] pl-0">
                        {subs.map((sub, si) => renderChannelCard(sub, true, si))}
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
                    className="w-full group flex items-center gap-3.5 p-3.5 rounded-2xl bg-gradient-to-r from-amber-500/[0.08] to-yellow-500/[0.04] hover:from-amber-500/[0.15] hover:to-yellow-500/[0.08] border border-amber-500/20 hover:border-amber-500/40 transition-all duration-200 active:scale-[0.98] mb-3"
                >
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500/20 to-yellow-600/10 border border-amber-500/30 flex items-center justify-center text-xl group-hover:scale-110 transition-transform duration-200">
                        👑
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

            {/* ── Crew Chat (Private Group) — only visible to voyage crew ── */}
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
                        const voyageName =
                            voyage?.voyage_name || (voyage?.departure_port && voyage?.destination_port)
                                ? `${voyage?.departure_port} → ${voyage?.destination_port}`
                                : 'Crew Chat';

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
                className="w-full group flex items-center gap-3.5 p-3.5 rounded-2xl bg-gradient-to-r from-emerald-500/[0.06] to-teal-500/[0.03] hover:from-emerald-500/[0.12] hover:to-teal-500/[0.06] border border-emerald-500/15 hover:border-emerald-500/30 transition-all duration-200 active:scale-[0.98] mb-3"
            >
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-600/10 border border-emerald-500/25 flex items-center justify-center text-xl group-hover:scale-110 transition-transform duration-200">
                    👥
                </div>
                <div className="text-left flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <p className="text-lg font-semibold text-white/85 group-hover:text-white transition-colors">
                            Crew Chat
                        </p>
                        <span className="text-[11px] font-bold text-emerald-400/70 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">
                            PRIVATE GROUP
                        </span>
                    </div>
                    <p className="text-sm text-white/60 truncate mt-0.5">
                        Only visible to crew on the{' '}
                        {(() => {
                            try {
                                const s = localStorage.getItem('CapacitorStorage.thalassa_settings');
                                return s ? JSON.parse(s)?.vessel?.name || 'vessel' : 'vessel';
                            } catch {
                                return 'vessel';
                            }
                        })()}
                    </p>
                </div>
                <div className="w-6 h-6 rounded-full bg-emerald-500/10 group-hover:bg-emerald-500/20 flex items-center justify-center transition-all group-hover:translate-x-0.5">
                    <span className="text-emerald-400/30 group-hover:text-emerald-400/70 text-xs transition-colors">
                        ›
                    </span>
                </div>
            </button>

            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/60 px-1 mb-2">Channels</p>

            {/* Channel list — split to inject Captain's Table after Find Crew */}
            {topLevel
                .filter((ch) => (CHANNEL_PRIORITY[ch.name] ?? 99) <= 2)
                .map((ch, i) => renderChannelCard(ch, false, i))}

            {/* ── The Captain's Table (between Find Crew and General) ── */}
            {onOpenCaptainsTable && (
                <button
                    onClick={onOpenCaptainsTable}
                    className="w-full group flex items-center gap-3 p-3.5 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.03] hover:border-white/[0.08] transition-all duration-200 active:scale-[0.98]"
                    aria-label="The Captain's Table — Community Recipe Hub"
                >
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-white/[0.06] to-white/[0.02] border border-white/[0.05] flex items-center justify-center text-xl group-hover:scale-110 transition-transform duration-200">
                        ☸
                    </div>
                    <div className="text-left flex-1 min-w-0">
                        <p className="text-lg font-semibold text-white/85 group-hover:text-white transition-colors">
                            The Captain's Table
                        </p>
                        <p className="text-sm text-white/60 truncate mt-0.5">Community recipes · Share & rate</p>
                    </div>
                    <div className="w-6 h-6 rounded-full bg-white/[0.03] group-hover:bg-white/[0.06] flex items-center justify-center transition-all group-hover:translate-x-0.5">
                        <span className="text-white/40 group-hover:text-white/60 text-xs transition-colors">›</span>
                    </div>
                </button>
            )}

            {topLevel
                .filter((ch) => (CHANNEL_PRIORITY[ch.name] ?? 99) > 2)
                .map((ch, i) => renderChannelCard(ch, false, i))}

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
