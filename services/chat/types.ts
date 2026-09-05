/**
 * Chat Service — Type definitions.
 */

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
    /**
     * Server-side moderation (2026-09-05). A new row is 'pending' and visible
     * only to its author until the moderation service approves it; 'rejected'
     * rows are soft-deleted with a reason the author can read; 'held' means the
     * classifier could not be reached and the message was never published.
     * Absent on rows loaded from clients older than the column.
     */
    moderation_status?: 'pending' | 'approved' | 'rejected' | 'held';
    moderation_reason?: string | null;
    /** Local-only state for an optimistic message; never persisted remotely. */
    delivery_status?: 'sending' | 'queued';
}

export interface DirectMessage {
    id: string;
    sender_id: string;
    recipient_id: string;
    sender_name: string;
    message: string;
    read: boolean;
    created_at: string;
    /** Local-only state for an optimistic message; never persisted remotely. */
    delivery_status?: 'sending' | 'queued';
}

export type ChatMessageSendResult = ChatMessage | 'queued' | null;
export type DirectMessageSendResult = DirectMessage | 'queued' | 'blocked' | null;

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

export interface QueuedMessage {
    type: 'channel' | 'dm';
    channel_id?: string;
    recipient_id?: string;
    message: string;
    is_question?: boolean;
    timestamp: string;
}
