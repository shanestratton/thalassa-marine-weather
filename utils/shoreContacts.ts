/** Fixed personal-contact consent contract. No arbitrary messages or rescue recipients. */
export const SHORE_CONTACT_LIMIT = 10;
export const SHORE_CONSENT_TTL_MS = 24 * 60 * 60_000;
export interface ShoreContactConfiguration {
    channel: 'email' | 'telegram';
    label: string;
    address: string | null;
    sharePosition: boolean;
    enabled: boolean;
}
export interface ShoreContactSummary {
    id: string;
    revision: string;
    configuration: ShoreContactConfiguration;
    consent: 'pending' | 'confirmed' | 'revoked';
    consentedAt: number | null;
}
export const shoreUuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
export const shoreNonce = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/.test(v);
export const shoreRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
const safeText = (v: unknown, max: number): v is string =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    v.trim() === v &&
    ![...v].some(
        (c) => (c.codePointAt(0) ?? 0) < 32 || ((c.codePointAt(0) ?? 0) >= 127 && (c.codePointAt(0) ?? 0) <= 159),
    );
export function shoreEmail(v: unknown): v is string {
    return (
        safeText(v, 254) &&
        /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
            v,
        )
    );
}
export function parseShoreConfiguration(v: unknown): ShoreContactConfiguration | null {
    if (
        !shoreRecord(v) ||
        Object.keys(v).length !== 5 ||
        !['channel', 'label', 'address', 'sharePosition', 'enabled'].every((k) => Object.hasOwn(v, k)) ||
        !['email', 'telegram'].includes(String(v.channel)) ||
        !safeText(v.label, 60) ||
        typeof v.sharePosition !== 'boolean' ||
        typeof v.enabled !== 'boolean' ||
        (v.channel === 'email' ? !shoreEmail(v.address) || v.sharePosition !== false : v.address !== null)
    )
        return null;
    return v as unknown as ShoreContactConfiguration;
}
/** Telegram usernames/groups never establish recipient authority. */
export function privateTelegramSender(
    value: unknown,
): { chatId: string; userId: string; updateId: number; text: string; at: number } | null {
    if (
        !shoreRecord(value) ||
        !Number.isSafeInteger(value.update_id) ||
        typeof value.update_id !== 'number' ||
        value.update_id < 0 ||
        Object.hasOwn(value, 'callback_query') ||
        !shoreRecord(value.message)
    )
        return null;
    const message = value.message,
        chat = shoreRecord(message.chat) ? message.chat : null,
        from = shoreRecord(message.from) ? message.from : null;
    if (
        chat?.type !== 'private' ||
        !from ||
        from.is_bot !== false ||
        typeof chat.id !== 'number' ||
        !Number.isSafeInteger(chat.id) ||
        chat.id <= 0 ||
        typeof from.id !== 'number' ||
        !Number.isSafeInteger(from.id) ||
        from.id <= 0 ||
        chat.id !== from.id ||
        typeof message.text !== 'string' ||
        message.text.length > 100 ||
        !Number.isSafeInteger(message.date) ||
        typeof message.date !== 'number' ||
        message.date <= 0
    )
        return null;
    return {
        chatId: String(chat.id),
        userId: String(from.id),
        updateId: value.update_id,
        text: message.text,
        at: message.date * 1000,
    };
}
/** 32 nonce bytes encode to 43 characters; the fixed callback stays below Telegram's 64-byte cap. */
export function shoreConfirmationData(nonce: string): string {
    if (!shoreNonce(nonce)) throw new Error('Invalid consent nonce');
    return (
        'shore-confirm:' +
        btoa(String.fromCharCode(...Uint8Array.from(nonce.match(/../g)!, (b) => parseInt(b, 16))))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')
    );
}
/** A callback is authority only in the same private recipient chat, on our own bot's message. */
export function privateTelegramConfirmation(
    value: unknown,
    botId: string | undefined,
): {
    chatId: string;
    userId: string;
    updateId: number;
    nonce: string;
    at: number;
    callbackId: string;
} | null {
    if (
        !shoreRecord(value) ||
        typeof value.update_id !== 'number' ||
        !Number.isSafeInteger(value.update_id) ||
        value.update_id < 0 ||
        !shoreRecord(value.callback_query) ||
        Object.hasOwn(value, 'message')
    )
        return null;
    const callback = value.callback_query,
        from = shoreRecord(callback.from) ? callback.from : null,
        message = shoreRecord(callback.message) ? callback.message : null,
        chat = message && shoreRecord(message.chat) ? message.chat : null,
        author = message && shoreRecord(message.from) ? message.from : null;
    if (
        !from ||
        from.is_bot !== false ||
        typeof from.id !== 'number' ||
        !Number.isSafeInteger(from.id) ||
        from.id <= 0 ||
        chat?.type !== 'private' ||
        chat.id !== from.id ||
        author?.is_bot !== true ||
        typeof author.id !== 'number' ||
        !Number.isSafeInteger(author.id) ||
        String(author.id) !== botId ||
        !message ||
        typeof message.date !== 'number' ||
        !Number.isSafeInteger(message.date) ||
        message.date <= 0 ||
        typeof callback.id !== 'string' ||
        !/^[A-Za-z\d_-]{1,128}$/.test(callback.id) ||
        typeof callback.data !== 'string' ||
        !/^shore-confirm:[A-Za-z\d_-]{43}$/.test(callback.data) ||
        Object.hasOwn(callback, 'inline_message_id')
    )
        return null;
    const encoded = callback.data.slice('shore-confirm:'.length);
    const nonce = [...atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '=')]
        .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
    if (!shoreNonce(nonce) || shoreConfirmationData(nonce) !== callback.data) return null;
    return {
        chatId: String(chat.id),
        userId: String(from.id),
        updateId: value.update_id,
        nonce,
        at: message.date * 1000,
        callbackId: callback.id,
    };
}
export type ShoreBotCommand = { kind: 'preview'; nonce: string } | { kind: 'where' } | { kind: 'stop' };
export function shoreBotCommand(text: string): ShoreBotCommand | null {
    if (text === '/where') return { kind: 'where' };
    if (text === '/stop') return { kind: 'stop' };
    const match = /^\/start ([a-f\d]{64})$/.exec(text);
    return match ? { kind: 'preview', nonce: match[1] } : null;
}
