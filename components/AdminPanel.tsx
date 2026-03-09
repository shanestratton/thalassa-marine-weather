/**
 * AdminPanel — Full-page role management view for Thalassa admins.
 * Renders as a page within the Chat section (like channels/marketplace).
 *
 * Features:
 * - List all registered users with their current roles
 * - Promote/demote: member ↔ moderator ↔ admin
 * - Block/unblock users permanently
 * - Mute/unmute users
 * - Search/filter users
 * - Admin-only visibility
 */
import React, { useState, useEffect, useCallback } from 'react';
import { ChatService, ChatRole, UserRoleEntry, JoinRequest } from '../services/ChatService';
import { triggerHaptic } from '../utils/system';

// ── Props ──

interface AdminPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

// ── Role badge colours ──

const ROLE_STYLES: Record<ChatRole, { bg: string; text: string; label: string }> = {
    admin: { bg: 'bg-amber-500/20 border-amber-500/40', text: 'text-amber-400', label: '👑 Admin' },
    moderator: { bg: 'bg-sky-500/20 border-sky-500/40', text: 'text-sky-400', label: '🛡️ Mod' },
    member: { bg: 'bg-white/[0.06] border-white/10', text: 'text-white/50', label: 'Member' },
};

// ── Component ──

export const AdminPanel: React.FC<AdminPanelProps> = ({ isOpen, onClose }) => {
    const [users, setUsers] = useState<UserRoleEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [actionUserId, setActionUserId] = useState<string | null>(null);
    const [muteHours, setMuteHours] = useState('');
    const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);

    const loadUsers = useCallback(async () => {
        setLoading(true);
        const [userData, requestData] = await Promise.all([
            ChatService.listAllUsersWithRoles(),
            ChatService.getJoinRequests(),
        ]);
        setUsers(userData);
        setJoinRequests(requestData);
        setLoading(false);
    }, []);

    useEffect(() => {
        if (isOpen) loadUsers();
    }, [isOpen, loadUsers]);

    if (!isOpen) return null;

    const currentUserId = ChatService.getCurrentUserId();

    const filteredUsers = search.trim()
        ? users.filter(u =>
            u.display_name.toLowerCase().includes(search.toLowerCase()) ||
            (u.vessel_name || '').toLowerCase().includes(search.toLowerCase())
        )
        : users;

    // ── Handlers ──

    const handleSetRole = async (userId: string, role: ChatRole) => {
        triggerHaptic('medium');
        const ok = await ChatService.setRole(userId, role);
        if (ok) {
            setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, role } : u));
            setActionUserId(null);
        }
    };

    const handleBlock = async (userId: string) => {
        triggerHaptic('heavy');
        const ok = await ChatService.blockUserPlatform(userId);
        if (ok) {
            setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, is_blocked: true, role: 'member' as ChatRole } : u));
            setActionUserId(null);
        }
    };

    const handleUnblock = async (userId: string) => {
        const ok = await ChatService.unblockUserPlatform(userId);
        if (ok) {
            setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, is_blocked: false } : u));
        }
    };

    const handleMute = async (userId: string) => {
        const hrs = parseInt(muteHours);
        if (!hrs || hrs <= 0) return;
        const ok = await ChatService.muteUser(userId, hrs);
        if (ok) {
            setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, muted_until: new Date(Date.now() + hrs * 3600000).toISOString() } : u));
            setMuteHours('');
            setActionUserId(null);
        }
    };

    const handleUnmute = async (userId: string) => {
        const ok = await ChatService.unmuteUser(userId);
        if (ok) {
            setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, muted_until: null } : u));
        }
    };

    // ── Stats ──
    const adminCount = users.filter(u => u.role === 'admin').length;
    const modCount = users.filter(u => u.role === 'moderator').length;
    const blockedCount = users.filter(u => u.is_blocked).length;

    const handleApproveJoinRequest = async (requestId: string) => {
        triggerHaptic('medium');
        const ok = await ChatService.approveJoinRequest(requestId);
        if (ok) setJoinRequests(prev => prev.filter(r => r.id !== requestId));
    };

    const handleRejectJoinRequest = async (requestId: string) => {
        triggerHaptic('light');
        const ok = await ChatService.rejectJoinRequest(requestId);
        if (ok) setJoinRequests(prev => prev.filter(r => r.id !== requestId));
    };

    return (
        <div className="flex flex-col h-full">
            {/* ── Header with back chevron ── */}
            <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-slate-900/95 border-b border-white/[0.06]">
                <button
                    onClick={onClose}
                    className="w-8 h-8 flex items-center justify-center rounded-xl bg-white/[0.04] hover:bg-white/[0.08] transition-colors"
                >
                    <svg className="w-4 h-4 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                </button>
                <div className="flex items-center gap-2 flex-1">
                    <span className="text-lg">👑</span>
                    <div>
                        <h2 className="text-sm font-bold text-amber-400">Admin Panel</h2>
                        <p className="text-[10px] text-white/40">{users.length} registered users</p>
                    </div>
                </div>
            </div>

            {/* ── Content (scrollable) ── */}
            <div className="flex-1 overflow-y-auto pb-24">
                {/* Stats row */}
                <div className="px-4 pt-4 pb-2 flex gap-2.5">
                    <div className="flex-1 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-center">
                        <p className="text-lg font-bold text-amber-400">{adminCount}</p>
                        <p className="text-[10px] text-amber-400/60 uppercase tracking-wider">Admins</p>
                    </div>
                    <div className="flex-1 px-3 py-2 rounded-xl bg-sky-500/10 border border-sky-500/20 text-center">
                        <p className="text-lg font-bold text-sky-400">{modCount}</p>
                        <p className="text-[10px] text-sky-400/60 uppercase tracking-wider">Mods</p>
                    </div>
                    <div className="flex-1 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-center">
                        <p className="text-lg font-bold text-red-400">{blockedCount}</p>
                        <p className="text-[10px] text-red-400/60 uppercase tracking-wider">Blocked</p>
                    </div>
                </div>

                {/* Search */}
                <div className="px-4 py-2">
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search users..."
                        className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors"
                    />
                </div>

                {/* Pending Join Requests */}
                {joinRequests.length > 0 && (
                    <div className="px-4 pb-2">
                        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-purple-400/60 mb-2 px-1">🙏 Join Requests ({joinRequests.length})</p>
                        <div className="space-y-2">
                            {joinRequests.map(req => (
                                <div key={req.id} className="rounded-xl border border-purple-500/15 bg-purple-500/[0.03] p-3 space-y-2">
                                    <div className="flex items-center gap-2.5">
                                        {req.avatar_url ? (
                                            <img src={req.avatar_url} className="w-8 h-8 rounded-full object-cover border border-white/10" alt="" />
                                        ) : (
                                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center text-[10px] font-bold text-white">
                                                {(req.display_name || '?')[0].toUpperCase()}
                                            </div>
                                        )}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-semibold text-white/80">{req.display_name}</p>
                                            <p className="text-[10px] text-purple-400/50">wants to join <span className="font-bold text-purple-400/70">{req.channel_name}</span></p>
                                        </div>
                                    </div>
                                    {req.message && (
                                        <p className="text-[11px] text-white/40 italic px-1">"{req.message}"</p>
                                    )}
                                    <div className="flex gap-1.5">
                                        <button
                                            onClick={() => handleRejectJoinRequest(req.id)}
                                            className="flex-1 py-1.5 rounded-lg bg-red-500/10 border border-red-500/15 text-[10px] font-bold text-red-400 active:scale-95"
                                        >
                                            ❌ Reject
                                        </button>
                                        <button
                                            onClick={() => handleApproveJoinRequest(req.id)}
                                            className="flex-1 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/15 text-[10px] font-bold text-emerald-400 active:scale-95"
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
                        <div className="text-center py-8 text-white/40 text-sm">Loading users...</div>
                    ) : filteredUsers.length === 0 ? (
                        <div className="text-center py-8 text-white/40 text-sm">No users found</div>
                    ) : (
                        filteredUsers.map(user => {
                            const isMe = user.user_id === currentUserId;
                            const roleStyle = ROLE_STYLES[user.role];
                            const isExpanded = actionUserId === user.user_id;
                            const isMuted = user.muted_until && new Date(user.muted_until) > new Date();

                            return (
                                <div key={user.user_id} className={`rounded-xl border overflow-hidden transition-all ${user.is_blocked ? 'border-red-500/20 bg-red-500/5' : 'border-white/[0.06] bg-white/[0.02]'}`}>
                                    {/* User row */}
                                    <button
                                        onClick={() => setActionUserId(isExpanded ? null : user.user_id)}
                                        className="w-full px-3.5 py-3 flex items-center gap-3 text-left"
                                    >
                                        {/* Avatar */}
                                        {user.avatar_url ? (
                                            <img src={user.avatar_url} className="w-9 h-9 rounded-full object-cover border border-white/10" alt="" />
                                        ) : (
                                            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-sky-600 to-indigo-600 flex items-center justify-center text-xs font-bold text-white">
                                                {user.display_name[0].toUpperCase()}
                                            </div>
                                        )}

                                        {/* Name + vessel */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-xs font-semibold text-white/80 truncate">{user.display_name}</span>
                                                {isMe && <span className="text-[9px] text-sky-400 font-bold">(You)</span>}
                                            </div>
                                            {user.vessel_name && (
                                                <p className="text-[10px] text-white/40 truncate">⛵ {user.vessel_name}</p>
                                            )}
                                        </div>

                                        {/* Status badges */}
                                        <div className="flex items-center gap-1.5">
                                            {user.is_blocked && (
                                                <span className="text-[9px] font-bold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded-full">BLOCKED</span>
                                            )}
                                            {isMuted && (
                                                <span className="text-[9px] font-bold text-orange-400 bg-orange-500/15 px-1.5 py-0.5 rounded-full">MUTED</span>
                                            )}
                                            <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${roleStyle.bg} ${roleStyle.text}`}>
                                                {roleStyle.label}
                                            </span>
                                        </div>
                                    </button>

                                    {/* Expanded actions */}
                                    {isExpanded && !isMe && (
                                        <div className="px-3.5 pb-3 space-y-2 border-t border-white/[0.04] pt-2">
                                            {/* Role buttons */}
                                            <div className="flex gap-1.5">
                                                <button
                                                    onClick={() => handleSetRole(user.user_id, 'admin')}
                                                    disabled={user.role === 'admin'}
                                                    className={`flex-1 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 ${user.role === 'admin'
                                                        ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
                                                        : 'bg-white/[0.04] border-white/[0.06] text-white/50 hover:border-amber-500/20'}`}
                                                >
                                                    👑 Admin
                                                </button>
                                                <button
                                                    onClick={() => handleSetRole(user.user_id, 'moderator')}
                                                    disabled={user.role === 'moderator'}
                                                    className={`flex-1 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 ${user.role === 'moderator'
                                                        ? 'bg-sky-500/20 border-sky-500/40 text-sky-400'
                                                        : 'bg-white/[0.04] border-white/[0.06] text-white/50 hover:border-sky-500/20'}`}
                                                >
                                                    🛡️ Mod
                                                </button>
                                                <button
                                                    onClick={() => handleSetRole(user.user_id, 'member')}
                                                    disabled={user.role === 'member'}
                                                    className={`flex-1 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 ${user.role === 'member'
                                                        ? 'bg-white/[0.06] border-white/10 text-white/50'
                                                        : 'bg-white/[0.04] border-white/[0.06] text-white/50 hover:border-white/20'}`}
                                                >
                                                    Member
                                                </button>
                                            </div>

                                            {/* Mute / Unmute */}
                                            {isMuted ? (
                                                <button
                                                    onClick={() => handleUnmute(user.user_id)}
                                                    className="w-full py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-bold text-emerald-400 uppercase tracking-wider active:scale-95"
                                                >
                                                    🔊 Unmute User
                                                </button>
                                            ) : (
                                                <div className="flex gap-1.5">
                                                    <input
                                                        value={muteHours}
                                                        onChange={e => setMuteHours(e.target.value.replace(/\D/g, ''))}
                                                        placeholder="Hours"
                                                        inputMode="numeric"
                                                        className="w-20 px-2.5 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none"
                                                    />
                                                    <button
                                                        onClick={() => handleMute(user.user_id)}
                                                        className="flex-1 py-2 rounded-xl bg-orange-500/10 border border-orange-500/20 text-[10px] font-bold text-orange-400 uppercase tracking-wider active:scale-95"
                                                    >
                                                        🔇 Mute for {muteHours || '?'} hrs
                                                    </button>
                                                </div>
                                            )}

                                            {/* Block / Unblock */}
                                            {user.is_blocked ? (
                                                <button
                                                    onClick={() => handleUnblock(user.user_id)}
                                                    className="w-full py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-bold text-emerald-400 uppercase tracking-wider active:scale-95"
                                                >
                                                    ✅ Unblock User
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => handleBlock(user.user_id)}
                                                    className="w-full py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] font-bold text-red-400 uppercase tracking-wider active:scale-95"
                                                >
                                                    🚫 Block Permanently
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    {/* Cannot modify self message */}
                                    {isExpanded && isMe && (
                                        <div className="px-3.5 pb-3 pt-2 border-t border-white/[0.04]">
                                            <p className="text-[10px] text-white/30 text-center">You cannot modify your own role</p>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
};
