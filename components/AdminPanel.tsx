/**
 * AdminPanel — Full-page admin view for people, channels, beta applications,
 * safety reviews and the audit trail.
 *
 * UX Polish:
 * - ConfirmDialog on all destructive actions (delete, block, reject)
 * - Toast feedback on success/error for all admin actions
 * - Loading states on async buttons
 * - Empty states with personality
 * - Minimum 44px touch targets
 * - aria-labels on all interactive elements
 */
import React, { useState, useEffect, useCallback } from 'react';
import { ChatService, ChatRole, UserRoleEntry, JoinRequest, ChatChannel } from '../services/ChatService';
import { triggerHaptic } from '../utils/system';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { EmptyState } from './ui/EmptyState';
import { ShimmerBlock } from './ui/ShimmerBlock';
import { toast } from './Toast';
import { SafeImage } from './ui/SafeImage';
import { LonelyHeartsService, type CrewListReport, type CrewProfile } from '../services/LonelyHeartsService';

const FoundingSkipperInbox = React.lazy(() =>
    import('./admin/FoundingSkipperInbox').then((module) => ({ default: module.FoundingSkipperInbox })),
);

// ── Types ──

interface AdminPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onChannelDeleted?: (channelId: string) => void;
    onChannelApproved?: () => void;
}

type AdminTab = 'users' | 'applications' | 'channels' | 'crew' | 'audit';

const ADMIN_TABS: ReadonlyArray<readonly [AdminTab, string]> = [
    ['users', '👥 Users'],
    ['applications', '🧭 Applications'],
    ['channels', '📡 Channels'],
    ['crew', '⚓ Crew List'],
    ['audit', '📋 Audit'],
];

const ROLE_STYLES: Record<ChatRole, { bg: string; text: string; label: string }> = {
    admin: { bg: 'bg-amber-500/20 border-amber-500/40', text: 'text-amber-400', label: '👑 Admin' },
    moderator: { bg: 'bg-sky-500/20 border-sky-500/40', text: 'text-sky-400', label: '🛡️ Mod' },
    member: { bg: 'bg-white/[0.06] border-white/10', text: 'text-white/50', label: 'Member' },
};

const AUDIT_LABELS: Record<string, { icon: string; label: string; color: string }> = {
    set_role: { icon: '👑', label: 'Changed Role', color: 'text-amber-400' },
    block_user: { icon: '🚫', label: 'Blocked User', color: 'text-red-400' },
    unblock_user: { icon: '✅', label: 'Unblocked User', color: 'text-emerald-400' },
    mute_user: { icon: '🔇', label: 'Muted User', color: 'text-orange-400' },
    unmute_user: { icon: '🔊', label: 'Unmuted User', color: 'text-emerald-400' },
    approve_channel: { icon: '✅', label: 'Approved Channel', color: 'text-emerald-400' },
    reject_channel: { icon: '❌', label: 'Rejected Channel', color: 'text-red-400' },
    delete_channel: { icon: '🗑️', label: 'Deleted Channel', color: 'text-red-400' },
    approve_join: { icon: '✅', label: 'Approved Join', color: 'text-emerald-400' },
    reject_join: { icon: '❌', label: 'Rejected Join', color: 'text-red-400' },
};

const CREW_INTENT_LABELS: Record<'find_crew' | 'find_skipper', string> = {
    find_crew: 'Looking for crew',
    find_skipper: 'Looking for a skipper',
};

const formatCrewReviewLocation = (profile: CrewProfile) =>
    [profile.location_state, profile.location_country].filter(Boolean).join(', ') || 'Location not supplied';

const formatCrewReportDate = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Recently';
    return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
};

// ── Component ──

