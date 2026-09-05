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
