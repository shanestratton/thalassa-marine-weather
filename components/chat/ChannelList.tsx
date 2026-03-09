/**
 * ChannelList — Channel directory with sub-channel support.
 * Parent channels expand/collapse to show nested sub-channels.
 * Sub-channel cards are indented and smaller.
 */
import React, { useState } from 'react';
import type { ChatChannel } from '../../services/ChatService';

// --- Client-side display overrides ---
const ICON_OVERRIDES: Record<string, string> = {
    'SOLAS': '🛟',
    'Safety': '🛟',
    'Find Crew': '👥',
};
const NAME_OVERRIDES: Record<string, string> = {
    'Find Crew': 'Crew Finder',
};
const getChannelIcon = (ch: { name: string; icon: string }) =>
    ICON_OVERRIDES[ch.name] ?? ch.icon;
const getChannelName = (ch: { name: string }) =>
    NAME_OVERRIDES[ch.name] ?? ch.name;

const CHANNEL_PRIORITY: Record<string, number> = {
    'Marketplace': 0,
    'Find Crew': 1,
    'General': 2,
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
}

export const ChannelList: React.FC<ChannelListProps> = ({
    channels,
    onOpenChannel,
    onRequestAccess,
    isMod,
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
}) => {
    const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

    const toggleExpand = (parentId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpandedParents(prev => {
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
    const topLevel = channels
        .filter(ch => ch.name !== 'Lonely Hearts' && !ch.parent_id)
        .sort((a, b) => (CHANNEL_PRIORITY[a.name] ?? 99) - (CHANNEL_PRIORITY[b.name] ?? 99));

    const subChannelMap = new Map<string, ChatChannel[]>();
    channels.filter(ch => ch.parent_id).forEach(ch => {
        const subs = subChannelMap.get(ch.parent_id!) || [];
        subs.push(ch);
        subChannelMap.set(ch.parent_id!, subs);
    });

    // Top-level channels that can be parents (for proposal dropdown)
    const parentOptions = topLevel.filter(ch => ch.name !== 'Marketplace' && ch.name !== 'Find Crew');

    const renderChannelCard = (ch: ChatChannel, isSub: boolean, index: number) => {
        const isPrivateLocked = ch.is_private && !memberChannelIds.has(ch.id) && !isAdmin;
        const subs = subChannelMap.get(ch.id) || [];
        const hasSubs = subs.length > 0;
        const isExpanded = expandedParents.has(ch.id);

        return (
            <div key={ch.id}>
                <div className={`flex items-center ${isSub ? 'pl-6' : ''}`}>
                    {/* Sub-channel connector line */}
                    {isSub && (
                        <div className="absolute left-[2.4rem] w-3 h-[1px] bg-white/[0.06]" />
                    )}
                    <button
                        onClick={() => handleChannelClick(ch)}
                        aria-label={`${getChannelName(ch)}${ch.is_private ? ' — Private channel' : ''}${isPrivateLocked ? ' — Request access' : ''}`}
                        className={`w-full group flex items-center gap-3 ${isSub ? 'p-3' : 'p-3.5'} rounded-2xl transition-all duration-200 card-press stagger-item min-h-[${isSub ? '48' : '56'}px] ${isPrivateLocked
                            ? 'bg-white/[0.01] border border-white/[0.04] opacity-70'
                            : isSub
                                ? 'bg-white/[0.015] hover:bg-white/[0.04] border border-white/[0.02] hover:border-white/[0.06]'
                                : 'bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.03] hover:border-white/[0.08]'
                            }`}
                        style={!isSub ? { animationDelay: `${index * 40}ms` } : undefined}
                    >
                        {/* Icon */}
                        <div className={`${isSub ? 'w-8 h-8 text-base' : 'w-11 h-11 text-xl'} rounded-xl bg-gradient-to-br border flex items-center justify-center group-hover:scale-110 transition-transform duration-200 ${ch.is_private
                            ? 'from-purple-500/[0.12] to-indigo-500/[0.05] border-purple-500/20'
                            : 'from-white/[0.06] to-white/[0.02] border-white/[0.05]'
                            }`}>
                            {ch.is_private ? '🔒' : getChannelIcon(ch)}
                        </div>

                        {/* Name + description */}
                        <div className="text-left flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                                <p className={`${isSub ? 'text-sm' : 'text-lg'} font-semibold text-white/85 group-hover:text-white transition-colors`}>{getChannelName(ch)}</p>
                                {ch.is_private && (
                                    <span className="text-[11px] font-bold text-purple-400/70 bg-purple-500/10 px-1.5 py-0.5 rounded-full">PRIVATE</span>
                                )}
                            </div>
                            <p className={`${isSub ? 'text-[11px]' : 'text-sm'} text-white/60 truncate ${isSub ? '' : 'mt-0.5'}`}>
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
                                    <span className={`text-white/40 text-[11px] transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                                </button>
                            )}
                            <div className="w-6 h-6 rounded-full bg-white/[0.03] group-hover:bg-white/[0.06] flex items-center justify-center transition-all group-hover:translate-x-0.5">
                                <span className="text-white/15 group-hover:text-white/60 text-xs transition-colors">
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
                    onClick={onOpenAdmin}
                    className="w-full group flex items-center gap-3.5 p-3.5 rounded-2xl bg-gradient-to-r from-amber-500/[0.08] to-yellow-500/[0.04] hover:from-amber-500/[0.15] hover:to-yellow-500/[0.08] border border-amber-500/20 hover:border-amber-500/40 transition-all duration-200 active:scale-[0.98] mb-3"
                >
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500/20 to-yellow-600/10 border border-amber-500/30 flex items-center justify-center text-xl group-hover:scale-110 transition-transform duration-200">
                        👑
                    </div>
                    <div className="text-left flex-1 min-w-0">
                        <p className="text-lg font-semibold text-amber-400/90 group-hover:text-amber-300 transition-colors">Admin Panel</p>
                        <p className="text-sm text-amber-400/40 truncate mt-0.5">Manage roles, mute & block users</p>
                    </div>
                    <div className="w-6 h-6 rounded-full bg-amber-500/10 group-hover:bg-amber-500/20 flex items-center justify-center transition-all group-hover:translate-x-0.5">
                        <span className="text-amber-400/30 group-hover:text-amber-400/70 text-xs transition-colors">›</span>
                    </div>
                </button>
            )}

            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/60 px-1 mb-2">Channels</p>

            {/* Channel list with sub-channel grouping */}
            {topLevel.map((ch, i) => renderChannelCard(ch, false, i))}

            {/* Propose channel */}
            <div className="mt-4">
                {!showProposalForm ? (
                    <button
                        onClick={() => setShowProposalForm(true)}
                        aria-label="Propose a new channel"
                        className="w-full p-4 rounded-2xl border border-dashed border-white/[0.06] hover:border-sky-500/20 hover:bg-sky-500/[0.03] text-center transition-all duration-200 active:scale-[0.98] min-h-[52px]"
                    >
                        <span className="text-xs text-white/30">➕ Propose a new channel</span>
                    </button>
                ) : (() => {
                    // Multi-step proposal wizard
                    const [proposalStep, setProposalStep] = React.useState(1);
                    const canProceed1 = proposalName.trim().length > 0;

                    return (
                        <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-4 fade-slide-down">
                            {/* Step indicator */}
                            <div className="flex items-center gap-2">
                                <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-sky-400/50">📋 Step {proposalStep} of 3</p>
                                <div className="flex-1" />
                                <div className="flex gap-1">
                                    {[1, 2, 3].map(s => (
                                        <div key={s} className={`w-2 h-2 rounded-full transition-all duration-200 ${s === proposalStep ? 'bg-sky-400 scale-110' : s < proposalStep ? 'bg-sky-400/40' : 'bg-white/[0.08]'}`} />
                                    ))}
                                </div>
                            </div>

                            {/* Step 1: Name & Description */}
                            {proposalStep === 1 && (
                                <div className="space-y-3 fade-slide-down">
                                    <p className="text-sm font-semibold text-white/70">What's your channel about?</p>
                                    <div className="flex gap-2">
                                        <input value={proposalIcon} onChange={e => setProposalIcon(e.target.value)} placeholder="🏖️" aria-label="Channel icon" className="w-12 bg-white/[0.04] border border-white/[0.06] rounded-lg px-2 py-2.5 text-center text-lg min-h-[44px]" maxLength={2} />
                                        <input value={proposalName} onChange={e => setProposalName(e.target.value)} placeholder="Channel name" aria-label="Channel name" className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 min-h-[44px]" />
                                    </div>
                                    <input value={proposalDesc} onChange={e => setProposalDesc(e.target.value)} placeholder="Short description (optional)" aria-label="Channel description" className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30 min-h-[44px]" />
                                    <div className="flex gap-2">
                                        <button onClick={() => { setShowProposalForm(false); setProposalParentId(null); }} aria-label="Cancel" className="flex-1 py-3 rounded-xl bg-white/[0.03] text-xs text-white/60 hover:bg-white/[0.06] transition-colors min-h-[44px]">Cancel</button>
                                        <button onClick={() => setProposalStep(2)} disabled={!canProceed1} aria-label="Next step" className="flex-1 py-3 rounded-xl bg-sky-500/15 text-xs text-sky-400 font-semibold hover:bg-sky-500/25 disabled:opacity-30 transition-colors min-h-[44px]">Next →</button>
                                    </div>
                                </div>
                            )}

                            {/* Step 2: Options */}
                            {proposalStep === 2 && (
                                <div className="space-y-3 fade-slide-down">
                                    <p className="text-sm font-semibold text-white/70">Channel settings</p>

                                    {/* Parent channel selector */}
                                    <div>
                                        <p className="text-[11px] text-white/30 mb-1.5 px-1">Parent Channel</p>
                                        <div className="flex gap-1.5 flex-wrap">
                                            <button
                                                onClick={() => setProposalParentId(null)}
                                                className={`px-3 py-2.5 rounded-lg text-[11px] font-bold transition-all active:scale-95 min-h-[44px] ${!proposalParentId
                                                    ? 'bg-sky-500/20 border border-sky-500/40 text-sky-400'
                                                    : 'bg-white/[0.04] border border-white/[0.06] text-white/40'
                                                    }`}
                                            >
                                                📌 Top-Level
                                            </button>
                                            {parentOptions.map(p => (
                                                <button
                                                    key={p.id}
                                                    onClick={() => setProposalParentId(p.id)}
                                                    className={`px-3 py-2.5 rounded-lg text-[11px] font-bold transition-all active:scale-95 min-h-[44px] ${proposalParentId === p.id
                                                        ? 'bg-sky-500/20 border border-sky-500/40 text-sky-400'
                                                        : 'bg-white/[0.04] border border-white/[0.06] text-white/40'
                                                        }`}
                                                >
                                                    {p.icon} {p.name}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Public / Private toggle */}
                                    <div>
                                        <p className="text-[11px] text-white/30 mb-1.5 px-1">Visibility</p>
                                        <div className="flex gap-1.5">
                                            <button
                                                onClick={() => setProposalIsPrivate(false)}
                                                className={`flex-1 py-3 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 min-h-[44px] ${!proposalIsPrivate
                                                    ? 'bg-sky-500/20 border-sky-500/40 text-sky-400'
                                                    : 'bg-white/[0.04] border-white/[0.06] text-white/40'
                                                    }`}
                                            >
                                                🌊 Public
                                            </button>
                                            <button
                                                onClick={() => setProposalIsPrivate(true)}
                                                className={`flex-1 py-3 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 min-h-[44px] ${proposalIsPrivate
                                                    ? 'bg-purple-500/20 border-purple-500/40 text-purple-400'
                                                    : 'bg-white/[0.04] border-white/[0.06] text-white/40'
                                                    }`}
                                            >
                                                🔒 Private
                                            </button>
                                        </div>
                                    </div>

                                    {proposalIsPrivate && (
                                        <p className="text-[11px] text-purple-400/50 px-1">
                                            Private channels require approval to join. You'll moderate who gets in.
                                        </p>
                                    )}

                                    <div className="flex gap-2">
                                        <button onClick={() => setProposalStep(1)} aria-label="Go back" className="flex-1 py-3 rounded-xl bg-white/[0.03] text-xs text-white/60 hover:bg-white/[0.06] transition-colors min-h-[44px]">← Back</button>
                                        <button onClick={() => setProposalStep(3)} aria-label="Review" className="flex-1 py-3 rounded-xl bg-sky-500/15 text-xs text-sky-400 font-semibold hover:bg-sky-500/25 transition-colors min-h-[44px]">Review →</button>
                                    </div>
                                </div>
                            )}

                            {/* Step 3: Review & Submit */}
                            {proposalStep === 3 && (
                                <div className="space-y-3 fade-slide-down">
                                    <p className="text-sm font-semibold text-white/70">Review your channel</p>

                                    {/* Preview card */}
                                    <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.05] space-y-2">
                                        <div className="flex items-center gap-2.5">
                                            <span className="text-xl">{proposalIcon || '💬'}</span>
                                            <div>
                                                <p className="text-sm font-bold text-white/80">{proposalName}</p>
                                                <p className="text-[11px] text-white/40">{proposalDesc || 'No description'}</p>
                                            </div>
                                        </div>
                                        <div className="flex gap-1.5">
                                            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${proposalIsPrivate ? 'text-purple-400/70 bg-purple-500/10' : 'text-sky-400/70 bg-sky-500/10'}`}>
                                                {proposalIsPrivate ? '🔒 Private' : '🌊 Public'}
                                            </span>
                                            <span className="text-[11px] font-bold text-white/30 bg-white/[0.04] px-2 py-0.5 rounded-full">
                                                {proposalParentId ? `Sub of ${parentOptions.find(p => p.id === proposalParentId)?.name || '?'}` : '📌 Top-Level'}
                                            </span>
                                        </div>
                                    </div>

                                    <p className="text-[11px] text-white/25 text-center">
                                        {isAdmin ? 'This channel will be created instantly.' : 'Submitted to admins for approval. You\'ll moderate it!'}
                                    </p>

                                    <div className="flex gap-2">
                                        <button onClick={() => setProposalStep(2)} aria-label="Go back" className="flex-1 py-3 rounded-xl bg-white/[0.03] text-xs text-white/60 hover:bg-white/[0.06] transition-colors min-h-[44px]">← Back</button>
                                        <button onClick={onProposeChannel} disabled={!proposalName.trim()} aria-label="Submit channel proposal" className="flex-1 py-3 rounded-xl bg-sky-500/15 text-xs text-sky-400 font-semibold hover:bg-sky-500/25 disabled:opacity-30 transition-colors min-h-[44px]">
                                            {proposalSent ? '✓ Submitted!' : isAdmin ? '⚡ Create Channel' : '📋 Submit for Review'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })()}
            </div>
        </div>
    );
};

export default ChannelList;
