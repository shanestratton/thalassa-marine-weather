/**
 * AdminPanel — Full-page admin view with tabs: Users, Channels, Audit Log.
 * Manages roles, channel proposals, channel deletion, and audit trail.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { ChatService, ChatRole, UserRoleEntry, JoinRequest, ChatChannel } from '../services/ChatService';
import { triggerHaptic } from '../utils/system';

// ── Types ──

interface AdminPanelProps {
    isOpen: boolean;
    onClose: () => void;
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

export const AdminPanel: React.FC<AdminPanelProps> = ({ isOpen, onClose }) => {
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
        ? users.filter(u =>
            u.display_name.toLowerCase().includes(search.toLowerCase()) ||
            (u.vessel_name || '').toLowerCase().includes(search.toLowerCase())
        )
        : users;

    const handleSetRole = async (userId: string, role: ChatRole) => {
        triggerHaptic('medium');
        const ok = await ChatService.setRole(userId, role);
        if (ok) { setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, role } : u)); setActionUserId(null); }
    };

    const handleBlock = async (userId: string) => {
        triggerHaptic('heavy');
        const ok = await ChatService.blockUserPlatform(userId);
        if (ok) { setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, is_blocked: true, role: 'member' as ChatRole } : u)); setActionUserId(null); }
    };

    const handleUnblock = async (userId: string) => {
        const ok = await ChatService.unblockUserPlatform(userId);
        if (ok) setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, is_blocked: false } : u));
    };

    const handleMute = async (userId: string) => {
        const hrs = parseInt(muteHours);
        if (!hrs || hrs <= 0) return;
        const ok = await ChatService.muteUser(userId, hrs);
        if (ok) { setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, muted_until: new Date(Date.now() + hrs * 3600000).toISOString() } : u)); setMuteHours(''); setActionUserId(null); }
    };

    const handleUnmute = async (userId: string) => {
        const ok = await ChatService.unmuteUser(userId);
        if (ok) setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, muted_until: null } : u));
    };

    const handleApproveJoinRequest = async (id: string) => {
        triggerHaptic('medium');
        const ok = await ChatService.approveJoinRequest(id);
        if (ok) setJoinRequests(prev => prev.filter(r => r.id !== id));
    };

    const handleRejectJoinRequest = async (id: string) => {
        triggerHaptic('light');
        const ok = await ChatService.rejectJoinRequest(id);
        if (ok) setJoinRequests(prev => prev.filter(r => r.id !== id));
    };

    // ── Channels Tab Handlers ──
    const handleApproveChannel = async (id: string) => {
        triggerHaptic('medium');
        const ok = await ChatService.approveChannel(id);
        if (ok) {
            setPendingChannels(prev => prev.filter(c => c.id !== id));
            const updated = await ChatService.getChannels();
            setActiveChannels(updated);
        }
    };

    const handleRejectChannel = async (id: string) => {
        triggerHaptic('light');
        const ok = await ChatService.rejectChannel(id);
        if (ok) setPendingChannels(prev => prev.filter(c => c.id !== id));
    };

    const handleDeleteChannel = async (id: string) => {
        triggerHaptic('heavy');
        const ok = await ChatService.deleteChannel(id);
        if (ok) setActiveChannels(prev => prev.filter(c => c.id !== id));
    };

    // ── Stats ──
    const adminCount = users.filter(u => u.role === 'admin').length;
    const modCount = users.filter(u => u.role === 'moderator').length;
    const blockedCount = users.filter(u => u.is_blocked).length;

    return (
        <div className="flex flex-col h-full">
            {/* ── Header ── */}
            <div className="sticky top-0 z-10 bg-slate-900/95 border-b border-white/[0.06]">
                <div className="flex items-center gap-3 px-4 py-3">
                    <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-xl bg-white/[0.04] hover:bg-white/[0.08] transition-colors">
                        <svg className="w-4 h-4 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>
                    <div className="flex items-center gap-2 flex-1">
                        <span className="text-lg">👑</span>
                        <h2 className="text-sm font-bold text-amber-400">Admin Panel</h2>
                    </div>
                </div>

                {/* Tab bar */}
                <div className="flex gap-1 px-4 pb-2">
                    {([['users', '👥 Users'], ['channels', '📡 Channels'], ['audit', '📋 Audit']] as [AdminTab, string][]).map(([t, label]) => (
                        <button
                            key={t}
                            onClick={() => setTab(t)}
                            className={`flex-1 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all ${tab === t
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
            <div className="flex-1 overflow-y-auto pb-24">
                {/* ════════ USERS TAB ════════ */}
                {tab === 'users' && (
                    <>
                        {/* Stats */}
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
                            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users..." className="w-full px-3.5 py-2.5 rounded-xl bg-white/[0.06] border border-white/10 text-sm text-white placeholder-white/30 outline-none focus:border-sky-500/40 transition-colors" />
                        </div>

                        {/* Join Requests */}
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
                                            {req.message && <p className="text-[11px] text-white/40 italic px-1">"{req.message}"</p>}
                                            <div className="flex gap-1.5">
                                                <button onClick={() => handleRejectJoinRequest(req.id)} className="flex-1 py-1.5 rounded-lg bg-red-500/10 border border-red-500/15 text-[10px] font-bold text-red-400 active:scale-95">❌ Reject</button>
                                                <button onClick={() => handleApproveJoinRequest(req.id)} className="flex-1 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/15 text-[10px] font-bold text-emerald-400 active:scale-95">✅ Approve</button>
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
                                            <button onClick={() => setActionUserId(isExpanded ? null : user.user_id)} className="w-full px-3.5 py-3 flex items-center gap-3 text-left">
                                                {user.avatar_url ? (
                                                    <img src={user.avatar_url} className="w-9 h-9 rounded-full object-cover border border-white/10" alt="" />
                                                ) : (
                                                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-sky-600 to-indigo-600 flex items-center justify-center text-xs font-bold text-white">{user.display_name[0].toUpperCase()}</div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-xs font-semibold text-white/80 truncate">{user.display_name}</span>
                                                        {isMe && <span className="text-[9px] text-sky-400 font-bold">(You)</span>}
                                                    </div>
                                                    {user.vessel_name && <p className="text-[10px] text-white/40 truncate">⛵ {user.vessel_name}</p>}
                                                </div>
                                                <div className="flex items-center gap-1.5">
                                                    {user.is_blocked && <span className="text-[9px] font-bold text-red-400 bg-red-500/15 px-1.5 py-0.5 rounded-full">BLOCKED</span>}
                                                    {isMuted && <span className="text-[9px] font-bold text-orange-400 bg-orange-500/15 px-1.5 py-0.5 rounded-full">MUTED</span>}
                                                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold ${roleStyle.bg} ${roleStyle.text}`}>{roleStyle.label}</span>
                                                </div>
                                            </button>

                                            {isExpanded && !isMe && (
                                                <div className="px-3.5 pb-3 space-y-2 border-t border-white/[0.04] pt-2">
                                                    <div className="flex gap-1.5">
                                                        {(['admin', 'moderator', 'member'] as ChatRole[]).map(r => (
                                                            <button key={r} onClick={() => handleSetRole(user.user_id, r)} disabled={user.role === r}
                                                                className={`flex-1 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-wider transition-all active:scale-95 ${user.role === r ? ROLE_STYLES[r].bg + ' ' + ROLE_STYLES[r].text : 'bg-white/[0.04] border-white/[0.06] text-white/50'}`}>
                                                                {ROLE_STYLES[r].label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                    {isMuted ? (
                                                        <button onClick={() => handleUnmute(user.user_id)} className="w-full py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-bold text-emerald-400 uppercase tracking-wider active:scale-95">🔊 Unmute User</button>
                                                    ) : (
                                                        <div className="flex gap-1.5">
                                                            <input value={muteHours} onChange={e => setMuteHours(e.target.value.replace(/\D/g, ''))} placeholder="Hours" inputMode="numeric" className="w-20 px-2.5 py-2 rounded-xl bg-white/[0.06] border border-white/10 text-xs text-white placeholder-white/30 outline-none" />
                                                            <button onClick={() => handleMute(user.user_id)} className="flex-1 py-2 rounded-xl bg-orange-500/10 border border-orange-500/20 text-[10px] font-bold text-orange-400 uppercase tracking-wider active:scale-95">🔇 Mute for {muteHours || '?'} hrs</button>
                                                        </div>
                                                    )}
                                                    {user.is_blocked ? (
                                                        <button onClick={() => handleUnblock(user.user_id)} className="w-full py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-bold text-emerald-400 uppercase tracking-wider active:scale-95">✅ Unblock User</button>
                                                    ) : (
                                                        <button onClick={() => handleBlock(user.user_id)} className="w-full py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] font-bold text-red-400 uppercase tracking-wider active:scale-95">🚫 Block Permanently</button>
                                                    )}
                                                </div>
                                            )}
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
                    </>
                )}

                {/* ════════ CHANNELS TAB ════════ */}
                {tab === 'channels' && (
                    <div className="px-4 pt-4 space-y-4">
                        {/* Pending Proposals */}
                        <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-sky-400/60 mb-2 px-1">📋 Pending Proposals ({pendingChannels.length})</p>
                            {pendingChannels.length === 0 ? (
                                <p className="text-xs text-white/30 px-1">No pending proposals</p>
                            ) : (
                                <div className="space-y-2">
                                    {pendingChannels.map(ch => (
                                        <div key={ch.id} className="rounded-xl border border-sky-500/15 bg-sky-500/[0.03] p-3 space-y-2">
                                            <div className="flex items-center gap-2.5">
                                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500/10 to-indigo-500/10 border border-sky-500/20 flex items-center justify-center text-lg">{ch.icon}</div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-1.5">
                                                        <p className="text-sm font-bold text-white/80">{ch.name}</p>
                                                        {ch.is_private && <span className="text-[8px] font-bold text-purple-400/70 bg-purple-500/10 px-1.5 py-0.5 rounded-full">PRIVATE</span>}
                                                        {ch.parent_id && <span className="text-[8px] font-bold text-white/30 bg-white/[0.05] px-1.5 py-0.5 rounded-full">SUB</span>}
                                                    </div>
                                                    <p className="text-[11px] text-white/40 truncate">{ch.description}</p>
                                                </div>
                                            </div>
                                            <div className="flex gap-1.5">
                                                <button onClick={() => handleRejectChannel(ch.id)} className="flex-1 py-1.5 rounded-lg bg-red-500/10 border border-red-500/15 text-[10px] font-bold text-red-400 active:scale-95">❌ Reject</button>
                                                <button onClick={() => handleApproveChannel(ch.id)} className="flex-1 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/15 text-[10px] font-bold text-emerald-400 active:scale-95">✅ Approve</button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Active Channels */}
                        <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-emerald-400/60 mb-2 px-1">📡 Active Channels ({activeChannels.length})</p>
                            <div className="space-y-1.5">
                                {activeChannels.map(ch => (
                                    <div key={ch.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 flex items-center gap-2.5">
                                        <span className="text-base">{ch.is_private ? '🔒' : ch.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <p className="text-xs font-semibold text-white/70">{ch.name}</p>
                                                {ch.is_private && <span className="text-[8px] font-bold text-purple-400/60 bg-purple-500/10 px-1 py-0.5 rounded-full">PRIVATE</span>}
                                                {ch.parent_id && <span className="text-[8px] font-bold text-white/25 bg-white/[0.04] px-1 py-0.5 rounded-full">SUB</span>}
                                            </div>
                                        </div>
                                        <button onClick={() => handleDeleteChannel(ch.id)} className="px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/15 text-[9px] font-bold text-red-400 active:scale-95 hover:bg-red-500/20 transition-colors">🗑️ Delete</button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* ════════ AUDIT TAB ════════ */}
                {tab === 'audit' && (
                    <div className="px-4 pt-4 space-y-2">
                        <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-white/40 mb-2 px-1">📋 Audit Trail — Last 50 Actions</p>
                        {auditLog.length === 0 ? (
                            <p className="text-xs text-white/30 text-center py-8">No audit entries yet</p>
                        ) : (
                            auditLog.map((entry, i) => {
                                const meta = AUDIT_LABELS[entry.action] || { icon: '📝', label: entry.action, color: 'text-white/50' };
                                const timestamp = new Date(entry.created_at);
                                const timeStr = timestamp.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' ' + timestamp.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });

                                return (
                                    <div key={entry.id || i} className="rounded-xl border border-white/[0.04] bg-white/[0.015] px-3 py-2.5 flex items-start gap-2.5">
                                        <span className="text-base mt-0.5">{meta.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className={`text-xs font-bold ${meta.color}`}>{meta.label}</span>
                                                <span className="text-[10px] text-white/30">by</span>
                                                <span className="text-[10px] font-semibold text-white/60">{entry.actor_name}</span>
                                            </div>
                                            {entry.details && Object.keys(entry.details).length > 0 && (
                                                <p className="text-[10px] text-white/30 mt-0.5">
                                                    {Object.entries(entry.details).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                                                </p>
                                            )}
                                            <p className="text-[9px] text-white/20 mt-0.5">{timeStr}</p>
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
