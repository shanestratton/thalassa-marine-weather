/**
 * useChatProposals — Extracted from ChatPage.
 * Manages channel proposal form, admin instant create, and private channel membership.
 */
import { useState, useEffect, useCallback } from 'react';
import { ChatService, ChatChannel } from '../../services/ChatService';
import { toast } from '../../components/Toast';

export interface UseChatProposalsOptions {
    channels: ChatChannel[];
    setChannels: React.Dispatch<React.SetStateAction<ChatChannel[]>>;
    isAdmin: boolean;
}

export function useChatProposals(options: UseChatProposalsOptions) {
    const { channels, setChannels, isAdmin } = options;

    // --- Proposal State ---
    const [showProposalForm, setShowProposalForm] = useState(false);
    const [proposalName, setProposalName] = useState('');
    const [proposalDesc, setProposalDesc] = useState('');
    const [proposalIcon, setProposalIcon] = useState('🏝️');
    const [proposalSent, setProposalSent] = useState(false);
    const [proposalIsPrivate, setProposalIsPrivate] = useState(false);
    const [proposalParentId, setProposalParentId] = useState<string | null>(null);

    // --- Private Channel Membership ---
    const [memberChannelIds, setMemberChannelIds] = useState<Set<string>>(new Set());
    const [joinRequestChannel, setJoinRequestChannel] = useState<ChatChannel | null>(null);
    const [joinRequestMessage, setJoinRequestMessage] = useState('');
    const [joinRequestSent, setJoinRequestSent] = useState(false);

    // --- Report State ---
    const [reportingMsg, setReportingMsg] = useState<any | null>(null);
    const [reportReason, setReportReason] = useState<'spam' | 'harassment' | 'hate_speech' | 'inappropriate' | 'other'>(
        'inappropriate',
    );
    const [reportSent, setReportSent] = useState(false);

    // --- Load Memberships ---
    const loadMemberChannels = useCallback(async () => {
        const ids = new Set<string>();
        for (const ch of channels) {
            if (ch.is_private) {
                const isMember = await ChatService.isChannelMember(ch.id);
                if (isMember) ids.add(ch.id);
            }
        }
        setMemberChannelIds(ids);
    }, [channels]);

    useEffect(() => {
        if (channels.length > 0) loadMemberChannels();
    }, [channels, loadMemberChannels]);

    // --- Actions ---

    const handleProposeChannel = useCallback(async () => {
        if (!proposalName.trim()) return;

        let ok = false;
        if (isAdmin) {
            const ch = await ChatService.createChannel(
                proposalName.trim(),
                proposalDesc.trim() || 'A new channel',
                proposalIcon,
                proposalIsPrivate,
                undefined,
                proposalParentId || undefined,
            );
            ok = !!ch;
            if (ok) {
                // Use fresh fetch (bypass cache) to ensure new channel appears immediately
                const updated = await ChatService.getChannelsFresh();
                setChannels(updated);
            }
        } else {
            ok = await ChatService.proposeChannel(
                proposalName.trim(),
                proposalDesc.trim() || 'A new channel',
                proposalIcon,
                proposalIsPrivate,
                undefined,
                proposalParentId || undefined,
            );
        }

        if (ok) {
            setProposalSent(true);
            toast.success(isAdmin ? `${proposalName.trim()} created!` : 'Proposal submitted for admin review!');
            setTimeout(() => {
                setShowProposalForm(false);
                setProposalSent(false);
                setProposalName('');
                setProposalDesc('');
                setProposalIsPrivate(false);
                setProposalParentId(null);
            }, 2000);
        } else {
            toast.error('Failed to submit — please try again');
        }
    }, [proposalName, proposalDesc, proposalIcon, proposalIsPrivate, proposalParentId, isAdmin, setChannels]);

    const handleRequestAccess = useCallback((ch: ChatChannel) => {
        setJoinRequestChannel(ch);
        setJoinRequestMessage('');
        setJoinRequestSent(false);
    }, []);

    const handleSubmitJoinRequest = useCallback(async () => {
        if (!joinRequestChannel) return;
        const ok = await ChatService.requestJoinChannel(joinRequestChannel.id, joinRequestMessage);
        if (ok) {
            setJoinRequestSent(true);
            toast.success(`Request sent to ${joinRequestChannel.name}!`);
            setTimeout(() => setJoinRequestChannel(null), 2000);
        } else {
            toast.error('Failed to send request — you may already have a pending request');
        }
    }, [joinRequestChannel, joinRequestMessage]);

    return {
        // Proposal
        showProposalForm,
        setShowProposalForm,
        proposalName,
        setProposalName,
        proposalDesc,
        setProposalDesc,
        proposalIcon,
        setProposalIcon,
        proposalSent,
        proposalIsPrivate,
        setProposalIsPrivate,
        proposalParentId,
        setProposalParentId,

        // Private channels
        memberChannelIds,
        joinRequestChannel,
        setJoinRequestChannel,
        joinRequestMessage,
        setJoinRequestMessage,
        joinRequestSent,

        // Report
        reportingMsg,
        setReportingMsg,
        reportReason,
        setReportReason,
        reportSent,
        setReportSent,

        // Actions
        handleProposeChannel,
        handleRequestAccess,
        handleSubmitJoinRequest,
    };
}
