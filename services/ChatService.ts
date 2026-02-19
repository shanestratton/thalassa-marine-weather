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

import { supabase } from './supabase';
import { Preferences } from '@capacitor/preferences';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { moderateMessage } from './ContentModerationService';

// --- TABLES ---
const CHANNELS_TABLE = 'chat_channels';
const MESSAGES_TABLE = 'chat_messages';
const DM_TABLE = 'chat_direct_messages';
const ROLES_TABLE = 'chat_roles';
const DM_BLOCKS_TABLE = 'dm_blocks';

// --- TYPES ---

export interface ChatChannel {
    id: string;
    name: string;
    description: string;
    region: string | null;
    icon: string;
    is_global: boolean;
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
    { name: 'First Mates', description: 'Sailor dating — find your first mate ❤️', region: null, icon: '💕', is_global: true },
    { name: 'Find Crew', description: 'Looking for crew or a berth? Connect here', region: null, icon: '👥', is_global: true },
    { name: 'General', description: 'Open chat for all sailors', region: null, icon: '🌊', is_global: true },
    { name: 'Anchorages', description: 'Share and discover anchorage spots', region: null, icon: '⚓', is_global: true },
    { name: 'Repairs & Gear', description: 'Maintenance tips, gear reviews, workshop recs', region: null, icon: '🔧', is_global: true },
    { name: 'Fishing', description: 'Catches, spots, and techniques', region: null, icon: '🐟', is_global: true },
    { name: 'Weather Talk', description: 'Conditions, forecasts, and sea state discussion', region: null, icon: '🌤', is_global: true },
    { name: 'Marketplace', description: 'Buy, sell, and trade gear, boats, and services', region: null, icon: '🏪', is_global: true },
];

// --- SERVICE ---

