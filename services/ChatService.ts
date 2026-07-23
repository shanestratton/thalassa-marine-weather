/**
 * @filesize-justified Service class already using chat/constants sub-module. Core orchestrator pattern.
 */
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
 *
 * Sub-modules:
 *   - chat/types.ts     — Type definitions
 *   - chat/constants.ts — Table names, config, default channels, pin drop helpers
 */

import { createLogger } from '../utils/createLogger';
import { supabase } from './supabase';
import { Preferences } from '@capacitor/preferences';
import { isAuthRetryableFetchError, type RealtimeChannel, type User } from '@supabase/supabase-js';
import { moderateMessage } from './ContentModerationService';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

// ── Re-export all public types and constants ─────────────────────
export type {
    ChatChannel,
    ChatMessage,
    DirectMessage,
    ChatRole,
    UserRole,
    UserRoleEntry,
    JoinRequest,
    DMConversation,
    ChatMessageSendResult,
    DirectMessageSendResult,
} from './chat/types';
export { DEFAULT_CHANNELS, PIN_DROP_PREFIX, parsePinDrop } from './chat/constants';

// ── Internal imports from sub-modules ────────────────────────────
import type {
    ChatChannel,
    ChatMessage,
    DirectMessage,
    ChatRole,
    UserRoleEntry,
    JoinRequest,
    DMConversation,
    QueuedMessage,
    ChatMessageSendResult,
    DirectMessageSendResult,
} from './chat/types';
import {
    CHANNELS_TABLE,
    MESSAGES_TABLE,
    DM_TABLE,
    ROLES_TABLE,
    DM_BLOCKS_TABLE,
    PLATFORM_OWNER_EMAIL,
    CHANNELS_CACHE_KEY,
    OFFLINE_QUEUE_KEY,
    PIN_DROP_PREFIX,
    QUEUED_DM_SENT_EVENT,
} from './chat/constants';
import { normalizeChatMessage } from './chat/messagePolicy';

const log = createLogger('Chat');

interface OwnedQueuedMessage extends QueuedMessage {
    queue_id: string;
    /** Immutable capture owner. `null` is the separate anonymous namespace. */
    owner_user_id: string | null;
}

interface ChatOperationContext {
    readonly scope: AuthIdentityScope;
    readonly userId: string;
    readonly role: ChatRole;
    readonly ownerUserId: string | null;
    readonly muted: boolean;
}

type Privilege = 'user' | 'moderator' | 'admin';

const OFFLINE_QUEUE_QUARANTINE_KEY = `${OFFLINE_QUEUE_KEY}_quarantine_v2`;
const MAX_CHAT_PAGE_SIZE = 200;
const MAX_CHAT_PAGE_OFFSET = 10_000;
const MAX_DM_CONVERSATION_ROWS = 2_000;

