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
