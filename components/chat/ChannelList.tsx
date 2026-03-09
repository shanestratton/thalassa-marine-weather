/**
 * ChannelList — Channel directory listing for Crew Talk.
 * Extracted from ChatPage for component decomposition.
 */
import React from 'react';
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
    isMod: boolean;
    showProposalForm: boolean;
    setShowProposalForm: (show: boolean) => void;
    proposalIcon: string;
    setProposalIcon: (icon: string) => void;
    proposalName: string;
    setProposalName: (name: string) => void;
    proposalDesc: string;
    setProposalDesc: (desc: string) => void;
    proposalSent: boolean;
    onProposeChannel: () => void;
}

export const ChannelList: React.FC<ChannelListProps> = ({
    channels,
    onOpenChannel,
    isMod,
    showProposalForm,
    setShowProposalForm,
    proposalIcon,
    setProposalIcon,
    proposalName,
    setProposalName,
    proposalDesc,
    setProposalDesc,
    proposalSent,
    onProposeChannel,
}) => (
    <div className="px-4 py-3 pb-24 space-y-1.5">
        <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/60 px-1 mb-2">Channels</p>
        {channels
            .filter(ch => ch.name !== 'Lonely Hearts')
            .sort((a, b) => (CHANNEL_PRIORITY[a.name] ?? 99) - (CHANNEL_PRIORITY[b.name] ?? 99))
            .map((ch, i) => (
                <button
                    key={ch.id}
                    onClick={() => onOpenChannel(ch)}
                    className="w-full group flex items-center gap-3.5 p-3.5 rounded-2xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.03] hover:border-white/[0.08] transition-all duration-200 active:scale-[0.98]"
                    style={{ animationDelay: `${i * 40}ms` }}
                >
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-white/[0.06] to-white/[0.02] border border-white/[0.05] flex items-center justify-center text-xl group-hover:scale-110 transition-transform duration-200">
                        {getChannelIcon(ch)}
                    </div>
                    <div className="text-left flex-1 min-w-0">
                        <p className="text-lg font-semibold text-white/85 group-hover:text-white transition-colors">{getChannelName(ch)}</p>
                        <p className="text-sm text-white/60 truncate mt-0.5">{ch.description}</p>
                    </div>
                    <div className="w-6 h-6 rounded-full bg-white/[0.03] group-hover:bg-white/[0.06] flex items-center justify-center transition-all group-hover:translate-x-0.5">
                        <span className="text-white/15 group-hover:text-white/60 text-xs transition-colors">›</span>
                    </div>
                </button>
            ))}

        {/* Mod: Propose channel */}
        {isMod && (
            <div className="mt-4">
                {!showProposalForm ? (
                    <button
                        onClick={() => setShowProposalForm(true)}
                        className="w-full p-3 rounded-2xl border border-dashed border-white/[0.06] hover:border-sky-500/20 hover:bg-sky-500/[0.03] text-center transition-all duration-200 active:scale-[0.98]"
                    >
                        <span className="text-[11px] text-white/25">➕ Propose a new channel</span>
                    </button>
                ) : (
                    <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3 fade-slide-down">
                        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-sky-400/50">📋 Channel Proposal</p>
                        <p className="text-[11px] text-white/25">Submitted to admins for approval</p>
                        <div className="flex gap-2">
                            <input value={proposalIcon} onChange={e => setProposalIcon(e.target.value)} placeholder="🏝️" className="w-12 bg-white/[0.04] border border-white/[0.06] rounded-lg px-2 py-1.5 text-center text-lg" maxLength={2} />
                            <input value={proposalName} onChange={e => setProposalName(e.target.value)} placeholder="Channel name" className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30" />
                        </div>
                        <input value={proposalDesc} onChange={e => setProposalDesc(e.target.value)} placeholder="Short description" className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-sky-500/30" />
                        <div className="flex gap-2">
                            <button onClick={() => setShowProposalForm(false)} className="flex-1 py-2 rounded-lg bg-white/[0.03] text-[11px] text-white/60 hover:bg-white/[0.06] transition-colors">Cancel</button>
                            <button onClick={onProposeChannel} disabled={!proposalName.trim()} className="flex-1 py-2 rounded-lg bg-sky-500/15 text-[11px] text-sky-400 hover:bg-sky-500/25 disabled:opacity-30 transition-colors">
                                {proposalSent ? '✓ Submitted!' : 'Submit for Review'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        )}
    </div>
);

export default ChannelList;
