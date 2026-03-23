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

export interface QueuedMessage {
    type: 'channel' | 'dm';
    channel_id?: string;
    recipient_id?: string;
    message: string;
    is_question?: boolean;
    timestamp: string;
}