export const AdminPanel: React.FC<AdminPanelProps> = ({ isOpen, onClose, onChannelDeleted, onChannelApproved }) => {
    const [tab, setTab] = useState<AdminTab>('users');

    // Users tab
    const [users, setUsers] = useState<UserRoleEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [actionUserId, setActionUserId] = useState<string | null>(null);
    const [muteHours, setMuteHours] = useState('');
    const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);

    // Channels tab
    const [pendingChannels, setPendingChannels] = useState<ChatChannel[]>([]);
    const [activeChannels, setActiveChannels] = useState<ChatChannel[]>([]);

    // Crew List tab — only manual review details, never exact location or contact details.
    const [pendingCrewProfiles, setPendingCrewProfiles] = useState<CrewProfile[]>([]);
    const [reviewingCrewProfileId, setReviewingCrewProfileId] = useState<string | null>(null);
    const [crewReports, setCrewReports] = useState<CrewListReport[]>([]);
    const [reviewingCrewReportId, setReviewingCrewReportId] = useState<string | null>(null);

    // Audit tab
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [auditLog, setAuditLog] = useState<any[]>([]);

    // Confirm dialog state
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [confirmConfig, setConfirmConfig] = useState<{
        title: string;
        message: string;
        confirmLabel: string;
        destructive: boolean;
        onConfirm: () => Promise<void>;
    }>({ title: '', message: '', confirmLabel: 'Confirm', destructive: false, onConfirm: async () => {} });

    const showConfirm = (
        title: string,
        message: string,
        confirmLabel: string,
        destructive: boolean,
        onConfirm: () => Promise<void>,
    ) => {
        setConfirmConfig({ title, message, confirmLabel, destructive, onConfirm });
        setConfirmOpen(true);
    };

    const loadData = useCallback(async () => {
        setLoading(true);
        const [userData, requestData, pending, channels, audit, crewProfiles, reports] = await Promise.all([
            ChatService.listAllUsersWithRoles(),
            ChatService.getJoinRequests(),
            ChatService.getPendingChannels(),
            ChatService.getChannels(),
            ChatService.getAuditLog(50),
            // A partial Crew List rollout must not make the rest of the
            // admin panel unusable. The empty queues make it clear that no
            // Crew action can be taken until its server capability is live.
            LonelyHeartsService.getPendingCrewProfileReviews().catch(() => []),
            LonelyHeartsService.getCrewListReports().catch(() => []),
        ]);
        setUsers(userData);
        setJoinRequests(requestData);
        setPendingChannels(pending);
        setActiveChannels(channels);
        setAuditLog(audit);
        setPendingCrewProfiles(crewProfiles);
        setCrewReports(reports);
        setLoading(false);
    }, []);

    useEffect(() => {
        if (isOpen) loadData();
    }, [isOpen, loadData]);

    if (!isOpen) return null;

    const currentUserId = ChatService.getCurrentUserId();

    // ── Users Tab Handlers ──
    const filteredUsers = search.trim()
        ? users.filter(
              (u) =>
                  u.display_name.toLowerCase().includes(search.toLowerCase()) ||
                  (u.vessel_name || '').toLowerCase().includes(search.toLowerCase()) ||
                  u.user_id.toLowerCase().includes(search.toLowerCase()),
          )
        : users;

    const handleSetRole = async (userId: string, role: ChatRole) => {
        triggerHaptic('medium');
        const ok = await ChatService.setRole(userId, role);
        if (ok) {
            setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, role } : u)));
            setActionUserId(null);
            toast.success(`Role updated to ${role}`);
        } else {
            toast.error('Failed to update role');
        }
    };

    const handleBlock = async (userId: string) => {
        const user = users.find((u) => u.user_id === userId);
        showConfirm(
            'Block User',
            `Permanently block ${user?.display_name || 'this user'} from the platform? They won't be able to access Crew Talk.`,
            '🚫 Block',
            true,
            async () => {
                triggerHaptic('heavy');
                const ok = await ChatService.blockUserPlatform(userId);
                if (ok) {
                    setUsers((prev) =>
                        prev.map((u) =>
                            u.user_id === userId ? { ...u, is_blocked: true, role: 'member' as ChatRole } : u,
                        ),
                    );
                    setActionUserId(null);
                    toast.success(`${user?.display_name} has been blocked`);
                } else {
                    toast.error('Failed to block user');
                }
                setConfirmOpen(false);
            },
        );
    };

    const handleUnblock = async (userId: string) => {
        const ok = await ChatService.unblockUserPlatform(userId);
        if (ok) {
            setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, is_blocked: false } : u)));
            toast.success('User unblocked');
        } else {
            toast.error('Failed to unblock user');
        }
    };

    const handleMute = async (userId: string) => {
        const hrs = parseInt(muteHours);
        if (!hrs || hrs <= 0) {
            toast.error('Enter valid hours');
            return;
        }
        const user = users.find((u) => u.user_id === userId);
        const ok = await ChatService.muteUser(userId, hrs);
        if (ok) {
            setUsers((prev) =>
                prev.map((u) =>
                    u.user_id === userId
                        ? { ...u, muted_until: new Date(Date.now() + hrs * 3600000).toISOString() }
                        : u,
                ),
            );
            setMuteHours('');
            setActionUserId(null);
            toast.success(`${user?.display_name} muted for ${hrs}h`);
        } else {
            toast.error('Failed to mute user');
        }
    };

    const handleUnmute = async (userId: string) => {
        const ok = await ChatService.unmuteUser(userId);
        if (ok) {
            setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, muted_until: null } : u)));
            toast.success('User unmuted');
        } else {
            toast.error('Failed to unmute');
        }
    };

    const handleApproveJoinRequest = async (id: string) => {
        triggerHaptic('medium');
        const req = joinRequests.find((r) => r.id === id);
        const ok = await ChatService.approveJoinRequest(id);
        if (ok) {
            setJoinRequests((prev) => prev.filter((r) => r.id !== id));
            toast.success(`${req?.display_name} approved to join ${req?.channel_name}`);
        } else {
            toast.error('Failed to approve request');
        }
    };

    const handleRejectJoinRequest = async (id: string) => {
        const req = joinRequests.find((r) => r.id === id);
        showConfirm(
            'Reject Join Request',
            `Reject ${req?.display_name || 'this user'}'s request to join ${req?.channel_name || 'this channel'}?`,
            '❌ Reject',
            true,
            async () => {
                triggerHaptic('light');
                const ok = await ChatService.rejectJoinRequest(id);
                if (ok) {
                    setJoinRequests((prev) => prev.filter((r) => r.id !== id));
                    toast.success('Join request rejected');
                } else {
                    toast.error('Failed to reject request');
                }
                setConfirmOpen(false);
            },
        );
    };

    // ── Channels Tab Handlers ──
    const handleApproveChannel = async (id: string) => {
        const ch = pendingChannels.find((c) => c.id === id);
        triggerHaptic('medium');
        const ok = await ChatService.approveChannel(id);
        if (ok) {
            setPendingChannels((prev) => prev.filter((c) => c.id !== id));
            const updated = await ChatService.getChannelsFresh();
            setActiveChannels(updated);
            onChannelApproved?.();
            toast.success(`${ch?.name || 'Channel'} approved!`);
        } else {
            toast.error('Failed to approve channel');
        }
    };

    const handleRejectChannel = async (id: string) => {
        const ch = pendingChannels.find((c) => c.id === id);
        showConfirm(
            'Reject Proposal',
            `Reject and delete the "${ch?.name || 'this channel'}" proposal?`,
            '❌ Reject',
            true,
            async () => {
                triggerHaptic('light');
                const ok = await ChatService.rejectChannel(id);
                if (ok) {
                    setPendingChannels((prev) => prev.filter((c) => c.id !== id));
                    toast.success('Proposal rejected');
                } else {
                    toast.error('Failed to reject proposal');
                }
                setConfirmOpen(false);
            },
        );
    };

    const handleDeleteChannel = async (id: string) => {
        const ch = activeChannels.find((c) => c.id === id);
        showConfirm(
            'Delete Channel',
            `Permanently delete "${ch?.name || 'this channel'}" and all its messages? This cannot be undone.`,
            '🗑️ Delete Forever',
            true,
            async () => {
                triggerHaptic('heavy');
                const ok = await ChatService.deleteChannel(id);
                if (ok) {
                    setActiveChannels((prev) => prev.filter((c) => c.id !== id));
                    ChatService.invalidateChannelCache();
                    onChannelDeleted?.(id);
                    toast.success(`${ch?.name} deleted`);
                } else {
                    toast.error('Failed to delete channel');
                }
                setConfirmOpen(false);
            },
        );
    };

    // ── Crew List Tab Handlers ──
    const handleReviewCrewProfile = (profile: CrewProfile, decision: 'approved' | 'rejected') => {
        const isApproval = decision === 'approved';
        const name = profile.first_name || 'this applicant';

        showConfirm(
            isApproval ? 'Approve Crew List Profile' : 'Reject Crew List Profile',
            isApproval
                ? `Approve ${name}'s profile for The Crew List? Confirm that the primary image is a genuine headshot and the listing is suitable before it becomes discoverable.`
                : `Reject ${name}'s Crew List profile? It will stay private until they update and resubmit it for review.`,
            isApproval ? '✅ Approve & Publish' : '❌ Reject & Keep Private',
            !isApproval,
            async () => {
                setReviewingCrewProfileId(profile.user_id);
                triggerHaptic(isApproval ? 'medium' : 'light');

                try {
                    const ok = await LonelyHeartsService.reviewCrewProfile(profile.user_id, decision);
                    if (ok) {
                        setPendingCrewProfiles((previous) =>
                            previous.filter((pendingProfile) => pendingProfile.user_id !== profile.user_id),
                        );
                        toast.success(
                            isApproval
                                ? `${name}'s Crew List profile is now discoverable`
                                : `${name}'s Crew List profile remains private`,
                        );
                    } else {
                        toast.error(`Could not ${isApproval ? 'approve' : 'reject'} this Crew List profile`);
                    }
                } finally {
                    setReviewingCrewProfileId(null);
                    setConfirmOpen(false);
                }
            },
        );
    };

    const handleReviewCrewReport = (report: CrewListReport, decision: 'resolved' | 'dismissed') => {
        const resolving = decision === 'resolved';
        showConfirm(
            resolving ? 'Resolve Crew List Report' : 'Dismiss Crew List Report',
            resolving
                ? "Mark this report as resolved after you have taken any necessary account action. This closes the report queue only; it does not change either sailor's account."
                : "Dismiss this report as not requiring action. This closes the report queue and does not change either sailor's account.",
            resolving ? '✓ Resolve Report' : 'Dismiss Report',
            false,
            async () => {
                setReviewingCrewReportId(report.id);
                triggerHaptic(resolving ? 'medium' : 'light');

                try {
                    const ok = await LonelyHeartsService.reviewCrewListReport(report.id, decision);
                    if (ok) {
                        setCrewReports((previous) =>
                            previous.map((existing) =>
                                existing.id === report.id ? { ...existing, status: decision } : existing,
                            ),
                        );
                        toast.success(resolving ? 'Crew List report resolved' : 'Crew List report dismissed');
                    } else {
                        toast.error('Could not update this Crew List report');
                    }
                } finally {
                    setReviewingCrewReportId(null);
                    setConfirmOpen(false);
                }
            },
        );
    };

    const handleReviewReportedAccount = (report: CrewListReport) => {
        setSearch(report.reported_id);
        setTab('users');
    };

    // ── Stats ──
    const adminCount = users.filter((u) => u.role === 'admin').length;
    const modCount = users.filter((u) => u.role === 'moderator').length;
    const blockedCount = users.filter((u) => u.is_blocked).length;
    const pendingCrewReports = crewReports.filter((report) => report.status === 'pending');

    const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentTab: AdminTab) => {
        const index = ADMIN_TABS.findIndex(([candidate]) => candidate === currentTab);
        let nextIndex = index;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % ADMIN_TABS.length;
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + ADMIN_TABS.length) % ADMIN_TABS.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = ADMIN_TABS.length - 1;
        else return;

        event.preventDefault();
        const nextTab = ADMIN_TABS[nextIndex][0];
        setTab(nextTab);
        document.getElementById(`admin-tab-${nextTab}`)?.focus();
    };

    return (
        <div className="flex flex-col h-full" role="region" aria-label="Admin Panel">
            {/* Confirm Dialog */}
            <ConfirmDialog
                isOpen={confirmOpen}
                title={confirmConfig.title}
                message={confirmConfig.message}
                confirmLabel={confirmConfig.confirmLabel}
                destructive={confirmConfig.destructive}
                onConfirm={confirmConfig.onConfirm}
                onCancel={() => setConfirmOpen(false)}
            />

            {/* ── Header ── */}
            <div className="sticky top-0 z-10 bg-slate-900/95 border-b border-white/[0.06]">
                <div className="flex items-center gap-3 px-4 py-3">
                    <button
                        onClick={onClose}
                        aria-label="Back to channels"
                        className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/[0.04] hover:bg-white/[0.08] transition-colors"
                    >
                        <svg
                            className="w-4 h-4 text-white/60"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>
                    <div className="flex items-center gap-2 flex-1">
                        <span className="text-lg">👑</span>
                        <h2 className="text-sm font-bold text-amber-400">Admin Panel</h2>
                    </div>
                </div>

                {/* Tab bar — 44px touch targets */}
                <div className="flex gap-1 px-4 pb-2 overflow-x-auto" role="tablist" aria-label="Admin sections">
                    {ADMIN_TABS.map(([t, label]) => (
                        <button
                            key={t}
                            id={`admin-tab-${t}`}
                            onClick={() => setTab(t)}
                            onKeyDown={(event) => handleTabKeyDown(event, t)}
                            aria-label={`${label} tab`}
                            aria-selected={tab === t}
                            aria-controls={`admin-panel-${t}`}
                            tabIndex={tab === t ? 0 : -1}
                            role="tab"
                            className={`shrink-0 min-w-[96px] flex-1 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all min-h-[44px] ${
                                tab === t
                                    ? 'bg-white/[0.08] border border-white/[0.12] text-white'
                                    : 'bg-white/[0.02] border border-white/[0.04] text-white/40'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Content ── */}
            <div
                className="flex-1 overflow-y-auto pb-24"
                role="tabpanel"
                id={`admin-panel-${tab}`}
                aria-labelledby={`admin-tab-${tab}`}
            >
                {/* ════════ USERS TAB ════════ */}
                {tab === 'users' && (
                    <>
                        {/* Stats */}
                        <div className="px-4 pt-4 pb-2 flex gap-2.5">
                            <div className="flex-1 px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-center">
                                <p className="text-lg font-bold text-amber-400">{adminCount}</p>
                                <p className="text-[11px] text-amber-400/60 uppercase tracking-wider">Admins</p>
                            </div>
                            <div className="flex-1 px-3 py-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20 text-center">
                                <p className="text-lg font-bold text-sky-400">{modCount}</p>
                                <p className="text-[11px] text-sky-400/60 uppercase tracking-wider">Mods</p>
                            </div>
                            <div className="flex-1 px-3 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-center">
                                <p className="text-lg font-bold text-red-400">{blockedCount}</p>
                                <p className="text-[11px] text-red-400/60 uppercase tracking-wider">Blocked</p>
                            </div>
                        </div>

                        {/* Search */}
                        <div className="px-4 py-2">
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search users..."
                                aria-label="Search users"
                                className="w-full px-3.5 py-3 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors min-h-[44px]"
                            />
                        </div>

                        {/* Join Requests */}
                        {joinRequests.length > 0 && (
                            <div className="px-4 pb-2">
                                <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-purple-400/60 mb-2 px-1">
                                    🙏 Join Requests ({joinRequests.length})
                                </p>
                                <div className="space-y-2">
                                    {joinRequests.map((req) => (
                                        <div
                                            key={req.id}
                                            className="rounded-xl border border-purple-500/15 bg-purple-500/[0.03] p-3 space-y-2.5"
                                        >
                                            <div className="flex items-center gap-2.5">
                                                {req.avatar_url ? (
                                                    <SafeImage
                                                        src={req.avatar_url}
                                                        className="w-9 h-9 rounded-full object-cover border border-white/10"
                                                        alt={`${req.display_name} avatar`}
                                                    />
                                                ) : (
                                                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center text-xs font-bold text-white">
                                                        {(req.display_name || '?')[0].toUpperCase()}
                                                    </div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-xs font-semibold text-white/80">
                                                        {req.display_name}
                                                    </p>
                                                    <p className="text-[11px] text-purple-400/50">
                                                        wants to join{' '}
                                                        <span className="font-bold text-purple-400/70">
                                                            {req.channel_name}
                                                        </span>
                                                    </p>
                                                </div>
                                            </div>
                                            {req.message && (
                                                <p className="text-[11px] text-white/40 italic px-1">"{req.message}"</p>
                                            )}
                                            <div className="flex gap-1.5">
                                                <button
                                                    onClick={() => handleRejectJoinRequest(req.id)}
                                                    aria-label={`Reject ${req.display_name}'s request`}
                                                    className="flex-1 py-2.5 rounded-xl bg-red-500/10 border border-red-500/15 text-[11px] font-bold text-red-400 active:scale-95 min-h-[44px]"
                                                >
                                                    ❌ Reject
                                                </button>
                                                <button
                                                    onClick={() => handleApproveJoinRequest(req.id)}
                                                    aria-label={`Approve ${req.display_name}'s request`}
                                                    className="flex-1 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/15 text-[11px] font-bold text-emerald-400 active:scale-95 min-h-[44px]"
                                                >
                                                    ✅ Approve
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* User list */}
                        <div className="px-4 space-y-2">
                            {loading ? (
                                <div className="py-12 space-y-3">
                                    <ShimmerBlock variant="list" rows={5} />
                                </div>
                            ) : filteredUsers.length === 0 ? (
                                <EmptyState
                                    icon="🔍"
                                    title="No Users Found"
                                    description={search ? `No one matching "${search}"` : 'No users to display'}
                                />
                            ) : (
                                filteredUsers.map((user) => {
                                    const isMe = user.user_id === currentUserId;
                                    const roleStyle = ROLE_STYLES[user.role];
                                    const isExpanded = actionUserId === user.user_id;
                                    const isMuted = user.muted_until && new Date(user.muted_until) > new Date();

                                    return (
                                        <div
                                            key={user.user_id}
                                            className={`rounded-xl border overflow-hidden transition-all ${user.is_blocked ? 'border-red-500/20 bg-red-500/5' : 'border-white/[0.06] bg-white/[0.02]'}`}
                                        >
                                            <button
                                                onClick={() => setActionUserId(isExpanded ? null : user.user_id)}
                                                aria-label={`${user.display_name} — ${user.role}${user.is_blocked ? ', blocked' : ''}${isMuted ? ', muted' : ''}`}
                                                aria-expanded={isExpanded}
                                                className="w-full px-3.5 py-3.5 flex items-center gap-3 text-left min-h-[56px]"
                                            >
                                                {user.avatar_url ? (
                                                    <SafeImage
                                                        src={user.avatar_url}
                                                        className="w-10 h-10 rounded-full object-cover border border-white/10"
                                                        alt=""
                                                    />
                                                ) : (
                                                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-sky-600 to-indigo-600 flex items-center justify-center text-sm font-bold text-white">
                                                        {user.display_name[0].toUpperCase()}
                                                    </div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-sm font-semibold text-white/80 truncate">
                                                            {user.display_name}
                                                        </span>
                                                        {isMe && (
                                                            <span className="text-[11px] text-sky-400 font-bold">
                                                                (You)
                                                            </span>
                                                        )}
                                                    </div>
                                                    {user.vessel_name && (
                                                        <p className="text-[11px] text-white/40 truncate">
                                                            ⛵ {user.vessel_name}
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1.5">
                                                    {user.is_blocked && (
                                                        <span className="text-[11px] font-bold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded-full">
                                                            BLOCKED
                                                        </span>
                                                    )}
                                                    {isMuted && (
                                                        <span className="text-[11px] font-bold text-orange-400 bg-orange-500/15 px-1.5 py-0.5 rounded-full">
                                                            MUTED
                                                        </span>
                                                    )}
                                                    <span
                                                        className={`px-2 py-1 rounded-full border text-[11px] font-bold ${roleStyle.bg} ${roleStyle.text}`}
                                                    >
                                                        {roleStyle.label}
                                                    </span>
                                                </div>
                                            </button>

                                            {isExpanded && !isMe && (
                                                <div className="px-3.5 pb-3.5 space-y-2 border-t border-white/[0.04] pt-2.5">
                                                    {/* Role buttons — 44px min */}
                                                    <div className="flex gap-1.5">
                                                        {(['admin', 'moderator', 'member'] as ChatRole[]).map((r) => (
                                                            <button
                                                                key={r}
                                                                onClick={() => handleSetRole(user.user_id, r)}
                                                                disabled={user.role === r}
                                                                aria-label={`Set role to ${r}`}
                                                                className={`flex-1 py-2.5 rounded-xl border text-[11px] font-bold uppercase tracking-wider transition-all active:scale-95 min-h-[44px] ${
                                                                    user.role === r
                                                                        ? ROLE_STYLES[r].bg + ' ' + ROLE_STYLES[r].text
                                                                        : 'bg-white/[0.04] border-white/[0.06] text-white/50'
                                                                }`}
                                                            >
                                                                {ROLE_STYLES[r].label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                    {/* Mute/Unmute — 44px min */}
                                                    {isMuted ? (
                                                        <button
                                                            onClick={() => handleUnmute(user.user_id)}
                                                            aria-label="Unmute user"
                                                            className="w-full py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-bold text-emerald-400 uppercase tracking-wider active:scale-95 min-h-[44px]"
                                                        >
                                                            🔊 Unmute User
                                                        </button>
                                                    ) : (
                                                        <div className="flex gap-1.5">
                                                            <input
                                                                value={muteHours}
                                                                onChange={(e) =>
                                                                    setMuteHours(e.target.value.replace(/\D/g, ''))
                                                                }
                                                                placeholder="Hours"
                                                                inputMode="numeric"
                                                                aria-label="Mute duration in hours"
                                                                className="w-20 px-2.5 py-3 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none min-h-[44px]"
                                                            />
                                                            <button
                                                                onClick={() => handleMute(user.user_id)}
                                                                aria-label={`Mute for ${muteHours || '?'} hours`}
                                                                className="flex-1 py-3 rounded-xl bg-orange-500/10 border border-orange-500/20 text-[11px] font-bold text-orange-400 uppercase tracking-wider active:scale-95 min-h-[44px]"
                                                            >
                                                                🔇 Mute {muteHours || '?'} hrs
                                                            </button>
                                                        </div>
                                                    )}
                                                    {/* Block/Unblock — 44px min */}
                                                    {user.is_blocked ? (
                                                        <button
                                                            onClick={() => handleUnblock(user.user_id)}
                                                            aria-label="Unblock user"
                                                            className="w-full py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[11px] font-bold text-emerald-400 uppercase tracking-wider active:scale-95 min-h-[44px]"
                                                        >
                                                            ✅ Unblock User
                                                        </button>
                                                    ) : (
                                                        <button
                                                            onClick={() => handleBlock(user.user_id)}
                                                            aria-label="Block user permanently"
                                                            className="w-full py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-[11px] font-bold text-red-400 uppercase tracking-wider active:scale-95 min-h-[44px]"
                                                        >
                                                            🚫 Block Permanently
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                            {isExpanded && isMe && (
                                                <div className="px-3.5 pb-3 pt-2 border-t border-white/[0.04]">
                                                    <p className="text-[11px] text-white/50 text-center">
                                                        You cannot modify your own role
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </>
                )}

                {/* ════════ FOUNDING SKIPPERS TAB ════════ */}
                {tab === 'applications' && (
                    <React.Suspense
                        fallback={
                            <div className="px-4 py-12">
                                <ShimmerBlock variant="list" rows={5} />
                            </div>
                        }
                    >
                        <FoundingSkipperInbox />
                    </React.Suspense>
                )}

                {/* ════════ CHANNELS TAB ════════ */}
                {tab === 'channels' && (
                    <div className="px-4 pt-4 space-y-4">
                        {/* Pending Proposals */}
                        <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-sky-400/60 mb-2 px-1">
                                📋 Pending Proposals ({pendingChannels.length})
                            </p>
                            {pendingChannels.length === 0 ? (
                                <EmptyState
                                    icon="📭"
                                    title="No Pending Proposals"
                                    description="Channel proposals from users will appear here"
                                />
                            ) : (
                                <div className="space-y-2">
                                    {pendingChannels.map((ch) => (
                                        <div
                                            key={ch.id}
                                            className="rounded-xl border border-sky-500/15 bg-sky-500/[0.03] p-3.5 space-y-2.5"
                                        >
                                            <div className="flex items-center gap-2.5">
                                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500/10 to-indigo-500/10 border border-sky-500/20 flex items-center justify-center text-lg">
                                                    {ch.icon}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1.5">
                                                        <p className="text-sm font-bold text-white/80">{ch.name}</p>
                                                        {ch.is_private && (
                                                            <span className="text-[11px] font-bold text-purple-400/70 bg-purple-500/10 px-1.5 py-0.5 rounded-full">
                                                                PRIVATE
                                                            </span>
                                                        )}
                                                        {ch.parent_id && (
                                                            <span className="text-[11px] font-bold text-white/50 bg-white/[0.05] px-1.5 py-0.5 rounded-full">
                                                                SUB
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="text-[11px] text-white/40 truncate">
                                                        {ch.description}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex gap-1.5">
                                                <button
                                                    onClick={() => handleRejectChannel(ch.id)}
                                                    aria-label={`Reject ${ch.name}`}
                                                    className="flex-1 py-2.5 rounded-xl bg-red-500/10 border border-red-500/15 text-[11px] font-bold text-red-400 active:scale-95 min-h-[44px]"
                                                >
                                                    ❌ Reject
                                                </button>
                                                <button
                                                    onClick={() => handleApproveChannel(ch.id)}
                                                    aria-label={`Approve ${ch.name}`}
                                                    className="flex-1 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/15 text-[11px] font-bold text-emerald-400 active:scale-95 min-h-[44px]"
                                                >
                                                    ✅ Approve
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Active Channels */}
                        <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-emerald-400/60 mb-2 px-1">
                                📡 Active Channels ({activeChannels.length})
                            </p>
                            {activeChannels.length === 0 ? (
                                <EmptyState
                                    icon="📡"
                                    title="No Active Channels"
                                    description="Approved channels will appear here"
                                />
                            ) : (
                                <div className="space-y-1.5">
                                    {activeChannels.map((ch) => (
                                        <div
                                            key={ch.id}
                                            className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 flex items-center gap-2.5 min-h-[52px]"
                                        >
                                            <span className="text-base">{ch.is_private ? '🔒' : ch.icon}</span>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                    <p className="text-sm font-semibold text-white/70">{ch.name}</p>
                                                    {ch.is_private && (
                                                        <span className="text-[11px] font-bold text-purple-400/60 bg-purple-500/10 px-1 py-0.5 rounded-full">
                                                            PRIVATE
                                                        </span>
                                                    )}
                                                    {ch.parent_id && (
                                                        <span className="text-[11px] font-bold text-white/40 bg-white/[0.04] px-1 py-0.5 rounded-full">
                                                            SUB
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => handleDeleteChannel(ch.id)}
                                                aria-label={`Delete ${ch.name}`}
                                                className="px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/15 text-[11px] font-bold text-red-400 active:scale-95 hover:bg-red-500/20 transition-colors min-h-[44px]"
                                            >
                                                🗑️ Delete
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ════════ CREW LIST REVIEW TAB ════════ */}
                {tab === 'crew' && (
                    <div className="px-4 pt-4 space-y-3">
                        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.05] px-3.5 py-3">
                            <p className="text-xs font-bold text-amber-300">Manual safety review</p>
                            <p className="mt-1 text-[11px] leading-relaxed text-amber-100/55">
                                Check that the primary image is a real headshot and that the listing is suitable.
                                Approving makes it discoverable in The Crew List; exact location and contact details are
                                deliberately not shown here.
                            </p>
                        </div>

                        <section aria-labelledby="crew-list-reports-title" className="space-y-2">
                            <div className="flex items-center justify-between px-1">
                                <p
                                    id="crew-list-reports-title"
                                    className="text-[11px] font-bold uppercase tracking-[0.15em] text-red-300/70"
                                >
                                    🚩 Safety reports ({pendingCrewReports.length})
                                </p>
                                {pendingCrewReports.length > 0 && (
                                    <span className="text-[11px] text-white/50">Reporter stays confidential</span>
                                )}
                            </div>

                            {loading ? (
                                <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5">
                                    <ShimmerBlock variant="text" rows={2} />
                                </div>
                            ) : pendingCrewReports.length > 0 ? (
                                <div className="space-y-2">
                                    {pendingCrewReports.map((report) => {
                                        const isReviewing = reviewingCrewReportId === report.id;
                                        return (
                                            <article
                                                key={report.id}
                                                className="rounded-2xl border border-red-400/15 bg-red-400/[0.035] p-3.5"
                                            >
                                                <div className="flex items-start justify-between gap-3">
                                                    <div>
                                                        <p className="text-xs font-bold text-red-100/85">
                                                            Crew List safety report
                                                        </p>
                                                        <p className="mt-0.5 text-[11px] text-white/40">
                                                            Received {formatCrewReportDate(report.created_at)}
                                                        </p>
                                                    </div>
                                                    <span className="rounded-full border border-red-400/20 bg-red-400/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-red-200/80">
                                                        Open
                                                    </span>
                                                </div>

                                                <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.12em] text-white/50">
                                                    Reported concern
                                                </p>
                                                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-white/70">
                                                    {report.reason}
                                                </p>

                                                <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/[0.05] pt-3">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleReviewReportedAccount(report)}
                                                        disabled={isReviewing}
                                                        aria-label="Review reported account"
                                                        className="min-h-[44px] rounded-xl border border-sky-400/20 bg-sky-400/[0.08] px-2 py-2 text-[10px] font-bold text-sky-200 transition-colors active:scale-95 disabled:cursor-wait disabled:opacity-50"
                                                    >
                                                        Review account
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleReviewCrewReport(report, 'dismissed')}
                                                        disabled={isReviewing}
                                                        aria-label="Dismiss Crew List report"
                                                        className="min-h-[44px] rounded-xl border border-white/[0.08] bg-white/[0.035] px-2 py-2 text-[10px] font-bold text-white/60 transition-colors active:scale-95 disabled:cursor-wait disabled:opacity-50"
                                                    >
                                                        {isReviewing ? 'Updating…' : 'Dismiss'}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleReviewCrewReport(report, 'resolved')}
                                                        disabled={isReviewing}
                                                        aria-label="Resolve Crew List report"
                                                        className="min-h-[44px] rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-2 py-2 text-[10px] font-bold text-emerald-200 transition-colors active:scale-95 disabled:cursor-wait disabled:opacity-50"
                                                    >
                                                        {isReviewing ? 'Updating…' : 'Resolve'}
                                                    </button>
                                                </div>
                                            </article>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="rounded-xl border border-white/[0.05] bg-white/[0.02] px-3 py-2.5 text-[11px] text-white/40">
                                    No open Crew List safety reports.
                                </p>
                            )}
                        </section>

                        <p className="px-1 text-[11px] font-bold uppercase tracking-[0.15em] text-sky-400/60">
                            ⚓ Pending review ({pendingCrewProfiles.length})
                        </p>

                        {loading ? (
                            <div className="py-8">
                                <ShimmerBlock variant="list" rows={3} />
                            </div>
                        ) : pendingCrewProfiles.length === 0 ? (
                            <EmptyState
                                icon="⚓"
                                title="No Crew List Profiles Waiting"
                                description="New opt-in profiles will appear here for a manual headshot and suitability review."
                            />
                        ) : (
                            <div className="space-y-3">
                                {pendingCrewProfiles.map((profile) => {
                                    const isReviewing = reviewingCrewProfileId === profile.user_id;
                                    const intents = profile.crew_intents
                                        .map((intent) => CREW_INTENT_LABELS[intent])
                                        .filter(Boolean);

                                    return (
                                        <article
                                            key={profile.user_id}
                                            className="overflow-hidden rounded-2xl border border-sky-400/15 bg-white/[0.025]"
                                        >
                                            <div className="flex gap-3 p-3.5">
                                                {profile.photo_url ? (
                                                    <SafeImage
                                                        src={profile.photo_url}
                                                        alt={`${profile.first_name || 'Crew List applicant'} primary headshot`}
                                                        className="h-20 w-20 shrink-0 rounded-xl border border-white/10 object-cover"
                                                    />
                                                ) : (
                                                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-red-400/25 bg-red-400/10 text-center text-[11px] font-bold text-red-300">
                                                        Missing
                                                        <br />
                                                        headshot
                                                    </div>
                                                )}

                                                <div className="min-w-0 flex-1">
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        <h3 className="truncate text-sm font-bold text-white/90">
                                                            {profile.first_name || 'Unnamed applicant'}
                                                        </h3>
                                                        <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-bold text-amber-300">
                                                            REVIEW
                                                        </span>
                                                    </div>
                                                    <p className="mt-1 text-[11px] font-semibold text-sky-300/75">
                                                        {intents.join(' · ') || 'Crew List intent not supplied'}
                                                    </p>
                                                    <p className="mt-1 text-[11px] text-white/40">
                                                        {formatCrewReviewLocation(profile)}
                                                    </p>
                                                </div>
                                            </div>

                                            <div className="border-t border-white/[0.05] px-3.5 py-3">
                                                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/50">
                                                    Listing note
                                                </p>
                                                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-white/65">
                                                    {profile.bio || 'No listing note supplied.'}
                                                </p>
                                            </div>

                                            <div className="flex gap-2 border-t border-white/[0.05] p-3.5">
                                                <button
                                                    type="button"
                                                    onClick={() => handleReviewCrewProfile(profile, 'rejected')}
                                                    disabled={isReviewing}
                                                    aria-label={`Reject ${profile.first_name || 'this'} Crew List profile`}
                                                    className="min-h-[44px] flex-1 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2.5 text-[11px] font-bold text-red-300 transition-colors active:scale-95 disabled:cursor-wait disabled:opacity-50"
                                                >
                                                    {isReviewing ? 'Reviewing…' : '❌ Reject'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleReviewCrewProfile(profile, 'approved')}
                                                    disabled={isReviewing || !profile.photo_url}
                                                    aria-label={`Approve ${profile.first_name || 'this'} Crew List profile`}
                                                    className="min-h-[44px] flex-1 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2.5 text-[11px] font-bold text-emerald-300 transition-colors active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                                                >
                                                    {isReviewing ? 'Reviewing…' : '✅ Approve'}
                                                </button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* ════════ AUDIT TAB ════════ */}
                {tab === 'audit' && (
                    <div className="px-4 pt-4 space-y-2">
                        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/40 mb-2 px-1">
                            📋 Audit Trail — Last 50 Actions
                        </p>
                        {auditLog.length === 0 ? (
                            <EmptyState
                                icon="📋"
                                title="Clean Slate"
                                description="Admin actions will be logged here for accountability. Every role change, block, mute, and channel action is tracked."
                            />
                        ) : (
                            auditLog.map((entry, i) => {
                                const meta = AUDIT_LABELS[entry.action] || {
                                    icon: '📝',
                                    label: entry.action,
                                    color: 'text-white/50',
                                };
                                const timestamp = new Date(entry.created_at);
                                const timeStr =
                                    timestamp.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) +
                                    ' ' +
                                    timestamp.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });

                                return (
                                    <div
                                        key={entry.id || i}
                                        className="rounded-xl border border-white/[0.04] bg-white/[0.015] px-3.5 py-3 flex items-start gap-2.5"
                                    >
                                        <span className="text-base mt-0.5">{meta.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className={`text-xs font-bold ${meta.color}`}>{meta.label}</span>
                                                <span className="text-[11px] text-white/50">by</span>
                                                <span className="text-[11px] font-semibold text-white/60">
                                                    {entry.actor_name}
                                                </span>
                                            </div>
                                            {entry.details && Object.keys(entry.details).length > 0 && (
                                                <p className="text-[11px] text-white/50 mt-0.5">
                                                    {Object.entries(entry.details)
                                                        .map(([k, v]) => `${k}: ${v}`)
                                                        .join(' · ')}
                                                </p>
                                            )}
                                            <p className="text-[11px] text-white/40 mt-0.5">{timeStr}</p>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
