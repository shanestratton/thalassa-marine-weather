/**
 * Chat Service — "Crew Talk"
 * Community chat with channels, PMs, moderation, and Supabase Realtime.
 *
 * Anti-toxicity design:
 * - Questions (🆘) float to top of channel
 * - Crew rank earned by helpful replies, not volume
 * - No message editing — encourages considered posting
 * - Mods can soft-delete, mute, and pin
 * - PMs require mutual channel activity
 */

import { createLogger } from '../utils/createLogger';
import { supabase } from './supabase';
import { Preferences } from '@capacitor/preferences';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { moderateMessage } from './ContentModerationService';
const log = createLogger('Chat');

// --- TABLES ---
const CHANNELS_TABLE = 'chat_channels';
const MESSAGES_TABLE = 'chat_messages';
const DM_TABLE = 'chat_direct_messages';
const ROLES_TABLE = 'chat_roles';

// --- PLATFORM OWNER (founding admin — cannot be demoted, blocked, or muted) ---
const PLATFORM_OWNER_EMAIL = 'shane.stratton@gmail.com';
const DM_BLOCKS_TABLE = 'dm_blocks';
const CHANNELS_CACHE_KEY = 'thalassa_chat_channels_v1';

// --- TYPES ---

export interface ChatChannel {
    id: string;
    name: string;
    description: string;
    region: string | null;
    icon: string;
    is_global: boolean;
    is_private: boolean;
    owner_id: string | null;
    parent_id: string | null;
    created_at: string;
}

export interface ChatMessage {
    id: string;
    channel_id: string;
    user_id: string;
    display_name: string;
    message: string;
    is_question: boolean;
    helpful_count: number;
    is_pinned: boolean;
    deleted_at: string | null;
    created_at: string;
}

export interface DirectMessage {
    id: string;
    sender_id: string;
    recipient_id: string;
    sender_name: string;
    message: string;
    read: boolean;
    created_at: string;
}

export type ChatRole = 'admin' | 'moderator' | 'member';

export interface UserRole {
    user_id: string;
    role: ChatRole;
    muted_until: string | null;
    is_blocked: boolean;
}

export interface UserRoleEntry {
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    vessel_name: string | null;
    role: ChatRole;
    muted_until: string | null;
    is_blocked: boolean;
}

export interface JoinRequest {
    id: string;
    channel_id: string;
    channel_name?: string;
    user_id: string;
    display_name?: string;
    avatar_url?: string | null;
    message: string;
    status: 'pending' | 'approved' | 'rejected';
    reviewed_by: string | null;
    created_at: string;
}

export interface DMConversation {
    user_id: string;
    display_name: string;
    last_message: string;
    last_at: string;
    unread_count: number;
}

// --- OFFLINE QUEUE ---
const OFFLINE_QUEUE_KEY = 'chat_offline_queue';

interface QueuedMessage {
    type: 'channel' | 'dm';
    channel_id?: string;
    recipient_id?: string;
    message: string;
    is_question?: boolean;
    timestamp: string;
}

