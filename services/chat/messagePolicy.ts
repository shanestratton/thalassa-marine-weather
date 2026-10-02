/** Shared client boundary for channel messages and direct messages. */
export const MAX_CHAT_MESSAGE_CHARS = 4_000;

/**
 * Return the canonical message sent to storage, or null when the payload
 * cannot satisfy the database contract.
 */
export function normalizeChatMessage(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().normalize('NFC');
    if (!normalized || normalized.length > MAX_CHAT_MESSAGE_CHARS || normalized.includes('\u0000')) return null;
    return normalized;
}

import type { ChatMessage } from './types';

export interface ModerationHint {
    text: string;
    tone: 'muted' | 'warn';
}

/** True while the author's own message waits for the moderation service. */
export function isAwaitingModeration(msg: Pick<ChatMessage, 'moderation_status'>): boolean {
    return msg.moderation_status === 'pending';
}

/** Channel publication is not a recipient delivery/read receipt. */
export function channelMessageIndicator(
    msg: Pick<ChatMessage, 'moderation_status' | 'delivery_status' | 'deleted_at'>,
): { symbol: string; label: string } {
    if (msg.moderation_status === 'held') return { symbol: '!', label: 'Message not delivered' };
    if (msg.moderation_status === 'rejected') return { symbol: '!', label: 'Message not posted' };
    if (msg.deleted_at) return { symbol: '×', label: 'Message removed' };
    if (msg.delivery_status === 'sending') return { symbol: '…', label: 'Message sending' };
    if (msg.delivery_status === 'queued') return { symbol: '◷', label: 'Message queued for reconnect' };
    if (isAwaitingModeration(msg)) return { symbol: '…', label: 'Message awaiting moderation' };
    if (msg.moderation_status === 'approved') return { symbol: '✓', label: 'Message published' };
    return { symbol: '✓', label: 'Message sent' };
}

/**
 * What to tell the AUTHOR under their own message. null for anyone else's
 * message and for an approved one — the ordinary case says nothing.
 *
 *   pending  → "Checking…"            the ~1–2 s server-side classification
 *   held     → not delivered          classifier unreachable five times; the
 *                                     message was never published, say so
 *   rejected → the reason             the body is already '[removed]'
 */
export function moderationHint(
    msg: Pick<ChatMessage, 'moderation_status' | 'moderation_reason' | 'deleted_at'>,
    isSelf: boolean,
): ModerationHint | null {
    if (!isSelf) return null;
    switch (msg.moderation_status) {
        case 'pending':
            return { text: 'Checking…', tone: 'muted' };
        case 'held':
            return { text: 'Not delivered — the message check is unavailable. Send it again later.', tone: 'warn' };
        case 'rejected':
            return {
                text: msg.moderation_reason
                    ? `Not posted — ${msg.moderation_reason}`
                    : 'Not posted — removed by moderation',
                tone: 'warn',
            };
        default:
            return null;
    }
}