class ChatServiceClass {
    private activeSubscriptions: Map<string, RealtimeChannel> = new Map();
    private dmSubscription: RealtimeChannel | null = null;
    private currentUserId: string | null = null;
    private currentRole: ChatRole = 'member';
    private mutedUntil: Date | null = null;
    private initPromise: Promise<void> | null = null;

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
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;
            this.currentUserId = user.id;
            // Run role load + offline sync in parallel
            await Promise.all([
                this.loadUserRole(),
                this.syncOfflineQueue(),
            ]);
        } catch {
            // Non-critical — will retry on next call
            this.initPromise = null; // Allow retry
        }
    }

    private async loadUserRole(): Promise<void> {
        if (!supabase || !this.currentUserId) return;
        const { data } = await supabase
            .from(ROLES_TABLE)
            .select('role, muted_until')
            .eq('user_id', this.currentUserId)
            .single();

        if (data) {
            this.currentRole = data.role as ChatRole;
            this.mutedUntil = data.muted_until ? new Date(data.muted_until) : null;
        }
    }

    // --- USER ACCESS ---

    async getCurrentUser(): Promise<{ id: string; email?: string } | null> {
        if (!supabase) return null;
        const { data: { user } } = await supabase.auth.getUser();
        return user ? { id: user.id, email: user.email ?? undefined } : null;
    }

    // --- CHANNELS ---

    async getChannels(): Promise<ChatChannel[]> {
        if (!supabase) return [];
        const { data, error } = await supabase
            .from(CHANNELS_TABLE)
            .select('*')
            .order('is_global', { ascending: false })
            .order('name');

        if (error) return [];
        return (data || []) as ChatChannel[];
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
            console.warn('[Chat] No supabase — queuing offline:', text.substring(0, 40));
            await this.queueOffline({ type: 'channel', channel_id: channelId, message: text, is_question: isQuestion, timestamp: new Date().toISOString() });
            return null;
        }

        // Check mute
        if (this.isMuted()) return null;

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError) console.error('[Chat] Auth error in sendMessage:', authError.message);
        if (!user) {
            console.error('[Chat] No authenticated user — message NOT saved:', text.substring(0, 40));
            return null;
        }

        // Check chat_profiles for custom display name first
        let displayName = user.user_metadata?.display_name || user.email?.split('@')[0] || 'Sailor';
        const { data: profile } = await supabase
            .from('chat_profiles')
            .select('display_name')
            .eq('user_id', user.id)
            .single();
        if (profile?.display_name) displayName = profile.display_name;

        const { data, error } = await supabase
            .from(MESSAGES_TABLE)
            .insert({
                channel_id: channelId,
                user_id: user.id,
                display_name: displayName,
                message: text,
                is_question: isQuestion,
                helpful_count: 0,
                is_pinned: false,
            })
            .select()
            .single();

        if (error) {
            console.error('[Chat] sendMessage INSERT failed:', error.message, error.details, error.hint);
            await this.queueOffline({ type: 'channel', channel_id: channelId, message: text, is_question: isQuestion, timestamp: new Date().toISOString() });
            return null;
        }

        console.log('[Chat] Message saved successfully, id:', data?.id);

        // Fire-and-forget: async AI moderation check (~1-2s)
        // Message is already posted — if flagged, it gets soft-deleted
        const msg = data as ChatMessage;
        moderateMessage(msg.id, text, user.id, channelId).catch(() => { });

        // Fire-and-forget: push notifications for SOS questions
        if (isQuestion && data?.id) {
            this.pushSOSNotification(channelId, user.id, displayName, text, data.id).catch(() => { });
        }

        return msg;
    }

    async markHelpful(messageId: string): Promise<void> {
        if (!supabase) return;
        try { await supabase.rpc('increment_helpful_count', { msg_id: messageId }); } catch { /* best effort */ }
    }

    // --- REALTIME SUBSCRIPTIONS ---

    subscribeToChannel(
        channelId: string,
        onMessage: (msg: ChatMessage) => void
    ): () => void {
        if (!supabase) return () => { };

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
                }
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
                    unread_count: (!dm.read && dm.recipient_id === this.currentUserId) ? 1 : 0,
                });
            } else {
                const conv = convMap.get(partnerId)!;
                if (!dm.read && dm.recipient_id === this.currentUserId) {
                    conv.unread_count++;
                }
            }
        }

        return Array.from(convMap.values()).sort((a, b) =>
            new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
        );
    }

    async getDMThread(partnerId: string, limit = 50): Promise<DirectMessage[]> {
        if (!supabase || !this.currentUserId) return [];

        const { data } = await supabase
            .from(DM_TABLE)
            .select('*')
            .or(
                `and(sender_id.eq.${this.currentUserId},recipient_id.eq.${partnerId}),` +
                `and(sender_id.eq.${partnerId},recipient_id.eq.${this.currentUserId})`
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
                .then(() => { });
        }

        return (data || []) as DirectMessage[];
    }

    async sendDM(recipientId: string, text: string): Promise<DirectMessage | null | 'blocked'> {
        if (!supabase) {
            console.warn('[Chat] No supabase — queuing DM offline');
            await this.queueOffline({ type: 'dm', recipient_id: recipientId, message: text, timestamp: new Date().toISOString() });
            return null;
        }

        if (this.isMuted()) return null;

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError) console.error('[Chat] Auth error in sendDM:', authError.message);
        if (!user) {
            console.error('[Chat] No authenticated user — DM NOT saved');
            return null;
        }

        // Check if either party has blocked the other
        const blocked = await this.isBlocked(recipientId);
        if (blocked) {
            console.warn('[Chat] DM blocked between', user.id, 'and', recipientId);
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
            console.error('[Chat] sendDM INSERT failed:', error.message, error.details, error.hint);
            await this.queueOffline({ type: 'dm', recipient_id: recipientId, message: text, timestamp: new Date().toISOString() });
            return null;
        }

        // Fire-and-forget Gemini moderation on DMs too
        if (data?.id) {
            moderateMessage(data.id, text, user.id, `dm_${recipientId}`).catch(() => { });
        }

        // Fire-and-forget: push notification to DM recipient
        if (data?.id) {
            this.queuePushNotification({
                recipientUserId: recipientId,
                type: 'dm',
                title: `💬 ${displayName}`,
                body: text.length > 100 ? text.substring(0, 97) + '...' : text,
                data: { sender_id: user.id, message_id: data.id },
            }).catch(() => { /* best effort */ });
        }

        console.log('[Chat] DM saved successfully, id:', data?.id);
        return data as DirectMessage;
    }

    // ─── DM BLOCKS ────────────────────────────

    /** Block a user from DMing you. Directional: A blocks B = B can't DM A. */
    async blockUser(userId: string): Promise<boolean> {
        if (!supabase || !this.currentUserId) return false;
        const { error } = await supabase
            .from(DM_BLOCKS_TABLE)
            .upsert({
                blocker_id: this.currentUserId,
                blocked_id: userId,
            }, { onConflict: 'blocker_id,blocked_id' });
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
                `and(blocker_id.eq.${userId},blocked_id.eq.${this.currentUserId})`
            )
            .limit(1);
        return !!(data && data.length > 0);
    }

    /** Get list of user IDs blocked by the current user */
    async getBlockedUsers(): Promise<string[]> {
        if (!supabase || !this.currentUserId) return [];
        const { data } = await supabase
            .from(DM_BLOCKS_TABLE)
            .select('blocked_id')
            .eq('blocker_id', this.currentUserId);
        return (data || []).map((r: any) => r.blocked_id);
    }

    subscribeToDMs(onMessage: (dm: DirectMessage) => void): () => void {
        if (!supabase || !this.currentUserId) return () => { };

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
                }
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

    getRole(): ChatRole { return this.currentRole; }
    isMod(): boolean { return this.currentRole === 'admin' || this.currentRole === 'moderator'; }
    isAdmin(): boolean { return this.currentRole === 'admin'; }

    isMuted(): boolean {
        if (!this.mutedUntil) return false;
        if (new Date() > this.mutedUntil) {
            this.mutedUntil = null;
            return false;
        }
        return true;
    }

    getMutedUntil(): Date | null { return this.mutedUntil; }

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
        const { error } = await supabase
            .from(MESSAGES_TABLE)
            .update({ is_pinned: pinned })
            .eq('id', messageId);
        return !error;
    }

    async muteUser(userId: string, hours: number): Promise<boolean> {
        if (!supabase || !this.isMod()) return false;
        const mutedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

        const { error } = await supabase
            .from(ROLES_TABLE)
            .upsert({
                user_id: userId,
                role: 'member',
                muted_until: mutedUntil,
            }, { onConflict: 'user_id' });

        return !error;
    }

    async setRole(userId: string, role: ChatRole): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;

        const { error } = await supabase
            .from(ROLES_TABLE)
            .upsert({
                user_id: userId,
                role,
                muted_until: null,
            }, { onConflict: 'user_id' });

        return !error;
    }

    // --- CHANNEL MANAGEMENT ---
    // Admins: create/delete channels directly
    // Mods: propose channels → admin must approve

    /** Admin-only: create a channel instantly */
    async createChannel(name: string, description: string, icon: string, region?: string): Promise<ChatChannel | null> {
        if (!supabase || !this.isAdmin()) return null;

        const { data, error } = await supabase
            .from(CHANNELS_TABLE)
            .insert({
                name,
                description,
                icon,
                region: region || null,
                is_global: !region,
                status: 'active',
            })
            .select()
            .single();

        if (error) return null;
        return data as ChatChannel;
    }

    /** Mod: propose a new channel (goes to 'pending' — needs admin approval) */
    async proposeChannel(name: string, description: string, icon: string, region?: string): Promise<boolean> {
        if (!supabase || !this.isMod()) return false;

        const user = (await supabase.auth.getUser()).data.user;
        const { error } = await supabase
            .from(CHANNELS_TABLE)
            .insert({
                name,
                description,
                icon,
                region: region || null,
                is_global: !region,
                status: 'pending',
                proposed_by: user?.id || null,
            });

        return !error;
    }

    /** Admin: approve a pending channel proposal */
    async approveChannel(channelId: string): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        const { error } = await supabase
            .from(CHANNELS_TABLE)
            .update({ status: 'active' })
            .eq('id', channelId)
            .eq('status', 'pending');
        return !error;
    }

    /** Admin: reject a pending channel proposal */
    async rejectChannel(channelId: string): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        const { error } = await supabase
            .from(CHANNELS_TABLE)
            .delete()
            .eq('id', channelId)
            .eq('status', 'pending');
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

    async editChannel(channelId: string, updates: { name?: string; description?: string; icon?: string }): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        const { error } = await supabase
            .from(CHANNELS_TABLE)
            .update(updates)
            .eq('id', channelId);
        return !error;
    }

    async deleteChannel(channelId: string): Promise<boolean> {
        if (!supabase || !this.isAdmin()) return false;
        const { error } = await supabase
            .from(CHANNELS_TABLE)
            .delete()
            .eq('id', channelId);
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
        } catch {
            /* Push notification is best-effort — never block message sending */
        }
    }

    /** Push notifications to all recent channel participants for an SOS question */
    private async pushSOSNotification(
        channelId: string, senderId: string, senderName: string,
        questionText: string, messageId: string
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

            const uniqueUserIds = [...new Set(recentMessages.map(m => m.user_id))]
                .filter(id => id !== senderId); // Don't notify sender

            const body = questionText.length > 80 ? questionText.substring(0, 77) + '...' : questionText;

            // Queue a notification for each channel participant
            const inserts = uniqueUserIds.map(uid => ({
                recipient_user_id: uid,
                notification_type: 'sos',
                title: `🆘 ${senderName} needs help`,
                body,
                data: { channel_id: channelId, message_id: messageId, sender_id: senderId },
            }));

            if (inserts.length > 0) {
                await supabase.from('push_notification_queue').insert(inserts);
            }
        } catch {
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
        } catch { /* best effort */ }
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
        } catch { /* best effort */ }
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
    }
}

// Singleton
export const ChatService = new ChatServiceClass();
