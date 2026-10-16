import { readResponseTextLimited } from '../_shared/http-security.ts';
import { shoreConfirmationData, shoreEmail, shoreNonce, shoreUuid } from '../../../utils/shoreContacts.ts';
export interface Environment {
    get(name: string): string | undefined;
}
export const APP_ORIGIN = 'https://thalassawx.vercel.app';
export async function nonceHash(value: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function randomNonce(): string {
    return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Separate server-only HMAC key; neither service-role key nor recipient token leaves this handler. */
export async function revokeNonce(env: Environment, id: string, revision: string): Promise<string> {
    const secret = env.get('SHORE_REVOKE_HMAC_KEY');
    if (!secret || !shoreNonce(secret) || !shoreUuid(id) || !shoreUuid(revision)) {
        throw new Error('Revocation configuration held');
    }
    const key = await crypto.subtle.importKey(
        'raw',
        Uint8Array.from(secret.match(/../g)!, (n) => parseInt(n, 16)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return [
        ...new Uint8Array(
            await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`shore-v1:${id}:${revision}`)),
        ),
    ].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function consentUrl(kind: 'confirm' | 'revoke', nonce: string): string {
    if (!shoreNonce(nonce)) throw new Error('Invalid nonce');
    return `${APP_ORIGIN}/#shore=${kind}.${nonce}`;
}
export async function boundedFetch(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit,
    limit = 16_384,
): Promise<{ status: number; body: unknown }> {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
    try {
        const response = await fetcher(url, { ...init, redirect: 'error', signal: abort.signal });
        const text = await readResponseTextLimited(response, limit);
        if (text === null) throw new Error('Bounded response required');
        let body: unknown = null;
        try {
            body = JSON.parse(text);
        } catch { /* Status alone never establishes a successful provider response. */ }
        return { status: response.status, body };
    } finally {
        clearTimeout(timer);
    }
}
export function shoreBackend(env: Environment, fetcher = fetch) {
    const root = new URL(env.get('SUPABASE_URL') ?? 'http://invalid'), key = env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (
        root.protocol !== 'https:' || root.username || root.password || root.pathname !== '/' || root.search ||
        root.hash || !key
    ) throw new Error('Backend held');
    return {
        async owner(authorization: string | null): Promise<string | null> {
            if (
                !authorization?.startsWith('Bearer ') || authorization === `Bearer ${key}` ||
                authorization.length > 8192
            ) return null;
            const r = await boundedFetch(fetcher, new URL('/auth/v1/user', root).href, {
                headers: { authorization, apikey: key },
            });
            return r.status === 200 && r.body && typeof r.body === 'object' && 'id' in r.body && shoreUuid(r.body.id)
                ? r.body.id
                : null;
        },
        async rpc(name: string, args: unknown): Promise<unknown> {
            if (
                ![
                    'shore_invite',
                    'shore_consent',
                    'shore_telegram_command',
                    'shore_anchor_enqueue',
                    'shore_delivery_claim',
                    'shore_delivery_guard',
                    'shore_delivery_finish',
                    'shore_worker_finish',
                    'overdue_watch_work',
                    'overdue_contact_claim',
                    'overdue_contact_guard',
                    'overdue_contact_finish',
                    'overdue_worker_finish',
                ].includes(name)
            ) throw new Error('Fixed procedure required');
            const r = await boundedFetch(fetcher, new URL(`/rest/v1/rpc/${name}`, root).href, {
                method: 'POST',
                headers: { authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
            }, 64_000);
            if (r.status < 200 || r.status >= 300) throw new Error('Contact changed or capability unavailable');
            return r.body;
        },
    };
}
export async function sendShoreEmail(
    env: Environment,
    fetcher: typeof fetch,
    to: string,
    text: string,
    id: string,
    revoke?: string,
): Promise<boolean> {
    const from = env.get('FOUNDING_SKIPPER_APPLICANT_FROM'), key = env.get('RESEND_API_KEY');
    const mailbox = from?.match(/^(?:[^<>\r\n]{1,80} <)?([^<>\s]+@[^<>\s]+)>?$/)?.[1];
    if (
        env.get('SHORE_MESSAGING_ENABLED') !== '1' || !key || !from || !shoreEmail(mailbox) || !shoreEmail(to) ||
        text.length > 3000 || !/^shore-[a-f\d-]{36}-(invite|alarm)$/.test(id)
    ) return false;
    const headers: Record<string, string> = {};
    if (revoke) headers['List-Unsubscribe'] = `<${consentUrl('revoke', revoke)}>`;
    const r = await boundedFetch(fetcher, 'https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
        body: JSON.stringify({
            from,
            to: [to],
            subject: 'Thalassa shore contact',
            text,
            ...(revoke ? { headers } : {}),
        }),
    });
    return r.status >= 200 && r.status < 300 && !!r.body && typeof r.body === 'object' && 'id' in r.body &&
        typeof r.body.id === 'string' && r.body.id.length > 0 && r.body.id.length <= 128;
}
export async function sendShoreTelegram(
    env: Environment,
    fetcher: typeof fetch,
    chat: string,
    text: string,
    confirmationNonce?: string,
): Promise<boolean> {
    const token = env.get('TELEGRAM_BOT_TOKEN'), bot = env.get('TELEGRAM_BOT_ID');
    if (
        env.get('SHORE_MESSAGING_ENABLED') !== '1' || !token || !/^\d{1,16}:[A-Za-z\d_-]{30,100}$/.test(token) ||
        token.split(':')[0] !== bot || !/^[1-9]\d{0,15}$/.test(chat) || text.length > 3000 ||
        (confirmationNonce !== undefined && !shoreNonce(confirmationNonce))
    ) return false;
    // Telegram requires its token in this fixed URL. No upstream URL/body/error is logged or returned.
    const r = await boundedFetch(fetcher, `https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chat,
            text,
            link_preview_options: { is_disabled: true },
            ...(confirmationNonce
                ? {
                    reply_markup: {
                        inline_keyboard: [[{
                            text: 'I agree to these permissions',
                            callback_data: shoreConfirmationData(confirmationNonce),
                        }]],
                    },
                }
                : {}),
        }),
    });
    return r.status === 200 && !!r.body && typeof r.body === 'object' && 'ok' in r.body && r.body.ok === true;
}
/** Fixed, content-free callback acknowledgement; never treats an API acceptance as consent. */
export async function answerShoreTelegram(
    env: Environment,
    fetcher: typeof fetch,
    callbackId: string,
): Promise<boolean> {
    const token = env.get('TELEGRAM_BOT_TOKEN'), bot = env.get('TELEGRAM_BOT_ID');
    if (
        env.get('SHORE_MESSAGING_ENABLED') !== '1' || !token || !/^\d{1,16}:[A-Za-z\d_-]{30,100}$/.test(token) ||
        token.split(':')[0] !== bot || !/^[A-Za-z\d_-]{1,128}$/.test(callbackId)
    ) return false;
    const r = await boundedFetch(fetcher, `https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            callback_query_id: callbackId,
            text: 'Request processed. Check the bot reply.',
            cache_time: 0,
        }),
    });
    return r.status === 200 && !!r.body && typeof r.body === 'object' && 'ok' in r.body && r.body.ok === true;
}