function boundedInteger(value: number, fallback: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isSafePostgrestFilterId(value: string): boolean {
    return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function newQueueId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `chatq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<QueuedMessage>;
    if (candidate.type !== 'channel' && candidate.type !== 'dm') return false;
    if (normalizeChatMessage(candidate.message) === null || typeof candidate.timestamp !== 'string') return false;
    return candidate.type === 'channel'
        ? typeof candidate.channel_id === 'string' && candidate.channel_id.length > 0
        : typeof candidate.recipient_id === 'string' && candidate.recipient_id.length > 0;
}

function explicitQueueOwner(value: unknown): { known: boolean; userId: string | null } {
    if (!value || typeof value !== 'object') return { known: false, userId: null };
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'owner_user_id')) {
        const owner = record.owner_user_id;
        return owner === null || typeof owner === 'string'
            ? { known: true, userId: typeof owner === 'string' ? owner.trim() || null : null }
            : { known: false, userId: null };
    }
    // A short-lived pre-scope build may have persisted the authenticated
    // sender under either spelling. Only an explicit value is proof.
    const legacyOwner = record.user_id ?? record.userId;
    return typeof legacyOwner === 'string' && legacyOwner.trim()
        ? { known: true, userId: legacyOwner.trim() }
        : { known: false, userId: null };
}

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
    private offlineQueueMutationTail: Promise<void> = Promise.resolve();
    private offlineRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private offlineRetryAttempt = 0;
    private connectivityListenerAttached = false;
    private readonly handleOnline = (): void => {
        const scope = getAuthIdentityScope();
        this.scheduleOfflineQueueRetry(scope, 0);
    };

    constructor() {
        subscribeAuthIdentityScope((next) => {
            // Hide account-derived state synchronously. A stale initializer is
            // generation-fenced before it can restore any of these fields.
            this.activeSubscriptions.forEach((channel, channelId) => {
                if (supabase) supabase.removeChannel(channel);
                this.activeSubscriptions.delete(channelId);
            });
            if (this.dmSubscription && supabase) supabase.removeChannel(this.dmSubscription);
            this.dmSubscription = null;
            this.currentUserId = next.userId;
            this.currentRole = 'member';
            this.mutedUntil = null;
            this.blocked = false;
            this.ownerUserId = null;
            this.cachedDisplayName = null;
            this.initPromise = null;
            this.clearOfflineQueueRetry();
        });
    }

    private attachConnectivityListener(): void {
        if (this.connectivityListenerAttached || typeof window === 'undefined') return;
        window.addEventListener('online', this.handleOnline);
        this.connectivityListenerAttached = true;
    }

    private clearOfflineQueueRetry(): void {
        if (this.offlineRetryTimer !== null) {
            clearTimeout(this.offlineRetryTimer);
            this.offlineRetryTimer = null;
        }
        this.offlineRetryAttempt = 0;
    }

    private scheduleOfflineQueueRetry(scope: AuthIdentityScope, delayMs: number): void {
        if (
            !scope.userId ||
            scope.userId !== this.currentUserId ||
            !isAuthIdentityScopeCurrent(scope) ||
            typeof window === 'undefined'
        ) {
            return;
        }
        if (this.offlineRetryTimer !== null) {
            if (delayMs !== 0) return;
            clearTimeout(this.offlineRetryTimer);
        }
        this.offlineRetryTimer = setTimeout(
            () => {
                this.offlineRetryTimer = null;
                void this.flushOfflineQueueWithRetry(scope);
            },
            Math.max(0, delayMs),
        );
    }

    private async flushOfflineQueueWithRetry(scope: AuthIdentityScope): Promise<void> {
        if (
            !scope.userId ||
            scope.userId !== this.currentUserId ||
            !isAuthIdentityScopeCurrent(scope) ||
            (typeof navigator !== 'undefined' && !navigator.onLine)
        ) {
            return;
        }
        const remaining = await this.syncOfflineQueue(scope);
        if (scope.userId !== this.currentUserId || !isAuthIdentityScopeCurrent(scope)) return;
        if (remaining === 0) {
            this.offlineRetryAttempt = 0;
            return;
        }
        this.offlineRetryAttempt += 1;
        const delay = Math.min(15_000 * 2 ** Math.min(this.offlineRetryAttempt - 1, 5), 5 * 60_000);
        this.scheduleOfflineQueueRetry(scope, delay);
    }

    private captureOperation(): ChatOperationContext | null {
        const scope = getAuthIdentityScope();
        const userId = this.currentUserId;
        if (!userId || scope.userId !== userId || !isAuthIdentityScopeCurrent(scope)) return null;
        return Object.freeze({
            scope,
            userId,
            role: this.currentRole,
            ownerUserId: this.ownerUserId,
            muted: this.isMuted(),
        });
    }

    private operationIsCurrent(operation: ChatOperationContext): boolean {
        return (
            isAuthIdentityScopeCurrent(operation.scope) &&
            operation.scope.userId === operation.userId &&
            this.currentUserId === operation.userId
        );
    }

    /**
     * `getSession()` reads the locally persisted Supabase session. It is not
     * sufficient for authorizing a remote write, but it is sufficient proof
     * of which identity owns an offline queue entry when the auth server
     * cannot be reached. Every await is followed by the generation fence so
     * an account switch can never enqueue under the identity that just left.
     */
    private async hasMatchingLocalSession(operation: ChatOperationContext): Promise<boolean> {
        if (!supabase || !this.operationIsCurrent(operation)) return false;
        try {
            const {
                data: { session },
                error,
            } = await supabase.auth.getSession();
            return !error && session?.user?.id === operation.userId && this.operationIsCurrent(operation);
        } catch (error) {
            log.warn('Unable to verify local chat session:', error);
            return false;
        }
    }

    private async queueForMatchingLocalSession(
        operation: ChatOperationContext,
        message: QueuedMessage,
    ): Promise<'queued' | null> {
        if (!(await this.hasMatchingLocalSession(operation)) || !this.operationIsCurrent(operation)) return null;
        const queued = await this.queueOffline(message, operation.scope);
        return queued && this.operationIsCurrent(operation) ? 'queued' : null;
    }

    private roleAllows(role: ChatRole, privilege: Privilege): boolean {
        if (privilege === 'user') return true;
        if (privilege === 'admin') return role === 'admin';
        return role === 'admin' || role === 'moderator';
    }

    /**
     * Mutations never trust the cached user or role alone. Confirm the remote
     * auth identity, then re-read privileged roles before the first write.
     */
    private async verifyRemoteOperation(
        operation: ChatOperationContext,
        privilege: Privilege = 'user',
    ): Promise<boolean> {
        if (!supabase || !this.operationIsCurrent(operation) || !this.roleAllows(operation.role, privilege)) {
            return false;
        }
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user || user.id !== operation.userId || !this.operationIsCurrent(operation)) return false;
        if (privilege === 'user') return true;

        const { data: roleRow } = await supabase
            .from(ROLES_TABLE)
            .select('role')
            .eq('user_id', operation.userId)
            .single();
        if (!this.operationIsCurrent(operation)) return false;
        return this.roleAllows((roleRow?.role as ChatRole | undefined) ?? 'member', privilege);
    }

    private async verifyAdminOrChannelOwner(operation: ChatOperationContext, channelId: string): Promise<boolean> {
        if (!supabase || !(await this.verifyRemoteOperation(operation))) return false;
        if (operation.role === 'admin' && (await this.verifyRemoteOperation(operation, 'admin'))) return true;
        if (!this.operationIsCurrent(operation)) return false;
        const { data: channel } = await supabase.from(CHANNELS_TABLE).select('owner_id').eq('id', channelId).single();
        return this.operationIsCurrent(operation) && channel?.owner_id === operation.userId;
    }

    // --- INIT ---

    /**
     * Initialize the chat service. Authenticates with Supabase, loads the
     * user's role/mute status, and syncs any offline-queued messages.
     * Idempotent — subsequent calls return the cached init promise.
     */
    async initialize(): Promise<void> {
        // Cache init — don't re-auth on every tab switch
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._doInit();
        return this.initPromise;
    }

    private async _doInit(): Promise<void> {
        if (!supabase) return;
        const scope = getAuthIdentityScope();
        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!user || user.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) {
                // No user yet — allow retry on next initialize() call
                if (isAuthIdentityScopeCurrent(scope)) this.initPromise = null;

                // Listen for auth changes so we auto-init when user signs in
                if (!this._authListenerActive) {
                    this._authListenerActive = true;
                    supabase.auth.onAuthStateChange((event) => {
                        if (event === 'SIGNED_IN' && isAuthIdentityScopeCurrent(scope)) {
                            this.initPromise = null; // Allow fresh init
                        }
                    });
                }
                return;
            }
            this.currentUserId = user.id;
            this.attachConnectivityListener();
            // Detect platform owner
            if (user.email === PLATFORM_OWNER_EMAIL) {
                this.ownerUserId = user.id;
            }
            // Run role load + offline sync in parallel
            await Promise.all([this.loadUserRole(scope, user.id), this.flushOfflineQueueWithRetry(scope)]);
        } catch (e) {
            log.warn('[Chat]', e);
            // Non-critical — will retry on next call
            if (isAuthIdentityScopeCurrent(scope)) this.initPromise = null; // Allow retry
        }
    }

    private async loadUserRole(scope: AuthIdentityScope, userId: string): Promise<void> {
        if (!supabase || scope.userId !== userId || !isAuthIdentityScopeCurrent(scope)) return;
        const { data } = await supabase
            .from(ROLES_TABLE)
            .select('role, muted_until, is_blocked')
            .eq('user_id', userId)
            .single();

        if (data && isAuthIdentityScopeCurrent(scope) && this.currentUserId === userId) {
            this.currentRole = data.role as ChatRole;
            this.mutedUntil = data.muted_until ? new Date(data.muted_until) : null;
            this.blocked = data.is_blocked ?? false;
        }
    }

    // --- USER ACCESS ---

    async getCurrentUser(): Promise<{ id: string; email?: string } | null> {
        if (!supabase) return null;
        const scope = getAuthIdentityScope();
        const {
            data: { user },
        } = await supabase.auth.getUser();
        return user && user.id === scope.userId && isAuthIdentityScopeCurrent(scope)
            ? { id: user.id, email: user.email ?? undefined }
            : null;
    }

    // --- CHANNELS ---

    /**
     * Fetch available channels. Returns cached channels instantly from
     * localStorage and kicks off a background refresh from Supabase.
     * @returns Array of chat channels with member counts
     */
    async getChannels(): Promise<ChatChannel[]> {
        const scope = getAuthIdentityScope();
        // 1. Return cached channels instantly (localStorage survives restarts)
        try {
            const cached = localStorage.getItem(authScopedStorageKey(CHANNELS_CACHE_KEY, scope));
            if (cached) {
                const parsed = JSON.parse(cached) as ChatChannel[];
                if (parsed.length > 0) {
                    // Background refresh — don't await
                    this._refreshChannelsCache(scope);
                    return parsed;
                }
            }
        } catch (e) {
            log.warn('corrupt cache — fetch fresh:', e);
        }

        // 2. No cache — fetch from Supabase
        return this._fetchAndCacheChannels(scope);
    }

    private async _fetchAndCacheChannels(scope: AuthIdentityScope): Promise<ChatChannel[]> {
        if (!supabase) return [];
        const { data, error } = await supabase
            .from(CHANNELS_TABLE)
            .select('*')
            .eq('status', 'active')
            .order('is_global', { ascending: false })
            .order('name');

        if (error || !data || data.length === 0 || !isAuthIdentityScopeCurrent(scope)) return [];
        const channels = data as ChatChannel[];
        try {
            localStorage.setItem(authScopedStorageKey(CHANNELS_CACHE_KEY, scope), JSON.stringify(channels));
        } catch (e) {
            log.warn('Operation failed:', e);
        }
        return channels;
    }

    private _refreshChannelsCache(scope: AuthIdentityScope): void {
        // Fire-and-forget background refresh
        this._fetchAndCacheChannels(scope).catch((e) => {
            log.warn('Background channel-cache refresh failed:', e);
        });
    }

    /** Invalidate cached channels — next getChannels() will fetch fresh from Supabase */
    invalidateChannelCache(): void {
        try {
            localStorage.removeItem(authScopedStorageKey(CHANNELS_CACHE_KEY));
        } catch (e) {
            /* non-critical */
        }
    }

    /** Always fetch fresh channels from Supabase (bypasses cache) */
    async getChannelsFresh(): Promise<ChatChannel[]> {
        const scope = getAuthIdentityScope();
        this.invalidateChannelCache();
        return this._fetchAndCacheChannels(scope);
    }

    // --- MESSAGES ---

    async getMessages(channelId: string, limit = 50, offset = 0): Promise<ChatMessage[]> {
        if (!supabase) return [];
        const scope = getAuthIdentityScope();
        const immutableChannelId = channelId;
        const pageSize = boundedInteger(limit, 50, 1, MAX_CHAT_PAGE_SIZE);
        const pageOffset = boundedInteger(offset, 0, 0, MAX_CHAT_PAGE_OFFSET);
        const { data, error } = await supabase
            .from(MESSAGES_TABLE)
            .select('*')
            .eq('channel_id', immutableChannelId)
            .order('created_at', { ascending: false })
            .range(pageOffset, pageOffset + pageSize - 1);

        if (error || !isAuthIdentityScopeCurrent(scope)) return [];
        return ((data || []) as ChatMessage[]).filter((message) => message.channel_id === immutableChannelId).reverse();
    }

    /**
     * Send a message to a channel. Runs content moderation, applies
     * mute/block checks, and falls back to offline queue if Supabase
     * is unreachable.
     * @param channelId - Target channel UUID
     * @param text - Message body (trimmed, max 4000 chars enforced)
     * @param isQuestion - If true, message gets 🆘 priority and floats to top
     * @returns The sent message, `queued` when durably saved offline, or null on failure
     */
    async sendMessage(channelId: string, text: string, isQuestion = false): Promise<ChatMessageSendResult> {
        return this.sendMessageForScope(channelId, text, isQuestion, getAuthIdentityScope(), true);
    }

    private async sendMessageForScope(
        channelId: string,
        text: string,
        isQuestion: boolean,
        operationScope: AuthIdentityScope,
        queueOnFailure: boolean,
    ): Promise<ChatMessageSendResult> {
        const normalizedText = normalizeChatMessage(text);
        if (!normalizedText) return null;
        text = normalizedText;

        if (!supabase) {
            if (queueOnFailure) {
                const queued = await this.queueOffline(
                    {
                        type: 'channel',
                        channel_id: channelId,
                        message: text,
                        is_question: isQuestion,
                        timestamp: new Date().toISOString(),
                    },
                    operationScope,
                );
                return queued ? 'queued' : null;
            }
            return null;
        }

        const operation = this.captureOperation();
        if (
            !operation ||
            operation.scope !== operationScope ||
            operation.userId !== operationScope.userId ||
            operation.muted
        ) {
            return null;
        }

        const queuedMessage: QueuedMessage = {
            type: 'channel',
            channel_id: channelId,
            message: text,
            is_question: isQuestion,
            timestamp: new Date().toISOString(),
        };
        if (queueOnFailure && typeof navigator !== 'undefined' && !navigator.onLine) {
            return this.queueForMatchingLocalSession(operation, queuedMessage);
        }

        let user: User | null = null;
        try {
            const authResult = await supabase.auth.getUser();
            user = authResult.data.user;
            if (authResult.error) {
                log.error('Auth error in sendMessage:', authResult.error.message);
                if (queueOnFailure && isAuthRetryableFetchError(authResult.error)) {
                    return this.queueForMatchingLocalSession(operation, queuedMessage);
                }
                return null;
            }
        } catch (authError) {
            log.error('Auth error in sendMessage:', authError);
            if (queueOnFailure && isAuthRetryableFetchError(authError)) {
                return this.queueForMatchingLocalSession(operation, queuedMessage);
            }
            return null;
        }
        if (!user || user.id !== operation.userId || !this.operationIsCurrent(operation)) {
            log.error('No authenticated user — message NOT saved');
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
            if (!this.operationIsCurrent(operation)) return null;
            this.cachedDisplayName = displayName;
        }
        const resolvedName = displayName!; // Guaranteed non-null after branch above

        if (!this.operationIsCurrent(operation)) return null;
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

        if (!this.operationIsCurrent(operation)) return null;
        if (error) {
            log.error('sendMessage INSERT failed:', error.message);
            if (queueOnFailure) {
                const queued = await this.queueOffline(queuedMessage, operationScope);
                return queued ? 'queued' : null;
            }
            return null;
        }

        // Fire-and-forget: async AI moderation check (~1-2s)
        // Message is already posted — if flagged, it gets soft-deleted
        const msg = data as ChatMessage;
        if (this.operationIsCurrent(operation)) {
            moderateMessage(msg.id, text, operation.userId, channelId).catch((e) => {
                if (this.operationIsCurrent(operation)) log.warn(``, e);
            });
        }

        // Fire-and-forget: push notifications for SOS questions
        if (isQuestion && data?.id) {
            this.pushSOSNotification(data.id, operation).catch((e) => {
                if (!this.operationIsCurrent(operation)) return;
                log.warn(``, e);
            });
        }

        return msg;
    }

    async markHelpful(messageId: string): Promise<void> {
        if (!supabase) return;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation))) return;
        try {
            await supabase.rpc('increment_helpful_count', { msg_id: messageId });
            if (!this.operationIsCurrent(operation)) return;
        } catch (e) {
            log.warn('best effort:', e);
        }
    }

    // --- REALTIME SUBSCRIPTIONS ---

    /**
     * Subscribe to real-time messages on a channel via Supabase Realtime.
     * Returns an unsubscribe function for cleanup.
     * @param channelId - Channel to subscribe to
     * @param onMessage - Callback invoked for each new message
     * @returns Cleanup function to unsubscribe
     */
    subscribeToChannel(channelId: string, onMessage: (msg: ChatMessage) => void): () => void {
        if (!supabase) return () => {};
        const scope = getAuthIdentityScope();
        const immutableChannelId = channelId;

        // Unsubscribe existing
        this.unsubscribeChannel(immutableChannelId);

        const channel = supabase
            .channel(`chat:${immutableChannelId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: MESSAGES_TABLE,
                    filter: `channel_id=eq.${immutableChannelId}`,
                },
                (payload) => {
                    if (!isAuthIdentityScopeCurrent(scope)) return;
                    if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                        const message = payload.new as ChatMessage;
                        if (message.channel_id === immutableChannelId) onMessage(message);
                    }
                },
            )
            .subscribe();

        this.activeSubscriptions.set(immutableChannelId, channel);

        return () => {
            if (this.activeSubscriptions.get(immutableChannelId) !== channel || !supabase) return;
            supabase.removeChannel(channel);
            this.activeSubscriptions.delete(immutableChannelId);
        };
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
        if (!supabase) return [];
        const operation = this.captureOperation();
        if (!operation) return [];
        const ownerId = operation.userId;

        // Keep the client aggregation bounded. This avoids downloading an
        // account's entire private-message history merely to render its inbox.
        const { data } = await supabase
            .from(DM_TABLE)
            .select('sender_id, recipient_id, sender_name, message, created_at, read')
            .or(`sender_id.eq.${ownerId},recipient_id.eq.${ownerId}`)
            .order('created_at', { ascending: false })
            .limit(MAX_DM_CONVERSATION_ROWS);

        if (!this.operationIsCurrent(operation) || !data || data.length === 0) return [];

        // Group by conversation partner
        const convMap = new Map<string, DMConversation>();
        for (const dm of data as DirectMessage[]) {
            if (dm.sender_id !== ownerId && dm.recipient_id !== ownerId) continue;
            const partnerId = dm.sender_id === ownerId ? dm.recipient_id : dm.sender_id;
            if (!convMap.has(partnerId)) {
                convMap.set(partnerId, {
                    user_id: partnerId,
                    display_name: dm.sender_id !== ownerId ? dm.sender_name : 'Loading...',
                    last_message: dm.message,
                    last_at: dm.created_at,
                    unread_count: !dm.read && dm.recipient_id === ownerId ? 1 : 0,
                });
            } else {
                const conv = convMap.get(partnerId)!;
                if (conv.display_name === 'Loading...' && dm.sender_id === partnerId) {
                    conv.display_name = dm.sender_name;
                }
                if (!dm.read && dm.recipient_id === ownerId) {
                    conv.unread_count++;
                }
            }
        }

        const unresolvedIds = Array.from(convMap.values())
            .filter((conversation) => conversation.display_name === 'Loading...')
            .map((conversation) => conversation.user_id)
            .slice(0, 100);
        if (unresolvedIds.length > 0) {
            const { data: profiles } = await supabase
                .from('chat_profiles')
                .select('user_id, display_name')
                .in('user_id', unresolvedIds);
            if (!this.operationIsCurrent(operation)) return [];
            for (const profile of profiles || []) {
                const conversation = convMap.get(profile.user_id as string);
                if (conversation && typeof profile.display_name === 'string' && profile.display_name.trim()) {
                    conversation.display_name = profile.display_name.trim();
                }
            }
        }

        return Array.from(convMap.values()).sort(
            (a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime(),
        );
    }

    async getDMThread(partnerId: string, limit = 50): Promise<DirectMessage[]> {
        if (!supabase || !isSafePostgrestFilterId(partnerId)) return [];
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation))) return [];
        const ownerId = operation.userId;
        const immutablePartnerId = partnerId;
        const pageSize = boundedInteger(limit, 50, 1, MAX_CHAT_PAGE_SIZE);

        const { data } = await supabase
            .from(DM_TABLE)
            .select('*')
            .or(
                `and(sender_id.eq.${ownerId},recipient_id.eq.${immutablePartnerId}),` +
                    `and(sender_id.eq.${immutablePartnerId},recipient_id.eq.${ownerId})`,
            )
            .order('created_at', { ascending: false })
            .limit(pageSize);

        if (!this.operationIsCurrent(operation)) return [];
        const thread = ((data || []) as DirectMessage[])
            .filter(
                (dm) =>
                    (dm.sender_id === ownerId && dm.recipient_id === immutablePartnerId) ||
                    (dm.sender_id === immutablePartnerId && dm.recipient_id === ownerId),
            )
            .reverse();

        // Mark unread as read. Await the side effect so an identity fence can
        // stop it before it begins and callers never observe a detached write.
        if (data && data.length > 0) {
            await supabase
                .from(DM_TABLE)
                .update({ read: true })
                .eq('recipient_id', ownerId)
                .eq('sender_id', immutablePartnerId)
                .eq('read', false);
            if (!this.operationIsCurrent(operation)) return [];
        }

        return thread;
    }

    async sendDM(recipientId: string, text: string): Promise<DirectMessageSendResult> {
        return this.sendDMForScope(recipientId, text, getAuthIdentityScope(), true);
    }

    private async sendDMForScope(
        recipientId: string,
        text: string,
        operationScope: AuthIdentityScope,
        queueOnFailure: boolean,
    ): Promise<DirectMessageSendResult> {
        const normalizedText = normalizeChatMessage(text);
        if (!normalizedText) return null;
        text = normalizedText;

        if (!supabase) {
            if (queueOnFailure) {
                const queued = await this.queueOffline(
                    {
                        type: 'dm',
                        recipient_id: recipientId,
                        message: text,
                        timestamp: new Date().toISOString(),
                    },
                    operationScope,
                );
                return queued ? 'queued' : null;
            }
            return null;
        }

        const operation = this.captureOperation();
        if (
            !operation ||
            operation.scope !== operationScope ||
            operation.userId !== operationScope.userId ||
            operation.muted
        ) {
            return null;
        }

        const queuedMessage: QueuedMessage = {
            type: 'dm',
            recipient_id: recipientId,
            message: text,
            timestamp: new Date().toISOString(),
        };
        if (queueOnFailure && typeof navigator !== 'undefined' && !navigator.onLine) {
            return this.queueForMatchingLocalSession(operation, queuedMessage);
        }

        let user: User | null = null;
        try {
            const authResult = await supabase.auth.getUser();
            user = authResult.data.user;
            if (authResult.error) {
                log.error('Auth error in sendDM:', authResult.error.message);
                if (queueOnFailure && isAuthRetryableFetchError(authResult.error)) {
                    return this.queueForMatchingLocalSession(operation, queuedMessage);
                }
                return null;
            }
        } catch (authError) {
            log.error('Auth error in sendDM:', authError);
            if (queueOnFailure && isAuthRetryableFetchError(authError)) {
                return this.queueForMatchingLocalSession(operation, queuedMessage);
            }
            return null;
        }
        if (!user || user.id !== operation.userId || !this.operationIsCurrent(operation)) {
            log.error('No authenticated user — DM NOT saved');
            return null;
        }

        // Check if either party has blocked the other
        const blocked = await this.isBlockedForOperation(recipientId, operation);
        if (blocked) {
            return 'blocked';
        }
        if (!this.operationIsCurrent(operation)) return null;

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

        if (!this.operationIsCurrent(operation)) return null;
        if (error) {
            log.error('sendDM INSERT failed:', error.message);
            if (queueOnFailure) {
                const queued = await this.queueOffline(queuedMessage, operationScope);
                return queued ? 'queued' : null;
            }
            return null;
        }

        // Fire-and-forget: push notification to DM recipient
        if (data?.id) {
            this.queuePushNotification(data.id, operation).catch(() => {
                /* best effort */
            });
        }

        return data as DirectMessage;
    }

    // ─── PIN DROPS ────────────────────────────

    /**
     * Send a pin-drop location as a DM. Formats coordinates into
     * a parseable `PIN_DROP:lat,lon,name` message.
     * @param recipientId - Target user UUID
     * @param lat - Latitude
     * @param lon - Longitude
     * @param name - Human-readable location name
     */
    async sendPinDrop(
        recipientId: string,
        lat: number,
        lon: number,
        label: string = 'Dropped Pin',
    ): Promise<DirectMessageSendResult> {
        const encoded = `${PIN_DROP_PREFIX}${lat.toFixed(6)}|${lon.toFixed(6)}|${label}`;
        return this.sendDM(recipientId, encoded);
    }

    // ─── RECIPE SHARING ─────────────────────────

    /**
     * Share a recipe as a DM.
     * Encodes the recipe into a parseable message string.
     * @param recipientId - Target user UUID
     * @param recipePayload - Pre-encoded recipe share string from encodeRecipeShare()
     */
    async sendRecipeShareDM(recipientId: string, recipePayload: string): Promise<DirectMessageSendResult> {
        return this.sendDM(recipientId, recipePayload);
    }

    /**
     * Share a recipe in a channel.
     * @param channelId - Target channel UUID
     * @param recipePayload - Pre-encoded recipe share string from encodeRecipeShare()
     */
    async sendRecipeShareChannel(channelId: string, recipePayload: string): Promise<ChatMessageSendResult> {
        return this.sendMessage(channelId, recipePayload);
    }

    // ─── DM BLOCKS ────────────────────────────

    /** Block a user from DMing you. Directional: A blocks B = B can't DM A. */
    async blockUser(userId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation))) return false;
        const { error } = await supabase.from(DM_BLOCKS_TABLE).upsert(
            {
                blocker_id: operation.userId,
                blocked_id: userId,
            },
            { onConflict: 'blocker_id,blocked_id' },
        );
        return this.operationIsCurrent(operation) && !error;
    }

    /** Unblock a user */
    async unblockUser(userId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation))) return false;
        const { error } = await supabase
            .from(DM_BLOCKS_TABLE)
            .delete()
            .eq('blocker_id', operation.userId)
            .eq('blocked_id', userId);
        return this.operationIsCurrent(operation) && !error;
    }

    /** Check if DMs are blocked between current user and target (either direction) */
    async isBlocked(userId: string): Promise<boolean> {
        const operation = this.captureOperation();
        if (!operation) return false;
        return this.isBlockedForOperation(userId, operation);
    }

    private async isBlockedForOperation(userId: string, operation: ChatOperationContext): Promise<boolean> {
        if (!supabase || !this.operationIsCurrent(operation)) return false;
        const { data } = await supabase
            .from(DM_BLOCKS_TABLE)
            .select('id')
            .or(
                `and(blocker_id.eq.${operation.userId},blocked_id.eq.${userId}),` +
                    `and(blocker_id.eq.${userId},blocked_id.eq.${operation.userId})`,
            )
            .limit(1);
        return this.operationIsCurrent(operation) && !!(data && data.length > 0);
    }

    /** Get list of user IDs blocked by the current user */
    async getBlockedUsers(): Promise<string[]> {
        if (!supabase) return [];
        const operation = this.captureOperation();
        if (!operation) return [];
        const { data } = await supabase.from(DM_BLOCKS_TABLE).select('blocked_id').eq('blocker_id', operation.userId);
        if (!this.operationIsCurrent(operation)) return [];
        return (data || []).map((r: Record<string, string>) => r.blocked_id);
    }

    subscribeToDMs(onMessage: (dm: DirectMessage) => void): () => void {
        if (!supabase) return () => {};
        const operation = this.captureOperation();
        if (!operation) return () => {};

        if (this.dmSubscription) {
            supabase.removeChannel(this.dmSubscription);
        }

        const channel = supabase
            .channel('dm:inbox')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: DM_TABLE,
                    filter: `recipient_id=eq.${operation.userId}`,
                },
                (payload) => {
                    if (!this.operationIsCurrent(operation)) return;
                    const dm = payload.new as DirectMessage;
                    if (dm.recipient_id === operation.userId) onMessage(dm);
                },
            )
            .subscribe();
        this.dmSubscription = channel;

        return () => {
            if (this.dmSubscription === channel && supabase) {
                supabase.removeChannel(channel);
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
        if (!supabase) return [];
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return [];

        // Get all profiles
        const { data: profiles } = await supabase
            .from('chat_profiles')
            .select('user_id, display_name, avatar_url, vessel_name')
            .order('display_name', { ascending: true });

        if (!this.operationIsCurrent(operation) || !profiles) return [];

        // Get all roles
        const { data: roles } = await supabase.from(ROLES_TABLE).select('user_id, role, muted_until, is_blocked');
        if (!this.operationIsCurrent(operation)) return [];

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
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'moderator'))) return false;
        const { error } = await supabase
            .from(MESSAGES_TABLE)
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', messageId);
        return this.operationIsCurrent(operation) && !error;
    }

    async pinMessage(messageId: string, pinned: boolean): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'moderator'))) return false;
        const { error } = await supabase.from(MESSAGES_TABLE).update({ is_pinned: pinned }).eq('id', messageId);
        return this.operationIsCurrent(operation) && !error;
    }

    async muteUser(userId: string, hours: number): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'moderator'))) return false;
        // Owner cannot be muted
        if (operation.ownerUserId === userId) return false;
        const mutedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

        const { error } = await supabase.from(ROLES_TABLE).upsert(
            {
                user_id: userId,
                role: 'member',
                muted_until: mutedUntil,
            },
            { onConflict: 'user_id' },
        );

        return this.operationIsCurrent(operation) && !error;
    }

    /** Unmute a user — removes mute immediately */
    async unmuteUser(userId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'moderator'))) return false;
        const { error } = await supabase.from(ROLES_TABLE).update({ muted_until: null }).eq('user_id', userId);
        if (!this.operationIsCurrent(operation)) return false;
        if (!error) void this.logAuditForOperation(operation, 'unmute_user', userId);
        return !error;
    }

    /** Check if a user is the platform owner (immutable admin) */
    isOwnerProtected(userId: string): boolean {
        return this.ownerUserId !== null && userId === this.ownerUserId;
    }

    async setRole(userId: string, role: ChatRole): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return false;
        // Cannot demote yourself
        if (userId === operation.userId && role !== 'admin') return false;
        // Owner is untouchable — cannot be demoted by rogue admins
        if (operation.ownerUserId === userId && role !== 'admin') return false;

        const { error } = await supabase.from(ROLES_TABLE).upsert(
            {
                user_id: userId,
                role,
                muted_until: null,
                is_blocked: false,
            },
            { onConflict: 'user_id' },
        );

        if (!this.operationIsCurrent(operation)) return false;
        if (!error) void this.logAuditForOperation(operation, 'set_role', userId, { role });
        return !error;
    }

    /** Admin-only: permanently block a user from the platform */
    async blockUserPlatform(userId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return false;
        // Owner cannot be blocked
        if (operation.ownerUserId === userId) return false;
        const { error } = await supabase.from(ROLES_TABLE).upsert(
            {
                user_id: userId,
                role: 'member',
                is_blocked: true,
                muted_until: null,
            },
            { onConflict: 'user_id' },
        );
        if (!this.operationIsCurrent(operation)) return false;
        if (!error) void this.logAuditForOperation(operation, 'block_user', userId, { action: 'blocked' });
        return !error;
    }

    /** Admin-only: unblock a platform-blocked user */
    async unblockUserPlatform(userId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return false;
        const { error } = await supabase.from(ROLES_TABLE).update({ is_blocked: false }).eq('user_id', userId);
        if (!this.operationIsCurrent(operation)) return false;
        if (!error) void this.logAuditForOperation(operation, 'unblock_user', userId, { action: 'unblocked' });
        return !error;
    }

    // --- AUDIT TRAIL ---
    // Logs all admin actions for accountability — catches rogue admins

    /** Log an admin action to the audit trail */
    async logAudit(action: string, targetId: string | null, details?: Record<string, unknown>): Promise<void> {
        const immutableDetails = details ? { ...details } : undefined;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return;
        await this.logAuditForOperation(operation, action, targetId, immutableDetails);
    }

    private async logAuditForOperation(
        operation: ChatOperationContext,
        action: string,
        targetId: string | null,
        details?: Record<string, unknown>,
    ): Promise<void> {
        if (!supabase || !this.operationIsCurrent(operation)) return;
        try {
            await supabase.from('admin_audit_log').insert({
                actor_id: operation.userId,
                action,
                target_id: targetId,
                details: details || {},
            });
            if (!this.operationIsCurrent(operation)) return;
        } catch (e) {
            /* non-blocking — audit should never break the flow */
        }
    }

    /** Get recent audit log entries (admin-only) */
    async getAuditLog(limit = 50): Promise<Record<string, unknown>[]> {
        if (!supabase) return [];
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return [];
        const { data: entries } = await supabase
            .from('admin_audit_log')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(limit);

        if (!this.operationIsCurrent(operation) || !entries || entries.length === 0) return [];

        // Enrich with actor names
        const actorIds = [...new Set(entries.map((e: Record<string, string>) => e.actor_id))];
        const { data: profiles } = await supabase
            .from('chat_profiles')
            .select('user_id, display_name')
            .in('user_id', actorIds);
        if (!this.operationIsCurrent(operation)) return [];

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
        if (!supabase) return null;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'moderator'))) return null;
        const { data, error } = await supabase
            .from(CHANNELS_TABLE)
            .insert({
                name,
                description,
                icon,
                region: region || null,
                is_global: !region,
                is_private: isPrivate,
                owner_id: operation.userId,
                parent_id: parentId || null,
                status: 'active',
            })
            .select()
            .single();

        if (!this.operationIsCurrent(operation) || error || !data) return null;

        // Auto-add creator as first member of private channels
        if (isPrivate) {
            await supabase.from('channel_members').insert({
                channel_id: data.id,
                user_id: operation.userId,
            });
            if (!this.operationIsCurrent(operation)) return null;
        }

        return data as ChatChannel;
    }

    /**
     * Create a private voyage channel — any authenticated user can call this.
     * Used during the planning stage when a draft voyage is selected.
     * The creator becomes the channel owner (captain) and sole initial member.
     * Returns existing channel if one already exists for this voyage.
     */
    async createVoyageChannel(voyageId: string, voyageName: string): Promise<ChatChannel | null> {
        if (!supabase) return null;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation))) return null;

        // Check for existing voyage channel to avoid duplicates — check both old and new name format
        const channelName = voyageName;
        const oldChannelName = `⛵ ${voyageName}`;
        const { data: existing } = await supabase
            .from(CHANNELS_TABLE)
            .select('*')
            .eq('owner_id', operation.userId)
            .eq('is_private', true)
            .eq('status', 'active')
            .or(`name.eq.${channelName},name.eq.${oldChannelName}`)
            .limit(1);

        if (!this.operationIsCurrent(operation)) return null;
        if (existing && existing.length > 0) {
            // Migrate old format to clean name if needed
            const ch = existing[0];
            if (ch.name !== channelName || ch.icon !== '👥') {
                await supabase
                    .from(CHANNELS_TABLE)
                    .update({
                        name: channelName,
                        description: '',
                        icon: '👥',
                    })
                    .eq('id', ch.id);
                if (!this.operationIsCurrent(operation)) return null;
                ch.name = channelName;
                ch.description = '';
                ch.icon = '👥';
            }
            return ch as ChatChannel;
        }

        // Create the private voyage channel
        const { data, error } = await supabase
            .from(CHANNELS_TABLE)
            .insert({
                name: channelName,
                description: '',
                icon: '👥',
                region: null,
                is_global: false,
                is_private: true,
                owner_id: operation.userId,
                parent_id: null,
                status: 'active',
            })
            .select()
            .single();

        if (!this.operationIsCurrent(operation) || error || !data) {
            log.error('createVoyageChannel failed:', error?.message);
            return null;
        }

        // Add creator as first member (captain)
        await supabase.from('channel_members').insert({
            channel_id: data.id,
            user_id: operation.userId,
        });
        if (!this.operationIsCurrent(operation)) return null;

        // Invalidate channel cache so it appears in channel list
        this.invalidateChannelCache();

        return data as ChatChannel;
    }

    /**
     * Add a crew member to all active voyage channels owned by a captain.
     * Called when a crew invite is accepted — auto-joins the crew to the captain's voyage chat.
     */
    async addCrewToVoyageChannels(captainUserId: string, crewUserId: string): Promise<void> {
        if (!supabase) return;
        const operation = this.captureOperation();
        if (!operation || operation.userId !== crewUserId || !(await this.verifyRemoteOperation(operation))) {
            return;
        }
        const { data: joinedCount, error } = await supabase.rpc('join_accepted_crew_channels', {
            p_owner_id: captainUserId,
        });
        if (!this.operationIsCurrent(operation)) return;
        if (error) {
            log.warn('Could not join accepted crew channels:', error.message);
            return;
        }
        log.info(`Added crew ${crewUserId} to ${joinedCount ?? 0} voyage channel(s) for captain ${captainUserId}`);
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
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation))) return false;

        const { error } = await supabase.from(CHANNELS_TABLE).insert({
            name,
            description,
            icon,
            region: region || null,
            is_global: !region,
            is_private: isPrivate,
            owner_id: operation.userId,
            parent_id: parentId || null,
            status: 'pending',
            proposed_by: operation.userId,
        });

        return this.operationIsCurrent(operation) && !error;
    }

    /** Admin: approve a pending channel proposal */
    async approveChannel(channelId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return false;

        // Get channel info to check if private + get owner
        const { data: channel } = await supabase
            .from(CHANNELS_TABLE)
            .select('owner_id, is_private')
            .eq('id', channelId)
            .single();
        if (!this.operationIsCurrent(operation)) return false;

        const { error } = await supabase
            .from(CHANNELS_TABLE)
            .update({ status: 'active' })
            .eq('id', channelId)
            .eq('status', 'pending');

        if (!this.operationIsCurrent(operation) || error) return false;

        // Auto-add owner as first member of private channels
        if (channel?.is_private && channel?.owner_id) {
            await supabase.from('channel_members').insert({
                channel_id: channelId,
                user_id: channel.owner_id,
            });
            if (!this.operationIsCurrent(operation)) return false;
        }

        void this.logAuditForOperation(operation, 'approve_channel', channelId);
        return true;
    }

    /** Admin: reject a pending channel proposal */
    async rejectChannel(channelId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return false;
        const { error } = await supabase.from(CHANNELS_TABLE).delete().eq('id', channelId).eq('status', 'pending');
        if (!this.operationIsCurrent(operation)) return false;
        if (!error) void this.logAuditForOperation(operation, 'reject_channel', channelId);
        return !error;
    }

    /** Get pending channel proposals (admin view) */
    async getPendingChannels(): Promise<ChatChannel[]> {
        if (!supabase) return [];
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return [];
        const { data } = await supabase
            .from(CHANNELS_TABLE)
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
        return this.operationIsCurrent(operation) ? ((data || []) as ChatChannel[]) : [];
    }

    async editChannel(
        channelId: string,
        updates: { name?: string; description?: string; icon?: string },
    ): Promise<boolean> {
        if (!supabase) return false;
        const immutableUpdates = { ...updates };
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return false;
        const { error } = await supabase.from(CHANNELS_TABLE).update(immutableUpdates).eq('id', channelId);
        return this.operationIsCurrent(operation) && !error;
    }

    async deleteChannel(channelId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation, 'admin'))) return false;
        // Get channel name for audit log
        const { data: ch } = await supabase.from(CHANNELS_TABLE).select('name').eq('id', channelId).single();
        if (!this.operationIsCurrent(operation)) return false;
        const { error } = await supabase.from(CHANNELS_TABLE).delete().eq('id', channelId);
        if (!this.operationIsCurrent(operation)) return false;
        if (!error) void this.logAuditForOperation(operation, 'delete_channel', channelId, { channel_name: ch?.name });
        return !error;
    }

    // --- PRIVATE CHANNEL MEMBERSHIP ---

    /** Check if current user is a member of a private channel */
    async isChannelMember(channelId: string): Promise<boolean> {
        const operation = this.captureOperation();
        if (!operation) return false;
        return this.isChannelMemberForOperation(channelId, operation);
    }

    private async isChannelMemberForOperation(channelId: string, operation: ChatOperationContext): Promise<boolean> {
        if (!supabase || !this.operationIsCurrent(operation)) return false;
        // Admins can access all channels
        if (operation.role === 'admin') return this.verifyRemoteOperation(operation, 'admin');
        const { data } = await supabase
            .from('channel_members')
            .select('user_id')
            .eq('channel_id', channelId)
            .eq('user_id', operation.userId)
            .single();
        return this.operationIsCurrent(operation) && !!data;
    }

    /** Submit a join request for a private channel */
    async requestJoinChannel(channelId: string, message: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation))) return false;

        // Check if already a member
        const isMember = await this.isChannelMemberForOperation(channelId, operation);
        if (!this.operationIsCurrent(operation)) return false;
        if (isMember) return false;

        // Check if already has a pending request
        const { data: existing } = await supabase
            .from('channel_join_requests')
            .select('id')
            .eq('channel_id', channelId)
            .eq('user_id', operation.userId)
            .eq('status', 'pending')
            .single();
        if (!this.operationIsCurrent(operation) || existing) return false; // Already pending

        const { error } = await supabase.from('channel_join_requests').insert({
            channel_id: channelId,
            user_id: operation.userId,
            message: message.trim() || 'I would like to join this channel.',
            status: 'pending',
        });

        return this.operationIsCurrent(operation) && !error;
    }

    /** Get current user's join request status for a channel */
    async getMyJoinRequestStatus(channelId: string): Promise<'none' | 'pending' | 'approved' | 'rejected'> {
        if (!supabase) return 'none';
        const operation = this.captureOperation();
        if (!operation) return 'none';
        const { data } = await supabase
            .from('channel_join_requests')
            .select('status')
            .eq('channel_id', channelId)
            .eq('user_id', operation.userId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
        return this.operationIsCurrent(operation)
            ? (data?.status as 'pending' | 'approved' | 'rejected') || 'none'
            : 'none';
    }

    /** Admin/owner: get pending join requests (optionally for a specific channel) */
    async getJoinRequests(channelId?: string): Promise<JoinRequest[]> {
        if (!supabase) return [];
        const operation = this.captureOperation();
        if (!operation) return [];
        if (channelId) {
            if (!(await this.verifyAdminOrChannelOwner(operation, channelId))) return [];
        } else if (!(await this.verifyRemoteOperation(operation, 'admin'))) {
            return [];
        }

        let query = supabase
            .from('channel_join_requests')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (channelId) {
            query = query.eq('channel_id', channelId);
        }

        const { data: requests } = await query;
        if (!this.operationIsCurrent(operation) || !requests || requests.length === 0) return [];

        // Enrich with user display names and channel names
        const userIds = [...new Set(requests.map((r: Record<string, string>) => r.user_id))];
        const channelIds = [...new Set(requests.map((r: Record<string, string>) => r.channel_id))];

        const [{ data: profiles }, { data: channels }] = await Promise.all([
            supabase.from('chat_profiles').select('user_id, display_name, avatar_url').in('user_id', userIds),
            supabase.from(CHANNELS_TABLE).select('id, name').in('id', channelIds),
        ]);
        if (!this.operationIsCurrent(operation)) return [];

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
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation) return false;

        // Get request details
        const { data: request } = await supabase
            .from('channel_join_requests')
            .select('channel_id, user_id')
            .eq('id', requestId)
            .single();

        if (!this.operationIsCurrent(operation) || !request) return false;
        if (!(await this.verifyAdminOrChannelOwner(operation, request.channel_id))) return false;

        // Update request status
        const { error: updateErr } = await supabase
            .from('channel_join_requests')
            .update({ status: 'approved', reviewed_by: operation.userId })
            .eq('id', requestId);

        if (!this.operationIsCurrent(operation) || updateErr) return false;

        // Add to channel members
        await supabase.from('channel_members').upsert(
            {
                channel_id: request.channel_id,
                user_id: request.user_id,
            },
            { onConflict: 'channel_id,user_id' },
        );

        return this.operationIsCurrent(operation);
    }

    /** Admin/owner: reject a join request */
    async rejectJoinRequest(requestId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation) return false;
        const { data: request } = await supabase
            .from('channel_join_requests')
            .select('channel_id')
            .eq('id', requestId)
            .single();
        if (!this.operationIsCurrent(operation) || !request) return false;
        if (!(await this.verifyAdminOrChannelOwner(operation, request.channel_id))) return false;
        const { error } = await supabase
            .from('channel_join_requests')
            .update({ status: 'rejected', reviewed_by: operation.userId })
            .eq('id', requestId);
        return this.operationIsCurrent(operation) && !error;
    }

    /** Leave/unsubscribe from a private channel. Owners cannot leave (delete instead). */
    async leaveChannel(channelId: string): Promise<boolean> {
        if (!supabase) return false;
        const operation = this.captureOperation();
        if (!operation || !(await this.verifyRemoteOperation(operation))) return false;

        // Check if user is the channel owner — owners can't leave
        const { data: channel } = await supabase.from(CHANNELS_TABLE).select('owner_id').eq('id', channelId).single();
        if (!this.operationIsCurrent(operation) || channel?.owner_id === operation.userId) return false;

        // Remove from channel_members
        const { error } = await supabase
            .from('channel_members')
            .delete()
            .eq('channel_id', channelId)
            .eq('user_id', operation.userId);

        return this.operationIsCurrent(operation) && !error;
    }

    // --- PUSH NOTIFICATIONS ---

    private async queuePushNotification(messageId: string, operation: ChatOperationContext): Promise<void> {
        if (!supabase || !this.operationIsCurrent(operation)) return;
        try {
            await supabase.rpc('queue_dm_push', { p_message_id: messageId });
            if (!this.operationIsCurrent(operation)) return;
        } catch (e) {
            log.warn('[Chat]', e);
            /* Push notification is best-effort — never block message sending */
        }
    }

    /** Push notifications to all recent channel participants for an SOS question */
    private async pushSOSNotification(messageId: string, operation: ChatOperationContext): Promise<void> {
        if (!supabase || !this.operationIsCurrent(operation)) return;
        try {
            await supabase.rpc('queue_sos_push', { p_message_id: messageId });
            if (!this.operationIsCurrent(operation)) return;
        } catch (e) {
            log.warn('[Chat]', e);
            /* Best effort */
        }
    }

    // --- OFFLINE QUEUE ---

    private withOfflineQueueLock<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.offlineQueueMutationTail.then(operation, operation);
        this.offlineQueueMutationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private async quarantineQueueValues(values: unknown[]): Promise<void> {
        if (values.length === 0) return;
        let existing: unknown[] = [];
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_QUARANTINE_KEY });
        if (value) {
            try {
                const parsed = JSON.parse(value) as unknown;
                if (Array.isArray(parsed)) existing = parsed;
            } catch {
                existing = [{ unreadable_legacy_payload: value }];
            }
        }
        await Preferences.set({
            key: OFFLINE_QUEUE_QUARANTINE_KEY,
            value: JSON.stringify([
                ...existing,
                {
                    quarantined_at: new Date().toISOString(),
                    reason: 'missing or ambiguous queue ownership',
                    values,
                },
            ]),
        });
    }

    /**
     * Move only provably-owned values out of the historical global key.
     * Unattributed messages are preserved in a non-replayable quarantine;
     * values explicitly owned by another account remain for that account.
     */
    private async migrateLegacyOfflineQueue(scope: AuthIdentityScope): Promise<void> {
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(value) as unknown;
        } catch {
            await this.quarantineQueueValues([{ unreadable_legacy_payload: value }]);
            await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
            return;
        }
        if (!Array.isArray(parsed)) {
            await this.quarantineQueueValues([parsed]);
            await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
            return;
        }

        const adopting: OwnedQueuedMessage[] = [];
        const remaining: unknown[] = [];
        const ambiguous: unknown[] = [];
        for (const value of parsed) {
            const owner = explicitQueueOwner(value);
            if (!owner.known || !isQueuedMessage(value)) {
                ambiguous.push(value);
                continue;
            }
            if (owner.userId !== scope.userId) {
                remaining.push(value);
                continue;
            }
            const record = value as QueuedMessage & Partial<OwnedQueuedMessage>;
            adopting.push({
                ...record,
                queue_id: typeof record.queue_id === 'string' && record.queue_id ? record.queue_id : newQueueId(),
                owner_user_id: scope.userId,
            });
        }

        if (adopting.length > 0) {
            const scopedKey = authScopedStorageKey(OFFLINE_QUEUE_KEY, scope);
            const existing = await this.readScopedQueue(scopedKey, scope);
            const existingIds = new Set(existing.map((message) => message.queue_id));
            const merged = [...existing, ...adopting.filter((message) => !existingIds.has(message.queue_id))];
            await Preferences.set({ key: scopedKey, value: JSON.stringify(merged) });
        }
        await this.quarantineQueueValues(ambiguous);
        if (remaining.length > 0) {
            await Preferences.set({ key: OFFLINE_QUEUE_KEY, value: JSON.stringify(remaining) });
        } else {
            await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
        }
    }

    private async readScopedQueue(key: string, scope: AuthIdentityScope): Promise<OwnedQueuedMessage[]> {
        const { value } = await Preferences.get({ key });
        if (!value) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(value) as unknown;
        } catch {
            await this.quarantineQueueValues([{ scoped_key: key, unreadable_payload: value }]);
            await Preferences.remove({ key });
            return [];
        }
        if (!Array.isArray(parsed)) {
            await this.quarantineQueueValues([{ scoped_key: key, value: parsed }]);
            await Preferences.remove({ key });
            return [];
        }

        const queue: OwnedQueuedMessage[] = [];
        const rejected: unknown[] = [];
        let normalized = false;
        for (const value of parsed) {
            if (!isQueuedMessage(value)) {
                rejected.push(value);
                continue;
            }
            const record = value as QueuedMessage & Partial<OwnedQueuedMessage>;
            // The scoped key itself proves ownership for queues written by the
            // first scoped release, which did not yet serialize the field.
            const owner = explicitQueueOwner(value);
            if (owner.known && owner.userId !== scope.userId) {
                rejected.push(value);
                continue;
            }
            const owned: OwnedQueuedMessage = {
                ...record,
                queue_id: typeof record.queue_id === 'string' && record.queue_id ? record.queue_id : newQueueId(),
                owner_user_id: scope.userId,
            };
            if (owned.queue_id !== record.queue_id || owned.owner_user_id !== record.owner_user_id) normalized = true;
            queue.push(owned);
        }
        await this.quarantineQueueValues(rejected);
        if (normalized || rejected.length > 0) {
            if (queue.length > 0) await Preferences.set({ key, value: JSON.stringify(queue) });
            else await Preferences.remove({ key });
        }
        return queue;
    }

    private async queueOffline(
        msg: QueuedMessage,
        scope: AuthIdentityScope = getAuthIdentityScope(),
    ): Promise<boolean> {
        const owned: OwnedQueuedMessage = {
            ...msg,
            queue_id: newQueueId(),
            owner_user_id: scope.userId,
        };
        try {
            await this.withOfflineQueueLock(async () => {
                await this.migrateLegacyOfflineQueue(scope);
                const key = authScopedStorageKey(OFFLINE_QUEUE_KEY, scope);
                const queue = await this.readScopedQueue(key, scope);
                queue.push(owned);
                await Preferences.set({ key, value: JSON.stringify(queue) });
            });
            if (scope.userId === this.currentUserId && isAuthIdentityScopeCurrent(scope)) {
                this.scheduleOfflineQueueRetry(scope, 15_000);
            }
            return true;
        } catch (e) {
            log.warn('queueOffline best effort:', e);
            return false;
        }
    }

    private async syncOfflineQueue(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<number> {
        if (!supabase) return 0;
        if (!scope.userId || this.currentUserId !== scope.userId || !isAuthIdentityScopeCurrent(scope)) return 0;
        try {
            const key = authScopedStorageKey(OFFLINE_QUEUE_KEY, scope);
            const queue = await this.withOfflineQueueLock(async () => {
                await this.migrateLegacyOfflineQueue(scope);
                return this.readScopedQueue(key, scope);
            });
            if (queue.length === 0) return 0;

            for (const msg of queue) {
                if (!isAuthIdentityScopeCurrent(scope)) return 0;
                let sent = false;
                let confirmedDirectMessage: DirectMessage | null = null;
                if (msg.type === 'channel' && msg.channel_id) {
                    const result = await this.sendMessageForScope(
                        msg.channel_id,
                        msg.message,
                        msg.is_question ?? false,
                        scope,
                        false,
                    );
                    sent = result !== null && result !== 'queued';
                } else if (msg.type === 'dm' && msg.recipient_id) {
                    const result = await this.sendDMForScope(msg.recipient_id, msg.message, scope, false);
                    sent = result !== null && result !== 'blocked' && result !== 'queued';
                    if (result && result !== 'blocked' && result !== 'queued') {
                        confirmedDirectMessage = result;
                    }
                }
                if (!sent) continue;
                if (confirmedDirectMessage && typeof window !== 'undefined' && isAuthIdentityScopeCurrent(scope)) {
                    window.dispatchEvent(
                        new CustomEvent(QUEUED_DM_SENT_EVENT, {
                            detail: {
                                ownerUserId: scope.userId,
                                message: confirmedDirectMessage,
                            },
                        }),
                    );
                }

                // Re-read under the mutation lock so concurrent appends survive.
                // Remove exactly this confirmed-success operation, never the
                // whole queue and never another account's scoped key.
                await this.withOfflineQueueLock(async () => {
                    const live = await this.readScopedQueue(key, scope);
                    const remaining = live.filter(
                        (candidate) =>
                            candidate.queue_id !== msg.queue_id || candidate.owner_user_id !== msg.owner_user_id,
                    );
                    if (remaining.length === 0) await Preferences.remove({ key });
                    else await Preferences.set({ key, value: JSON.stringify(remaining) });
                });
            }
            if (!isAuthIdentityScopeCurrent(scope)) return 0;
            return this.withOfflineQueueLock(async () => {
                const remaining = await this.readScopedQueue(key, scope);
                return remaining.length;
            });
        } catch (e) {
            log.warn('best effort:', e);
            return 1;
        }
    }

    // --- UNREAD COUNT ---

    async getUnreadDMCount(): Promise<number> {
        if (!supabase) return 0;
        const operation = this.captureOperation();
        if (!operation) return 0;
        const { count } = await supabase
            .from(DM_TABLE)
            .select('*', { count: 'exact', head: true })
            .eq('recipient_id', operation.userId)
            .eq('read', false);
        return this.operationIsCurrent(operation) ? count || 0 : 0;
    }

    // --- CLEANUP ---

    destroy(): void {
        this.clearOfflineQueueRetry();
        if (this.connectivityListenerAttached && typeof window !== 'undefined') {
            window.removeEventListener('online', this.handleOnline);
            this.connectivityListenerAttached = false;
        }
        this.activeSubscriptions.forEach((channel, channelId) => {
            if (supabase) supabase.removeChannel(channel);
            this.activeSubscriptions.delete(channelId);
        });
        if (this.dmSubscription) {
            if (supabase) supabase.removeChannel(this.dmSubscription);
            this.dmSubscription = null;
        }
        this.currentUserId = null;
        this.currentRole = 'member';
        this.mutedUntil = null;
        this.blocked = false;
        this.ownerUserId = null;
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
