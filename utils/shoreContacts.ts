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
export type ShoreBotCommand = { kind: 'confirm'; nonce: string } | { kind: 'where' } | { kind: 'stop' };
export function shoreBotCommand(text: string): ShoreBotCommand | null {
    if (text === '/where') return { kind: 'where' };
    if (text === '/stop') return { kind: 'stop' };
    const match = /^\/start ([a-f\d]{64})$/.exec(text);
    return match ? { kind: 'confirm', nonce: match[1] } : null;
}
