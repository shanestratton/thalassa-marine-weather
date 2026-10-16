import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import { shoreEmail, shoreNonce, shoreRecord, shoreUuid } from '../../../utils/shoreContacts.ts';
import {
    consentUrl,
    type Environment,
    nonceHash,
    randomNonce,
    revokeNonce,
    sendShoreEmail,
    sendShoreTelegram,
    shoreBackend,
} from './transport.ts';
export interface ShoreDependencies {
    owner(auth: string | null): Promise<string | null>;
    rpc(name: string, args: unknown): Promise<unknown>;
    nonce(): string;
    email(to: string, text: string, id: string, revoke?: string): Promise<boolean>;
    telegram(chat: string, text: string): Promise<boolean>;
}
const WORDS: Record<string, string> = {
    drag: 'The anchor watch reports dragging. Contact the skipper and check the boat immediately.',
    contact_lost:
        'The anchor-watch keeper has stopped reporting. The boat position and anchor state cannot be confirmed. Contact the skipper.',
    gps_lost: 'The boat has no fresh GPS fix. Anchor dragging cannot be checked. Contact the skipper.',
    session_expiring: 'The anchor watch is ending soon. Contact the skipper to review its authorisation.',
};
const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export function createShoreHandler(env: Environment, overrides?: ShoreDependencies, fetcher = fetch) {
    return async (req: Request): Promise<Response> => {
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'authorization,apikey,content-type',
            'Access-Control-Allow-Methods': 'POST,OPTIONS',
            'Referrer-Policy': 'no-referrer',
        };
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (req.method !== 'POST') {
            return jsonResponse({ error: 'Explicit POST required' }, 405, { ...cors, Allow: 'POST' });
        }
        if (new URL(req.url).search) return jsonResponse({ error: 'No query parameters' }, 400, cors);
        try {
            const backend = overrides ?? shoreBackend(env, fetcher),
                deps: ShoreDependencies = overrides ??
                    {
                        ...backend,
                        nonce: randomNonce,
                        email: (...args) => sendShoreEmail(env, fetcher, ...args),
                        telegram: (...args) => sendShoreTelegram(env, fetcher, ...args),
                    };
            const body = await readJsonObject(req, 4096);
            if (!body) return jsonResponse({ error: 'Bounded object required' }, 400, cors);
            if (body.action !== 'revoke' && env.get('SHORE_MESSAGING_ENABLED') !== '1') {
                return jsonResponse({ error: 'Shore messaging held' }, 503, cors);
            }
            if (body.action === 'confirm' || body.action === 'revoke') {
                if (
                    !(exact(body, ['action', 'nonce', 'accepted']) ||
                        exact(body, ['action', 'nonce', 'accepted', 'policyVersion'])) ||
                    (body.policyVersion !== undefined && body.policyVersion !== 2) || body.accepted !== true ||
                    !shoreNonce(body.nonce)
                ) return jsonResponse({ error: 'Explicit recipient consent required' }, 400, cors);
                const ok = await deps.rpc('shore_consent', {
                    p_hash: await nonceHash(body.nonce),
                    p_action: body.action,
                    p_policy_version: body.policyVersion === 2 ? 2 : 1,
                });
                return jsonResponse({ accepted: ok === true }, ok === true ? 200 : 409, cors);
            }
            if (body.action === 'invite') {
                const owner = await deps.owner(req.headers.get('authorization'));
                if (!owner) return jsonResponse({ error: 'Current owner required' }, 401, cors);
                if (
                    !exact(body, ['action', 'contactId', 'revision']) || !shoreUuid(body.contactId) ||
                    !shoreUuid(body.revision)
                ) return jsonResponse({ error: 'Exact contact revision required' }, 400, cors);
                const nonce = deps.nonce(), revoke = await revokeNonce(env, body.contactId, body.revision);
                const row = await deps.rpc('shore_invite', {
                    p_owner: owner,
                    p_contact: body.contactId,
                    p_revision: body.revision,
                    p_confirm_hash: await nonceHash(nonce),
                    p_revoke_hash: await nonceHash(revoke),
                    p_policy_version: 2,
                });
                if (
                    !shoreRecord(row) || !['email', 'telegram'].includes(String(row.channel)) ||
                    typeof row.sharePosition !== 'boolean' || typeof row.allowOverdue !== 'boolean' ||
                    !shoreUuid(row.invitationId)
                ) throw new Error('Invalid invitation');
                if (row.channel === 'telegram') {
                    const bot = env.get('TELEGRAM_BOT_USERNAME');
                    if (!bot || !/^\w{5,32}bot$/i.test(bot) || row.botId !== env.get('TELEGRAM_BOT_ID')) {
                        throw new Error('Bot configuration held');
                    }
                    return jsonResponse(
                        { invitationUrl: `https://t.me/${bot}?start=${nonce}`, expiresInHours: 24 },
                        200,
                        cors,
                    );
                }
                if (!shoreEmail(row.address)) throw new Error('Recipient unavailable');
                const text = `A Thalassa vessel owner invited you to receive personal anchor-watch notices${
                    row.allowOverdue
                        ? ' and float-plan overdue notices (only after an owner notification attempt and ten-minute grace)'
                        : '; overdue notices are not authorized'
                }. These messages are not monitored rescue coverage. ${
                    row.sharePosition
                        ? 'The owner also requests permission to share this vessel’s fresh registered position with you.'
                        : 'Position sharing is off.'
                }\nReview and explicitly confirm: ${consentUrl('confirm', nonce)}\nStop/revoke: ${
                    consentUrl('revoke', revoke)
                }\nThe confirmation expires in 24 hours. Ignore this email to decline.`;
                // No raw token, address or provider response is returned to the owner.
                const accepted = await deps.email(row.address, text, `shore-${row.invitationId}-invite`, revoke);
                return jsonResponse({ invitationAccepted: accepted }, accepted ? 200 : 503, cors);
            }
            if (body.action === 'work') {
                const key = env.get('SUPABASE_SERVICE_ROLE_KEY');
                if (!key || req.headers.get('authorization') !== `Bearer ${key}`) {
                    return jsonResponse({ error: 'Service required' }, 401, cors);
                }
                if (!exact(body, ['action'])) return jsonResponse({ error: 'Fixed work action required' }, 400, cors);
                const started = performance.now();
                const budget = () => {
                    if (performance.now() - started > 12_000) throw new Error('Work deadline');
                };
                let after: unknown = null, scanned = false, drained = false, healthy = true;
                for (let page = 0; page < 4; page++) {
                    budget();
                    const r = await deps.rpc('shore_anchor_enqueue', { p_after: after });
                    if (!shoreRecord(r) || (r.after !== null && !shoreUuid(r.after))) throw new Error('Invalid queue');
                    if (r.after === null) {
                        scanned = true;
                        break;
                    }
                    after = r.after;
                }
                let sent = 0;
                for (let n = 0; n < 10; n++) {
                    budget();
                    const r = await deps.rpc('shore_delivery_claim', {});
                    if (r === null) {
                        drained = true;
                        break;
                    }
                    if (
                        !shoreRecord(r) || !shoreUuid(r.id) || !shoreUuid(r.revision) || !shoreUuid(r.contactId) ||
                        !shoreUuid(r.revokeKey) || !WORDS[String(r.kind)] || typeof r.at !== 'number' ||
                        !Number.isSafeInteger(r.at) || r.at > Date.now() || r.at < Date.now() - 600_000
                    ) throw new Error('Invalid delivery');
                    const revoke = await revokeNonce(env, r.contactId, r.revokeKey);
                    if (r.channel === 'email' && r.revokeHash !== await nonceHash(revoke)) {
                        throw new Error('Revocation key changed; fresh consent required');
                    }
                    const text = `Thalassa shore watch: ${WORDS[String(r.kind)]}\nRaised ${
                        new Date(r.at).toISOString()
                    }. Delivery can be delayed or unavailable. This service does not contact rescue services.\n${
                        r.channel === 'email'
                            ? `Stop messages: ${consentUrl('revoke', revoke)}`
                            : 'Use /stop to revoke messages.'
                    }`;
                    // Last database check immediately precedes the fixed provider call. A provider
                    // can accept just before revocation commits; no distributed atomic send claim.
                    if (await deps.rpc('shore_delivery_guard', { p_id: r.id, p_revision: r.revision }) !== true) {
                        continue;
                    }
                    budget();
                    const ok = r.channel === 'email' && shoreEmail(r.address)
                        ? await deps.email(r.address, text, `shore-${r.id}-alarm`, revoke)
                        : r.channel === 'telegram' && typeof r.chatId === 'string' &&
                                r.botId === env.get('TELEGRAM_BOT_ID')
                        ? await deps.telegram(r.chatId, text)
                        : false;
                    await deps.rpc('shore_delivery_finish', { p_id: r.id, p_revision: r.revision, p_success: ok });
                    if (ok) sent++;
                    else healthy = false;
                }
                const complete = scanned && drained && healthy;
                await deps.rpc('shore_worker_finish', { p_success: complete });
                return jsonResponse({ schema: 1, providerAccepted: sent, complete }, complete ? 200 : 503, cors);
            }
            return jsonResponse({ error: 'Fixed action required' }, 400, cors);
        } catch {
            return jsonResponse({ error: 'Contact changed, capability held or delivery unavailable' }, 503, cors);
        }
    };
}
