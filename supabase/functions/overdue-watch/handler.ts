import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';
import { shoreEmail, shoreRecord, shoreUuid } from '../../../utils/shoreContacts.ts';
import { overduePlanWords, overduePositionWords } from '../../../utils/overdueWatch.ts';
import { REVIEWED_RESCUE_ADVICE, reviewedRescueWords } from '../../../services/marineRescueDirectory.ts';
import {
    consentUrl,
    type Environment,
    nonceHash,
    revokeNonce,
    sendShoreEmail,
    sendShoreTelegram,
    shoreBackend,
} from '../anchor-alert-messaging/transport.ts';
export interface OverdueDependencies {
    rpc(name: string, args: unknown): Promise<unknown>;
    email(to: string, text: string, id: string, revoke: string): Promise<boolean>;
    telegram(chat: string, text: string): Promise<boolean>;
    now(): number;
    monotonic(): number;
}
/** No caller recipient, route, position, text, URL or rescue destination is accepted. */
export function createOverdueWorker(env: Environment, overrides?: OverdueDependencies, fetcher = fetch) {
    return async (req: Request): Promise<Response> => {
        if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405, { Allow: 'POST' });
        const service = env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!service || req.headers.get('authorization') !== `Bearer ${service}`) {
            return jsonResponse({ error: 'Service required' }, 401);
        }
        if (env.get('OVERDUE_WATCH_ENABLED') !== '1' || env.get('SHORE_MESSAGING_ENABLED') !== '1') {
            return jsonResponse({ error: 'Overdue watch held' }, 503);
        }
        let deps: OverdueDependencies | undefined;
        try {
            const body = await readJsonObject(req, 4096);
            if (new URL(req.url).search || !body || Object.keys(body).length !== 1 || body.action !== 'work') {
                return jsonResponse({ error: 'Fixed bounded work action required' }, 400);
            }
            deps = overrides ??
                {
                    ...shoreBackend(env, fetcher),
                    email: (...a) => sendShoreEmail(env, fetcher, ...a),
                    telegram: (...a) => sendShoreTelegram(env, fetcher, ...a),
                    now: Date.now,
                    monotonic: () => performance.now(),
                };
            const started = deps.monotonic(),
                budget = () => {
                    if (deps!.monotonic() - started > 12000) throw new Error('Work deadline');
                };
            let after: string | null = null, scanned = false, drained = false, healthy = true, accepted = 0;
            for (let page = 0; page < 4; page++) {
                budget();
                const r = await deps.rpc('overdue_watch_work', { p_after: after });
                if (!shoreRecord(r) || Object.keys(r).length !== 1 || (r.after !== null && !shoreUuid(r.after))) {
                    throw new Error('Invalid work');
                }
                if (r.after === null) {
                    scanned = true;
                    break;
                }
                after = r.after;
            }
            for (let i = 0; i < 10; i++) {
                budget();
                const r = await deps.rpc('overdue_contact_claim', {});
                if (r === null) {
                    drained = true;
                    break;
                }
                if (shoreRecord(r) && Object.keys(r).length === 1 && r.more === true) break;
                if (
                    !shoreRecord(r) || !shoreUuid(r.id) || !shoreUuid(r.revision) || !shoreUuid(r.contactRevision) ||
                    !shoreUuid(r.contactId) || !shoreUuid(r.revokeKey) ||
                    !shoreRecord(r.plan) || typeof r.ownerAttemptedAt !== 'number' ||
                    !Number.isSafeInteger(r.ownerAttemptedAt) || r.ownerAttemptedAt <= 0 ||
                    r.ownerAttemptedAt > deps.now() - 600000 ||
                    typeof r.preparedAt !== 'number' || !Number.isSafeInteger(r.preparedAt) || r.preparedAt <= 0 ||
                    r.preparedAt > deps.now() || r.preparedAt < deps.now() - 600000 ||
                    (r.rescueRegion !== null &&
                        (typeof r.rescueRegion !== 'string' || !Object.hasOwn(REVIEWED_RESCUE_ADVICE, r.rescueRegion)))
                ) throw new Error('Invalid delivery');
                const plan = overduePlanWords(r.plan);
                if (
                    !plan || typeof r.plan.overdueAt !== 'number' || r.plan.overdueAt > deps.now() ||
                    r.plan.overdueAt < deps.now() - 86400000 || r.ownerAttemptedAt < r.plan.overdueAt
                ) throw new Error('Invalid plan');
                const revoke = await revokeNonce(env, r.contactId, r.revokeKey);
                if (r.channel === 'email' && r.revokeHash !== await nonceHash(revoke)) {
                    throw new Error('Consent key changed');
                }
                const text = `Thalassa float-plan overdue notice. ${plan}\nAn owner push attempt began ${
                    new Date(r.ownerAttemptedAt).toISOString()
                }; receipt or delivery is unconfirmed. A ten-minute grace has passed.\n${`Notice prepared ${
                    new Date(r.preparedAt).toISOString()
                }; report age below is at that preparation time. ${overduePositionWords(r.position, r.preparedAt)}`}\n${
                    reviewedRescueWords(r.rescueRegion as string | null)
                }\nContact the skipper and check the plan. No distress is inferred automatically. ${
                    r.channel === 'email' ? `Stop messages: ${consentUrl('revoke', revoke)}` : 'Use /stop to revoke.'
                }`;
                if (
                    await deps.rpc('overdue_contact_guard', {
                        p_id: r.id,
                        p_revision: r.revision,
                        p_contact_revision: r.contactRevision,
                    }) !== true
                ) continue;
                budget();
                const ok = r.channel === 'email' && shoreEmail(r.address)
                    ? await deps.email(r.address, text, `shore-${r.id}-alarm`, revoke)
                    : r.channel === 'telegram' && typeof r.chatId === 'string' && r.botId === env.get('TELEGRAM_BOT_ID')
                    ? await deps.telegram(r.chatId, text)
                    : false;
                await deps.rpc('overdue_contact_finish', { p_id: r.id, p_revision: r.revision, p_success: ok });
                if (ok) accepted++;
                else healthy = false;
            }
            const complete = scanned && drained && healthy;
            await deps.rpc('overdue_worker_finish', { p_success: complete });
            return jsonResponse({ schema: 1, providerAccepted: accepted, complete }, complete ? 200 : 503);
        } catch {
            if (deps) await deps.rpc('overdue_worker_finish', { p_success: false }).catch(() => undefined);
            return jsonResponse({ error: 'Overdue watch changed or unavailable' }, 503);
        }
    };
}
