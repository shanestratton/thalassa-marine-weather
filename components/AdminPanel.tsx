/**
 * AdminPanel — Full-page admin view with tabs: Users, Channels, Audit Log.
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
import { toast } from './Toast';

// ── Types ──

interface AdminPanelProps {
    isOpen: boolean;
    onClose: () => void;
    onChannelDeleted?: (channelId: string) => void;
    onChannelApproved?: () => void;
}

type AdminTab = 'users' | 'channels' | 'audit';

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

    // Audit tab
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
        const [userData, requestData, pending, channels, audit] = await Promise.all([
            ChatService.listAllUsersWithRoles(),
            ChatService.getJoinRequests(),
            ChatService.getPendingChannels(),
            ChatService.getChannels(),
            ChatService.getAuditLog(50),
        ]);
        setUsers(userData);
        setJoinRequests(requestData);
        setPendingChannels(pending);
        setActiveChannels(channels);
        setAuditLog(audit);
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
                  (u.vessel_name || '').toLowerCase().includes(search.toLowerCase()),
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

    // ── Stats ──
    const adminCount = users.filter((u) => u.role === 'admin').length;
    const modCount = users.filter((u) => u.role === 'moderator').length;
    const blockedCount = users.filter((u) => u.is_blocked).length;

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
                <div className="flex gap-1 px-4 pb-2">
                    {(
                        [
                            ['users', '👥 Users'],
                            ['channels', '📡 Channels'],
                            ['audit', '📋 Audit'],
                        ] as [AdminTab, string][]
                    ).map(([t, label]) => (
                        <button
                            key={t}
                            onClick={() => setTab(t)}
                            aria-label={`${label} tab`}
                            aria-selected={tab === t}
                            role="tab"
                            className={`flex-1 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-wider transition-all min-h-[44px] ${
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
            <div className="flex-1 overflow-y-auto pb-24" role="tabpanel">
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
                                                    <img
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
                                    {[1, 2, 3, 4, 5].map((i) => (
                                        <div
                                            key={i}
                                            className="rounded-xl border border-white/[0.04] bg-white/[0.02] p-4 animate-pulse"
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className="w-9 h-9 rounded-full bg-white/[0.06]" />
                                                <div className="flex-1 space-y-2">
                                                    <div className="h-3 w-24 rounded bg-white/[0.06]" />
                                                    <div className="h-2 w-16 rounded bg-white/[0.04]" />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : filteredUsers.length === 0 ? (
                                <div className="text-center py-12 space-y-3">
                                    <div className="text-4xl">🔍</div>
                                    <p className="text-sm font-semibold text-white/50">No Users Found</p>
                                    <p className="text-xs text-white/30">
                                        {search ? `No one matching "${search}"` : 'No users to display'}
                                    </p>
                                </div>
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
                                                    <img
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
                                                    <p className="text-[11px] text-white/30 text-center">
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

                {/* ════════ CHANNELS TAB ════════ */}
                {tab === 'channels' && (
                    <div className="px-4 pt-4 space-y-4">
                        {/* Pending Proposals */}
                        <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-sky-400/60 mb-2 px-1">
                                📋 Pending Proposals ({pendingChannels.length})
                            </p>
                            {pendingChannels.length === 0 ? (
                                <div className="text-center py-8 space-y-2">
                                    <div className="text-3xl">📭</div>
                                    <p className="text-sm font-semibold text-white/40">No Pending Proposals</p>
                                    <p className="text-xs text-white/25">
                                        Channel proposals from users will appear here
                                    </p>
                                </div>
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
                                                            <span className="text-[11px] font-bold text-white/30 bg-white/[0.05] px-1.5 py-0.5 rounded-full">
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
                                <div className="text-center py-8 space-y-2">
                                    <div className="text-3xl">📡</div>
                                    <p className="text-sm font-semibold text-white/40">No Active Channels</p>
                                    <p className="text-xs text-white/25">Approved channels will appear here</p>
                                </div>
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
                                                        <span className="text-[11px] font-bold text-white/25 bg-white/[0.04] px-1 py-0.5 rounded-full">
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

                {/* ════════ AUDIT TAB ════════ */}
                {tab === 'audit' && (
                    <div className="px-4 pt-4 space-y-2">
                        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/40 mb-2 px-1">
                            📋 Audit Trail — Last 50 Actions
                        </p>
                        {auditLog.length === 0 ? (
                            <div className="text-center py-16 space-y-3">
                                <div className="text-4xl">📋</div>
                                <p className="text-sm font-semibold text-white/40">Clean Slate</p>
                                <p className="text-xs text-white/25">
                                    Admin actions will be logged here for accountability.
                                    <br />
                                    Every role change, block, mute, and channel action is tracked.
                                </p>
                            </div>
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
                                                <span className="text-[11px] text-white/30">by</span>
                                                <span className="text-[11px] font-semibold text-white/60">
                                                    {entry.actor_name}
                                                </span>
                                            </div>
                                            {entry.details && Object.keys(entry.details).length > 0 && (
                                                <p className="text-[11px] text-white/30 mt-0.5">
                                                    {Object.entries(entry.details)
                                                        .map(([k, v]) => `${k}: ${v}`)
                                                        .join(' · ')}
                                                </p>
                                            )}
                                            <p className="text-[11px] text-white/20 mt-0.5">{timeStr}</p>
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