// --- PRE-SEEDED CHANNELS ---
export const DEFAULT_CHANNELS: Omit<ChatChannel, 'id' | 'created_at'>[] = [
    {
        name: 'Neighbourhood Watch',
        description: 'Maritime safety alerts, suspicious activity, and community watch',
        region: null,
        icon: '🛡️',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Marketplace',
        description: 'Buy, sell, and trade gear, boats, and services',
        region: null,
        icon: '🏪',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Find Crew',
        description: 'Looking for crew or a berth? Connect here',
        region: null,
        icon: '👥',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'General',
        description: 'Open chat for all sailors',
        region: null,
        icon: '🌊',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Anchorages',
        description: 'Share and discover anchorage spots',
        region: null,
        icon: '⚓',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Fishing',
        description: 'Catches, spots, and techniques',
        region: null,
        icon: '🐟',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Repairs & Gear',
        description: 'Maintenance tips, gear reviews, workshop recs',
        region: null,
        icon: '🔧',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
    {
        name: 'Weather Talk',
        description: 'Conditions, forecasts, and sea state discussion',
        region: null,
        icon: '🌤',
        is_global: true,
        is_private: false,
        owner_id: null,
        parent_id: null,
    },
];

// --- SERVICE ---

class ChatServiceClass {
    private activeSubscriptions: Map<string, RealtimeChannel> = new Map();
    private dmSubscription: RealtimeChannel | null = null;
    private currentUserId: string | null = null;
    private currentRole: ChatRole = 'member';
    private mutedUntil: Date | null = null;
    private blocked: boolean = false;
    private initPromise: Promise<void> | null = null;
    private ownerUserId: string | null = null; // Founding admin — immutable
    private cachedDisplayName: string | null = null; // Cached to avoid per-message DB lookup
    private _authListenerActive = false; // Prevents duplicate auth state listeners

    // --- INIT ---

    async initialize(): Promise<void> {
        // Cache init — don't re-auth on every tab switch
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._doInit();
        return this.initPromise;
    }

    private async _doInit(): Promise<void> {
        if (!supabase) return;
        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user) {
                // No user yet — allow retry on next initialize() call
                this.initPromise = null;

                // Listen for auth changes so we auto-init when user signs in
                if (!this._authListenerActive) {
                    this._authListenerActive = true;
                    supabase.auth.onAuthStateChange((event) => {
                        if (event === 'SIGNED_IN') {
                            this.initPromise = null; // Allow fresh init
                        }
                    });
                }
                return;
            }
            this.currentUserId = user.id;
            // Detect platform owner
            if (user.email === PLATFORM_OWNER_EMAIL) {
                this.ownerUserId = user.id;
            }
            // Run role load + offline sync in parallel
            await Promise.all([this.loadUserRole(), this.syncOfflineQueue()]);
        } catch (e) {
            log.warn('[Chat]', e);
            // Non-critical — will retry on next call
            this.initPromise = null; // Allow retry
        }
    }

    private async loadUserRole(): Promise<void> {
        if (!supabase || !this.currentUserId) return;
        const { data } = await supabase
            .from(ROLES_TABLE)
            .select('role, muted_until, is_blocked')
            .eq('user_id', this.currentUserId)
            .single();

        if (data) {
            this.currentRole = data.role as ChatRole;
            this.mutedUntil = data.muted_until ? new Date(data.muted_until) : null;
            this.blocked = data.is_blocked ?? false;
        }
    }

    // --- USER ACCESS ---

    async getCurrentUser(): Promise<{ id: string; email?: string } | null> {
        if (!supabase) return null;
        const {
            data: { user },
        } = await supabase.auth.getUser();
        return user ? { id: user.id, email: user.email ?? undefined } : null;
    }

    // --- CHANNELS ---

    async getChannels(): Promise<ChatChannel[]> {
        // 1. Return cached channels instantly (localStorage survives restarts)
        try {
            const cached = localStorage.getItem(CHANNELS_CACHE_KEY);
            if (cached) {
                const parsed = JSON.parse(cached) as ChatChannel[];
                if (parsed.length > 0) {
                    // Background refresh — don't await
                    this._refreshChannelsCache();
                    return parsed;
                }
            }
        } catch (e) {
            log.warn('corrupt cache — fetch fresh:', e);
        }

        // 2. No cache — fetch from Supabase
        return this._fetchAndCacheChannels();
    }

    private async _fetchAndCacheChannels(): Promise<ChatChannel[]> {
        if (!supabase) return [];
        const { data, error } = await supabase
            .from(CHANNELS_TABLE)
            .select('*')
            .eq('status', 'active')
            .order('is_global', { ascending: false })
            .order('name');

        if (error || !data || data.length === 0) return [];
        const channels = data as ChatChannel[];
        try {
            localStorage.setItem(CHANNELS_CACHE_KEY, JSON.stringify(channels));
        } catch (e) {
            log.warn('Operation failed:', e);
        }
        return channels;
    }

    private _refreshChannelsCache(): void {
        // Fire-and-forget background refresh
        this._fetchAndCacheChannels().catch((e) => {
            log.warn(``, e);
        });
    }

    /** Invalidate cached channels — next getChannels() will fetch fresh from Supabase */
    invalidateChannelCache(): void {
        try {
            localStorage.removeItem(CHANNELS_CACHE_KEY);
        } catch (e) {
            /* non-critical */
        }
    }

    /** Always fetch fresh channels from Supabase (bypasses cache) */
    async getChannelsFresh(): Promise<ChatChannel[]> {
        this.invalidateChannelCache();
        return this._fetchAndCacheChannels();
    }

    // --- MESSAGES ---

    async getMessages(channelId: string, limit = 50, offset = 0): Promise<ChatMessage[]> {
        if (!supabase) return [];
        const { data, error } = await supabase
            .from(MESSAGES_TABLE)
            .select('*')
            .eq('channel_id', channelId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) return [];
        return ((data || []) as ChatMessage[]).reverse();
    }

    async sendMessage(channelId: string, text: string, isQuestion = false): Promise<ChatMessage | null> {
        if (!supabase) {
            await this.queueOffline({
                type: 'channel',
                channel_id: channelId,
                message: text,
                is_question: isQuestion,
                timestamp: new Date().toISOString(),
            });
            return null;
        }

        // Check mute
        if (this.isMuted()) return null;

        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();
        if (authError) log.error('Auth error in sendMessage:', authError.message);
        if (!user) {
            log.error('No authenticated user — message NOT saved:', text.substring(0, 40));
            return null;
        }

        // Use cached display name — avoids per-message DB roundtrip
        let displayName = this.cachedDisplayName;
        if (!displayName) {
            displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'Sailor';
            const { data: profile } = await supabase
                .from('chat_profiles')
                .select('display_name')
                .eq('user_id', user.id)
                .single();
            if (profile?.display_name) displayName = profile.display_name;
            this.cachedDisplayName = displayName;
        }
        const resolvedName = displayName!; // Guaranteed non-null after branch above

        const { data, error } = await supabase
            .from(MESSAGES_TABLE)
            .insert({
                channel_id: channelId,
                user_id: user.id,
                display_name: resolvedName,
                message: text,
                is_question: isQuestion,
                helpful_count: 0,
                is_pinned: false,
            })
            .select()
            .single();

        if (error) {
            log.error('sendMessage INSERT failed:', error.message, error.details, error.hint);
            await this.queueOffline({
                type: 'channel',
                channel_id: channelId,
                message: text,
                is_question: isQuestion,
                timestamp: new Date().toISOString(),
            });
            return null;
        }

        // Fire-and-forget: async AI moderation check (~1-2s)
        // Message is already posted — if flagged, it gets soft-deleted
        const msg = data as ChatMessage;
        moderateMessage(msg.id, text, user.id, channelId).catch((e) => {
            log.warn(``, e);
        });

        // Fire-and-forget: push notifications for SOS questions
        if (isQuestion && data?.id) {
            this.pushSOSNotification(channelId, user.id, resolvedName, text, data.id).catch((e) => {
                log.warn(``, e);
            });
        }

        return msg;
    }

    async markHelpful(messageId: string): Promise<void> {
        if (!supabase) return;
        try {
            await supabase.rpc('increment_helpful_count', { msg_id: messageId });
        } catch (e) {
            log.warn('best effort:', e);
        }
    }

    // --- REALTIME SUBSCRIPTIONS ---

    subscribeToChannel(channelId: string, onMessage: (msg: ChatMessage) => void): () => void {
        if (!supabase) return () => {};

        // Unsubscribe existing
        this.unsubscribeChannel(channelId);

        const channel = supabase
            .channel(`chat:${channelId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: MESSAGES_TABLE,
                    filter: `channel_id=eq.${channelId}`,
                },
                (payload) => {
                    if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                        onMessage(payload.new as ChatMessage);
                    }
                },
            )
            .subscribe();

        this.activeSubscriptions.set(channelId, channel);

        return () => this.unsubscribeChannel(channelId);
    }

    private unsubscribeChannel(channelId: string): void {
        const existing = this.activeSubscriptions.get(channelId);
        if (existing && supabase) {
            supabase.removeChannel(existing);
            this.activeSubscriptions.delete(channelId);
        }
    }

    // --- DIRECT MESSAGES ---

    async getDMConversations(): Promise<DMConversation[]> {
        if (!supabase || !this.currentUserId) return [];

        // Fetch all DMs involving this user
        const { data } = await supabase
            .from(DM_TABLE)
            .select('*')
            .or(`sender_id.eq.${this.currentUserId},recipient_id.eq.${this.currentUserId}`)
            .order('created_at', { ascending: false });

        if (!data || data.length === 0) return [];

        // Group by conversation partner
        const convMap = new Map<string, DMConversation>();
        for (const dm of data as DirectMessage[]) {
            const partnerId = dm.sender_id === this.currentUserId ? dm.recipient_id : dm.sender_id;
            if (!convMap.has(partnerId)) {
                convMap.set(partnerId, {
                    user_id: partnerId,
                    display_name: dm.sender_id !== this.currentUserId ? dm.sender_name : 'Loading...',
                    last_message: dm.message,
                    last_at: dm.created_at,
                    unread_count: !dm.read && dm.recipient_id === this.currentUserId ? 1 : 0,
                });
            } else {
                const conv = convMap.get(partnerId)!;
                if (!dm.read && dm.recipient_id === this.currentUserId) {
                    conv.unread_count++;
                }
            }
        }

        return Array.from(convMap.values()).sort(
            (a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime(),
        );
    }

    async getDMThread(partnerId: string, limit = 50): Promise<DirectMessage[]> {
        if (!supabase || !this.currentUserId) return [];

        const { data } = await supabase
            .from(DM_TABLE)
            .select('*')
            .or(
                `and(sender_id.eq.${this.currentUserId},recipient_id.eq.${partnerId}),` +
                    `and(sender_id.eq.${partnerId},recipient_id.eq.${this.currentUserId})`,
            )
            .order('created_at', { ascending: true })
            .limit(limit);

        // Mark unread as read
        if (data && data.length > 0) {
            supabase
                .from(DM_TABLE)
                .update({ read: true })
                .eq('recipient_id', this.currentUserId)
                .eq('sender_id', partnerId)
                .eq('read', false)
                .then(() => {});
        }

        return (data || []) as DirectMessage[];
    }

    async sendDM(recipientId: string, text: string): Promise<DirectMessage | null | 'blocked'> {
        if (!supabase) {
            await this.queueOffline({
                type: 'dm',
                recipient_id: recipientId,
                message: text,
                timestamp: new Date().toISOString(),
            });
            return null;
        }

        if (this.isMuted()) return null;

        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();
        if (authError) log.error('Auth error in sendDM:', authError.message);
        if (!user) {
            log.error('No authenticated user — DM NOT saved');
            return null;
        }

        // Check if either party has blocked the other
        const blocked = await this.isBlocked(recipientId);
        if (blocked) {
            return 'blocked';
        }

        const displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'Sailor';

        const { data, error } = await supabase
            .from(DM_TABLE)
            .insert({
                sender_id: user.id,
                recipient_id: recipientId,
                sender_name: displayName,
                message: text,
                read: false,
            })
            .select()
            .single();

        if (error) {
            log.error('sendDM INSERT failed:', error.message, error.details, error.hint);
            await this.queueOffline({
                type: 'dm',
                recipient_id: recipientId,
                message: text,
                timestamp: new Date().toISOString(),
            });
            return null;
        }

        // Fire-and-forget Gemini moderation on DMs too
        if (data?.id) {
            moderateMessage(data.id, text, user.id, `dm_${recipientId}`).catch((e) => {
                log.warn(``, e);
            });
        }

        // Fire-and-forget: push notification to DM recipient
        if (data?.id) {
            this.queuePushNotification({
                recipientUserId: recipientId,
                type: 'dm',
                title: `💬 ${displayName}`,
                body: text.length > 100 ? text.substring(0, 97) + '...' : text,
                data: { sender_id: user.id, message_id: data.id },
            }).catch(() => {
                /* best effort */
            });
        }

        return data as DirectMessage;
    }

    // ─── PIN DROPS ────────────────────────────

    /**
     * Send a pin drop location to a DM recipient.
     * Encoded as: 📍PIN|lat|lon|label
     */
    async sendPinDrop(
        recipientId: string,
        lat: number,
        lon: number,
        label: string = 'Dropped Pin',
    ): Promise<DirectMessage | null | 'blocked'> {
        const encoded = `${PIN_DROP_PREFIX}${lat.toFixed(6)}|${lon.toFixed(6)}|${label}`;
        return this.sendDM(recipientId, encoded);
    }

    // ─── DM BLOCKS ────────────────────────────

    /** Block a user from DMing you. Directional: A blocks B = B can't DM A. */
    async blockUser(userId: string): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;
        const { error } = await supabase.from(DM_BLOCKS_TABLE).upsert(
            {
                blocker_id: this.currentUserId,
                blocked_id: userId,
            },
            { onConflict: 'blocker_id,blocked_id' },
        );
        return !error;
    }

    /** Unblock a user */
    async unblockUser(userId: string): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;
        const { error } = await supabase
            .from(DM_BLOCKS_TABLE)
            .delete()
            .eq('blocker_id', this.currentUserId)
            .eq('blocked_id', userId);
        return !error;
    }

    /** Check if DMs are blocked between current user and target (either direction) */
    async isBlocked(userId: string): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;
        const { data } = await supabase
            .from(DM_BLOCKS_TABLE)
            .select('id')
            .or(
                `and(blocker_id.eq.${this.currentUserId},blocked_id.eq.${userId}),` +
                    `and(blocker_id.eq.${userId},blocked_id.eq.${this.currentUserId})`,
            )
            .limit(1);
        return !!(data && data.length > 0);
    }

    /** Get list of user IDs blocked by the current user */
    async getBlockedUsers(): Promise<string[]> {
        if (!supabase || !this.currentUserId) return [];
        const { data } = await supabase.from(DM_BLOCKS_TABLE).select('blocked_id').eq('blocker_id', this.currentUserId);
        return (data || []).map((r: Record<string, string>) => r.blocked_id);
    }

    subscribeToDMs(onMessage: (dm: DirectMessage) => void): () => void {
        if (!supabase || !this.currentUserId) return () => {};

        if (this.dmSubscription) {
            supabase.removeChannel(this.dmSubscription);
        }

        this.dmSubscription = supabase
            .channel('dm:inbox')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: DM_TABLE,
                    filter: `recipient_id=eq.${this.currentUserId}`,
                },
                (payload) => {
                    onMessage(payload.new as DirectMessage);
                },
            )
            .subscribe();

        return () => {
            if (this.dmSubscription && supabase) {
                supabase.removeChannel(this.dmSubscription);
                this.dmSubscription = null;
            }
        };
    }

    // --- MODERATION ---

    getRole(): ChatRole {
        return this.currentRole;
    }
    isMod(): boolean {
        return this.currentRole === 'admin' || this.currentRole === 'moderator';
    }
    isAdmin(): boolean {
        return this.currentRole === 'admin';
    }
    isModerator(): boolean {
        return this.currentRole === 'moderator';
    }
    getCurrentUserId(): string | null {
        return this.currentUserId;
    }

    /**
     * Admin-only: list all registered users with their roles.
     * Joins chat_profiles with chat_roles for a complete picture.
     */
    async listAllUsersWithRoles(): Promise<UserRoleEntry[]> {
        if (!supabase || !this.isAdmin()) return [];

        // Get all profiles
        const { data: profiles } = await supabase
            .from('chat_profiles')
            .select('user_id, display_name, avatar_url, vessel_name')
            .order('display_name', { ascending: true });

        if (!profiles) return [];

        // Get all roles
        const { data: roles } = await supabase.from(ROLES_TABLE).select('user_id, role, muted_until, is_blocked');

        const roleMap = new Map<string, { role: ChatRole; muted_until: string | null; is_blocked: boolean }>();
        if (roles) {
            for (const r of roles) {
                roleMap.set(r.user_id, {
                    role: r.role as ChatRole,
                    muted_until: r.muted_until,
                    is_blocked: r.is_blocked || false,
                });
            }
        }

        return profiles.map((p) => ({
            user_id: p.user_id,
            display_name: p.display_name || 'Unknown',
            avatar_url: p.avatar_url || null,
            vessel_name: p.vessel_name || null,
            role: roleMap.get(p.user_id)?.role || ('member' as ChatRole),
            muted_until: roleMap.get(p.user_id)?.muted_until || null,
            is_blocked: roleMap.get(p.user_id)?.is_blocked || false,
        }));
    }

    isMuted(): boolean {
        // Platform-blocked users can never send
        if (this.blocked) return true;
        if (!this.mutedUntil) return false;
        if (new Date() > this.mutedUntil) {
            this.mutedUntil = null;
            return false;
        }
        return true;
    }

    getMutedUntil(): Date | null {
        return this.mutedUntil;
    }

    async deleteMessage(messageId: string): Promise<boolean> {
        if (!supabase || !this.isMod()) return false;
        const { error } = await supabase
            .from(MESSAGES_TABLE)
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', messageId);
        return !error;
    }

    async pinMessage(messageId: string, pinned: boolean): Promise<boolean> {
        if (!supabase || !this.isMod()) return false;
        const { error } = await supabase.from(MESSAGES_TABLE).update({ is_pinned: pinned }).eq('id', messageId);
        return !error;
    }

    async muteUser(userId: string, hours: number): Promise<boolean> {
        if (!supabase || !this.isMod()) return false;
        // Owner cannot be muted
        if (this.isOwnerProtected(userId)) return false;
        const mutedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

        const { error } = await supabase.from(ROLES_TABLE).upsert(
            {
                user_id: userId,
                role: 'member',
                muted_until: mutedUntil,
            },
            { onConflict: 'user_id' },
        );

        return !error;
    }

    /** Unmute a user — removes mute immediately */
    async unmuteUser(userId: string): Promise<boolean> {
        if (!supabase || !this.isMod()) return false;
        const { error } = await supabase.from(ROLES_TABLE).update({ muted_until: null }).eq('user_id', userId);
        if (!error) this.logAudit('unmute_user', userId);
        return !error;
    }

    /** Check if a user is the platform owner (immutable admin) */
    isOwnerProtected(userId: string): boolean {
        return this.ownerUserId !== null && userId === this.ownerUserId;
    }

    async setRole(userId: string, role: ChatRole): Promise<boolean> {
        // Only admins can promote/demote roles
        if (!supabase || !this.isAdmin()) return false;
        // Cannot demote yourself
        if (userId === this.currentUserId && role !== 'admin') return false;
        // Owner is untouchable — cannot be demoted by rogue admins
        if (this.isOwnerProtected(userId) && role !== 'admin') return false;

        const { error } = await supabase.from(ROLES_TABLE).upsert(
            {
                user_id: userId,
                role,
                muted_until: null,
                is_blocked: false,
            },
            { onConflict: 'user_id' },
        );

        if (!error) this.logAudit('set_role', userId, { role });
        return !error;
    }

    /** Admin-only: permanently block a user from the platform */
    async blockUserPlatform(userId: string): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        // Owner cannot be blocked
        if (this.isOwnerProtected(userId)) return false;
        const { error } = await supabase.from(ROLES_TABLE).upsert(
            {
                user_id: userId,
                role: 'member',
                is_blocked: true,
                muted_until: null,
            },
            { onConflict: 'user_id' },
        );
        if (!error) this.logAudit('block_user', userId, { action: 'blocked' });
        return !error;
    }

    /** Admin-only: unblock a platform-blocked user */
    async unblockUserPlatform(userId: string): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        const { error } = await supabase.from(ROLES_TABLE).update({ is_blocked: false }).eq('user_id', userId);
        if (!error) this.logAudit('unblock_user', userId, { action: 'unblocked' });
        return !error;
    }

    // --- AUDIT TRAIL ---
    // Logs all admin actions for accountability — catches rogue admins

    /** Log an admin action to the audit trail */
    async logAudit(action: string, targetId: string | null, details?: Record<string, unknown>): Promise<void> {
        if (!supabase || !this.currentUserId) return;
        try {
            await supabase.from('admin_audit_log').insert({
                actor_id: this.currentUserId,
                action,
                target_id: targetId,
                details: details || {},
            });
        } catch (e) {
            /* non-blocking — audit should never break the flow */
        }
    }

    /** Get recent audit log entries (admin-only) */
    async getAuditLog(limit = 50): Promise<Record<string, unknown>[]> {
        if (!supabase || !this.isAdmin()) return [];
        const { data: entries } = await supabase
            .from('admin_audit_log')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (!entries || entries.length === 0) return [];

        // Enrich with actor names
        const actorIds = [...new Set(entries.map((e: Record<string, string>) => e.actor_id))];
        const { data: profiles } = await supabase
            .from('chat_profiles')
            .select('user_id, display_name')
            .in('user_id', actorIds);

        const profileMap = new Map((profiles || []).map((p: Record<string, string>) => [p.user_id, p.display_name]));

        return entries.map((e: Record<string, unknown>) => ({
            ...e,
            actor_name: profileMap.get(e.actor_id as string) || 'Unknown',
        }));
    }

    // --- CHANNEL MANAGEMENT ---
    // Admins: create/delete channels directly
    // Mods: propose channels → admin must approve
    // Private channels: require membership, join via request

    /** Admin or Moderator: create a channel instantly */
    async createChannel(
        name: string,
        description: string,
        icon: string,
        isPrivate = false,
        region?: string,
        parentId?: string,
    ): Promise<ChatChannel | null> {
        if (!supabase || !this.isMod()) return null;

        const user = (await supabase.auth.getUser()).data.user;
        const { data, error } = await supabase
            .from(CHANNELS_TABLE)
            .insert({
                name,
                description,
                icon,
                region: region || null,
                is_global: !region,
                is_private: isPrivate,
                owner_id: user?.id || null,
                parent_id: parentId || null,
                status: 'active',
            })
            .select()
            .single();

        if (error || !data) return null;

        // Auto-add creator as first member of private channels
        if (isPrivate && user) {
            await supabase.from('channel_members').insert({
                channel_id: data.id,
                user_id: user.id,
            });
        }

        return data as ChatChannel;
    }

    /** Anyone can propose a channel (goes to 'pending' — admin approves) */
    async proposeChannel(
        name: string,
        description: string,
        icon: string,
        isPrivate = false,
        region?: string,
        parentId?: string,
    ): Promise<boolean> {
        if (!supabase) return false;

        const user = (await supabase.auth.getUser()).data.user;
        if (!user) return false;

        const { error } = await supabase.from(CHANNELS_TABLE).insert({
            name,
            description,
            icon,
            region: region || null,
            is_global: !region,
            is_private: isPrivate,
            owner_id: user.id,
            parent_id: parentId || null,
            status: 'pending',
            proposed_by: user.id,
        });

        return !error;
    }

    /** Admin: approve a pending channel proposal */
    async approveChannel(channelId: string): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;

        // Get channel info to check if private + get owner
        const { data: channel } = await supabase
            .from(CHANNELS_TABLE)
            .select('owner_id, is_private')
            .eq('id', channelId)
            .single();

        const { error } = await supabase
            .from(CHANNELS_TABLE)
            .update({ status: 'active' })
            .eq('id', channelId)
            .eq('status', 'pending');

        if (error) return false;

        // Auto-add owner as first member of private channels
        if (channel?.is_private && channel?.owner_id) {
            await supabase.from('channel_members').insert({
                channel_id: channelId,
                user_id: channel.owner_id,
            });
        }

        this.logAudit('approve_channel', channelId);
        return true;
    }

    /** Admin: reject a pending channel proposal */
    async rejectChannel(channelId: string): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        const { error } = await supabase.from(CHANNELS_TABLE).delete().eq('id', channelId).eq('status', 'pending');
        if (!error) this.logAudit('reject_channel', channelId);
        return !error;
    }

    /** Get pending channel proposals (admin view) */
    async getPendingChannels(): Promise<ChatChannel[]> {
        if (!supabase || !this.isAdmin()) return [];
        const { data } = await supabase
            .from(CHANNELS_TABLE)
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
        return (data || []) as ChatChannel[];
    }

    async editChannel(
        channelId: string,
        updates: { name?: string; description?: string; icon?: string },
    ): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        const { error } = await supabase.from(CHANNELS_TABLE).update(updates).eq('id', channelId);
        return !error;
    }

    async deleteChannel(channelId: string): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        // Get channel name for audit log
        const { data: ch } = await supabase.from(CHANNELS_TABLE).select('name').eq('id', channelId).single();
        const { error } = await supabase.from(CHANNELS_TABLE).delete().eq('id', channelId);
        if (!error) this.logAudit('delete_channel', channelId, { channel_name: ch?.name });
        return !error;
    }

    // --- PRIVATE CHANNEL MEMBERSHIP ---

    /** Check if current user is a member of a private channel */
    async isChannelMember(channelId: string): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;
        // Admins can access all channels
        if (this.isAdmin()) return true;
        const { data } = await supabase
            .from('channel_members')
            .select('user_id')
            .eq('channel_id', channelId)
            .eq('user_id', this.currentUserId)
            .single();
        return !!data;
    }

    /** Submit a join request for a private channel */
    async requestJoinChannel(channelId: string, message: string): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;

        // Check if already a member
        const isMember = await this.isChannelMember(channelId);
        if (isMember) return false;

        // Check if already has a pending request
        const { data: existing } = await supabase
            .from('channel_join_requests')
            .select('id')
            .eq('channel_id', channelId)
            .eq('user_id', this.currentUserId)
            .eq('status', 'pending')
            .single();
        if (existing) return false; // Already pending

        const { error } = await supabase.from('channel_join_requests').insert({
            channel_id: channelId,
            user_id: this.currentUserId,
            message: message.trim() || 'I would like to join this channel.',
            status: 'pending',
        });

        return !error;
    }

    /** Get current user's join request status for a channel */
    async getMyJoinRequestStatus(channelId: string): Promise<'none' | 'pending' | 'approved' | 'rejected'> {
        if (!supabase || !this.currentUserId) return 'none';
        const { data } = await supabase
            .from('channel_join_requests')
            .select('status')
            .eq('channel_id', channelId)
            .eq('user_id', this.currentUserId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
        return (data?.status as 'pending' | 'approved' | 'rejected') || 'none';
    }

    /** Admin/owner: get pending join requests (optionally for a specific channel) */
    async getJoinRequests(channelId?: string): Promise<JoinRequest[]> {
        if (!supabase || !this.isMod()) return [];

        let query = supabase
            .from('channel_join_requests')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (channelId) {
            query = query.eq('channel_id', channelId);
        }

        const { data: requests } = await query;
        if (!requests || requests.length === 0) return [];

        // Enrich with user display names and channel names
        const userIds = [...new Set(requests.map((r: Record<string, string>) => r.user_id))];
        const channelIds = [...new Set(requests.map((r: Record<string, string>) => r.channel_id))];

        const [{ data: profiles }, { data: channels }] = await Promise.all([
            supabase.from('chat_profiles').select('user_id, display_name, avatar_url').in('user_id', userIds),
            supabase.from(CHANNELS_TABLE).select('id, name').in('id', channelIds),
        ]);

        const profileMap = new Map((profiles || []).map((p: Record<string, string>) => [p.user_id, p]));
        const channelMap = new Map((channels || []).map((c: Record<string, string>) => [c.id, c.name]));

        return requests.map((r: Record<string, string>) => ({
            ...r,
            display_name: profileMap.get(r.user_id)?.display_name || 'Unknown',
            avatar_url: profileMap.get(r.user_id)?.avatar_url || null,
            channel_name: channelMap.get(r.channel_id) || 'Unknown',
        })) as JoinRequest[];
    }

    /** Admin/owner: approve a join request — adds user to channel_members */
    async approveJoinRequest(requestId: string): Promise<boolean> {
        if (!supabase || !this.isMod()) return false;

        // Get request details
        const { data: request } = await supabase
            .from('channel_join_requests')
            .select('channel_id, user_id')
            .eq('id', requestId)
            .single();

        if (!request) return false;

        // Update request status
        const { error: updateErr } = await supabase
            .from('channel_join_requests')
            .update({ status: 'approved', reviewed_by: this.currentUserId })
            .eq('id', requestId);

        if (updateErr) return false;

        // Add to channel members
        await supabase.from('channel_members').upsert(
            {
                channel_id: request.channel_id,
                user_id: request.user_id,
            },
            { onConflict: 'channel_id,user_id' },
        );

        return true;
    }

    /** Admin/owner: reject a join request */
    async rejectJoinRequest(requestId: string): Promise<boolean> {
        if (!supabase || !this.isMod()) return false;
        const { error } = await supabase
            .from('channel_join_requests')
            .update({ status: 'rejected', reviewed_by: this.currentUserId })
            .eq('id', requestId);
        return !error;
    }

    /** Leave/unsubscribe from a private channel. Owners cannot leave (delete instead). */
    async leaveChannel(channelId: string): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;

        // Check if user is the channel owner — owners can't leave
        const { data: channel } = await supabase.from(CHANNELS_TABLE).select('owner_id').eq('id', channelId).single();
        if (channel?.owner_id === this.currentUserId) return false;

        // Remove from channel_members
        const { error } = await supabase
            .from('channel_members')
            .delete()
            .eq('channel_id', channelId)
            .eq('user_id', this.currentUserId);

        return !error;
    }

    // --- PUSH NOTIFICATIONS ---

    private async queuePushNotification(opts: {
        recipientUserId: string;
        type: string;
        title: string;
        body: string;
        data?: Record<string, unknown>;
    }): Promise<void> {
        if (!supabase) return;
        try {
            await supabase.from('push_notification_queue').insert({
                recipient_user_id: opts.recipientUserId,
                notification_type: opts.type,
                title: opts.title,
                body: opts.body,
                data: opts.data || {},
            });
        } catch (e) {
            log.warn('[Chat]', e);
            /* Push notification is best-effort — never block message sending */
        }
    }

    /** Push notifications to all recent channel participants for an SOS question */
    private async pushSOSNotification(
        channelId: string,
        senderId: string,
        senderName: string,
        questionText: string,
        messageId: string,
    ): Promise<void> {
        if (!supabase) return;
        try {
            // Get unique recent contributors in this channel (last 50 messages)
            const { data: recentMessages } = await supabase
                .from(MESSAGES_TABLE)
                .select('user_id')
                .eq('channel_id', channelId)
                .order('created_at', { ascending: false })
                .limit(50);

            if (!recentMessages) return;

            const uniqueUserIds = [...new Set(recentMessages.map((m) => m.user_id))].filter((id) => id !== senderId); // Don't notify sender

            const body = questionText.length > 80 ? questionText.substring(0, 77) + '...' : questionText;

            // Queue a notification for each channel participant
            const inserts = uniqueUserIds.map((uid) => ({
                recipient_user_id: uid,
                notification_type: 'sos',
                title: `🆘 ${senderName} needs help`,
                body,
                data: { channel_id: channelId, message_id: messageId, sender_id: senderId },
            }));

            if (inserts.length > 0) {
                await supabase.from('push_notification_queue').insert(inserts);
            }
        } catch (e) {
            log.warn('[Chat]', e);
            /* Best effort */
        }
    }

    // --- OFFLINE QUEUE ---

    private async queueOffline(msg: QueuedMessage): Promise<void> {
        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            const queue: QueuedMessage[] = value ? JSON.parse(value) : [];
            queue.push(msg);
            await Preferences.set({ key: OFFLINE_QUEUE_KEY, value: JSON.stringify(queue) });
        } catch (e) {
            log.warn('best effort:', e);
        }
    }

    private async syncOfflineQueue(): Promise<void> {
        if (!supabase) return;
        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            if (!value) return;
            const queue: QueuedMessage[] = JSON.parse(value);
            if (queue.length === 0) return;

            // Clear queue first to avoid double-sends
            await Preferences.remove({ key: OFFLINE_QUEUE_KEY });

            for (const msg of queue) {
                if (msg.type === 'channel' && msg.channel_id) {
                    await this.sendMessage(msg.channel_id, msg.message, msg.is_question);
                } else if (msg.type === 'dm' && msg.recipient_id) {
                    await this.sendDM(msg.recipient_id, msg.message);
                }
            }
        } catch (e) {
            log.warn('best effort:', e);
        }
    }

    // --- UNREAD COUNT ---

    async getUnreadDMCount(): Promise<number> {
        if (!supabase || !this.currentUserId) return 0;
        const { count } = await supabase
            .from(DM_TABLE)
            .select('*', { count: 'exact', head: true })
            .eq('recipient_id', this.currentUserId)
            .eq('read', false);
        return count || 0;
    }

    // --- CLEANUP ---

    destroy(): void {
        if (!supabase) return;
        this.activeSubscriptions.forEach((_, channelId) => this.unsubscribeChannel(channelId));
        if (this.dmSubscription) {
            supabase.removeChannel(this.dmSubscription);
            this.dmSubscription = null;
        }
        this.cachedDisplayName = null;
        this.initPromise = null; // Allow fresh init on next visit (picks up login state)
    }

    /** Clear cached display name — call after profile update */
    clearDisplayNameCache(): void {
        this.cachedDisplayName = null;
    }
}

// Singleton
export const ChatService = new ChatServiceClass();

// ─── PIN DROP HELPERS (standalone for easy import) ────────────

export const PIN_DROP_PREFIX = '📍PIN|';

/**
 * Parse a pin drop from a DM message.
 * Returns null if the message is not a pin drop.
 */
export function parsePinDrop(message: string): { lat: number; lon: number; label: string } | null {
    if (!message.startsWith(PIN_DROP_PREFIX)) return null;
    const parts = message.slice(PIN_DROP_PREFIX.length).split('|');
    if (parts.length < 3) return null;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    const label = parts.slice(2).join('|');
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat, lon, label };
}
