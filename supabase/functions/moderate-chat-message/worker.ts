import { jsonResponse, readJsonObject, requireServiceRolePost } from '../_shared/http-security.ts';
import {
    type ChatModerationFailureCode,
    type ChatModerationFetch,
    type ChatModerationVerdict,
    classifyChatMessage,
} from './moderation.ts';

export const MAX_CHAT_MODERATION_ATTEMPTS = 5;
// A narrow, one-off rescue interface, not a general moderation override.
export const RECOVERY_GENERAL_CHANNEL_ID = '7bdf6903-0b8c-4c21-9c85-d7ca351251ce';
export const CHAT_MODERATION_HEALTH_MESSAGE = 'Good morning, crew. Calm seas and safe sailing today.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ChatModerationRow {
    id: string;
    message: string;
    moderation_status: string;
    moderation_attempts: number;
    moderation_reason: string | null;
    deleted_at: string | null;
    channel_id: string;
    user_id: string;
    created_at: string;
}

export interface ChatModerationPatch {
    moderation_status?: 'approved' | 'rejected' | 'held';
    moderation_reason?: string | null;
    moderation_attempts?: number;
    moderated_at?: string;
    deleted_at?: string;
}

export interface ChatModerationGateway {
    lookup(id: string): Promise<{ row: ChatModerationRow | null; error: unknown }>;
    // The concrete adapter MUST predicate every write on the id and pending
    // status. A concurrent review/hold must not be overwritten by this handler.
    updatePending(id: string, patch: ChatModerationPatch): Promise<{ error: unknown }>;
    // Both operations predicate the whole immutable message/owner snapshot,
    // held status, exact reason, undeleted state, and expected attempt counter.
    claimUnavailableHold(row: ChatModerationRow): Promise<{ matched: boolean; error: unknown }>;
    settleUnavailableHold(
        row: ChatModerationRow,
        patch: ChatModerationPatch,
    ): Promise<{ matched: boolean; error: unknown }>;
}

type WorkerEnvironmentName =
    | 'SUPABASE_URL'
    | 'SUPABASE_SERVICE_ROLE_KEY'
    | 'GEMINI_API_KEY'
    | 'CHAT_MODERATION_GEMINI_MODEL';

export interface ChatModerationDiagnostic {
    code: ChatModerationFailureCode | 'lookup_failed' | 'update_failed' | 'worker_failed' | 'escalated';
    messageId?: string;
    httpStatus?: number;
}

export interface ChatModerationWorkerDependencies {
    env(name: WorkerEnvironmentName): string | undefined;
    createGateway(url: string, serviceKey: string): ChatModerationGateway;
    fetcher?: ChatModerationFetch;
    now?: () => string;
    diagnostic?: (event: ChatModerationDiagnostic) => void;
}

function verdictPatch(verdict: ChatModerationVerdict, now: string): ChatModerationPatch {
    return verdict.verdict === 'clean' || verdict.verdict === 'warning'
        ? {
            moderation_status: 'approved',
            moderated_at: now,
            moderation_reason: verdict.verdict === 'warning' ? `Flagged: ${verdict.reason}` : null,
        }
        : {
            moderation_status: 'rejected',
            moderated_at: now,
            moderation_reason: verdict.verdict === 'escalate' ? `Escalated: ${verdict.reason}` : verdict.reason,
            deleted_at: now,
        };
}

function recoverableHold(row: ChatModerationRow): boolean {
    return row.channel_id === RECOVERY_GENERAL_CHANNEL_ID && UUID.test(row.user_id) &&
        row.moderation_status === 'held' && row.moderation_attempts === MAX_CHAT_MODERATION_ATTEMPTS &&
        row.moderation_reason === 'Moderation unavailable' && row.deleted_at === null &&
        typeof row.message === 'string' && row.message.trim().length > 0 && row.message.length <= 4_000 &&
        typeof row.created_at === 'string' && row.created_at.length <= 128 &&
        Number.isFinite(Date.parse(row.created_at));
}

/** Same production handler exercised by mocked HTTP/database tests. */
export function createChatModerationHandler(
    dependencies: ChatModerationWorkerDependencies,
): (req: Request) => Promise<Response> {
    const diagnose = (event: ChatModerationDiagnostic) => {
        try {
            dependencies.diagnostic?.(event);
        } catch { /* Diagnostics cannot publish or interrupt a decision. */ }
    };
    return async (req: Request): Promise<Response> => {
        const serviceKey = dependencies.env('SUPABASE_SERVICE_ROLE_KEY');
        const denied = requireServiceRolePost(req, serviceKey);
        if (denied) return denied;
        let body: Record<string, unknown> | null;
        try {
            body = await readJsonObject(req);
        } catch {
            return jsonResponse({ error: 'Invalid request body' }, 400);
        }
        if (
            (body?.healthcheck !== undefined && typeof body.healthcheck !== 'boolean') ||
            (body?.retry_unavailable_hold !== undefined && typeof body.retry_unavailable_hold !== 'boolean')
        ) {
            return jsonResponse({ error: 'Invalid service mode' }, 400);
        }
        if (body?.healthcheck === true) {
            if (Object.keys(body).some((key) => key !== 'healthcheck')) {
                return jsonResponse({ error: 'Healthcheck cannot target a message' }, 400);
            }
            const classification = await classifyChatMessage(
                CHAT_MODERATION_HEALTH_MESSAGE,
                dependencies.env('GEMINI_API_KEY'),
                dependencies.env('CHAT_MODERATION_GEMINI_MODEL'),
                dependencies.fetcher,
            );
            if (classification.status !== 'ok') {
                diagnose({
                    code: classification.code,
                    ...(classification.httpStatus === undefined ? {} : { httpStatus: classification.httpStatus }),
                });
                return jsonResponse({ ok: false, unavailable: true, code: classification.code }, 503);
            }
            return jsonResponse({ ok: true, verdict: classification.value.verdict }, 200);
        }
        const supabaseUrl = dependencies.env('SUPABASE_URL');
        if (!supabaseUrl || !serviceKey) return jsonResponse({ error: 'Server database is not configured' }, 500);
        const id = body?.record && typeof body.record === 'object' && !Array.isArray(body.record)
            ? (body.record as Record<string, unknown>).id
            : body?.id;
        if (typeof id !== 'string' || !UUID.test(id)) {
            return jsonResponse({ error: 'record.id (uuid) required' }, 400);
        }

        try {
            const gateway = dependencies.createGateway(supabaseUrl, serviceKey);
            const { row, error } = await gateway.lookup(id);
            if (error) {
                diagnose({ code: 'lookup_failed', messageId: id });
                return jsonResponse({ error: 'Lookup failed' }, 500);
            }
            if (!row) return jsonResponse({ skipped: true }, 200);
            const recovery = body?.retry_unavailable_hold === true;
            if (!recovery && row.moderation_status !== 'pending') return jsonResponse({ skipped: true }, 200);
            if (
                row.id !== id || !Number.isSafeInteger(row.moderation_attempts) || row.moderation_attempts < 0 ||
                row.moderation_attempts >= 32_767
            ) {
                return jsonResponse({ error: 'Invalid pending row' }, 500);
            }

            if (recovery) {
                if (!recoverableHold(row)) return jsonResponse({ skipped: true }, 200);
                const claim = await gateway.claimUnavailableHold(row);
                if (claim.error) {
                    diagnose({ code: 'update_failed', messageId: id });
                    return jsonResponse({ error: 'Recovery claim failed' }, 500);
                }
                if (!claim.matched) return jsonResponse({ skipped: true }, 200);
            }

            const classification = await classifyChatMessage(
                row.message,
                dependencies.env('GEMINI_API_KEY'),
                dependencies.env('CHAT_MODERATION_GEMINI_MODEL'),
                dependencies.fetcher,
            );
            const now = dependencies.now?.() ?? new Date().toISOString();
            if (classification.status !== 'ok') {
                diagnose({
                    code: classification.code,
                    messageId: id,
                    ...(classification.httpStatus === undefined ? {} : { httpStatus: classification.httpStatus }),
                });
                // The one-off claim already left the row held at attempt six.
                // Never requeue it as old pending: the cron would hold it again.
                if (recovery) return jsonResponse({ held: true, unavailable: true, code: classification.code }, 200);
                const attempts = row.moderation_attempts + 1;
                const held = attempts >= MAX_CHAT_MODERATION_ATTEMPTS;
                const { error: updateError } = await gateway.updatePending(
                    id,
                    held
                        ? {
                            moderation_status: 'held',
                            moderation_attempts: attempts,
                            moderation_reason: 'Moderation unavailable',
                            moderated_at: now,
                        }
                        : { moderation_attempts: attempts },
                );
                if (updateError) {
                    diagnose({ code: 'update_failed', messageId: id });
                    return jsonResponse({ error: 'Attempt update failed' }, 500);
                }
                return jsonResponse({ pending: !held, held }, 200);
            }

            const verdict = classification.value;
            const patch = verdictPatch(verdict, now);
            const settlement = recovery
                ? await gateway.settleUnavailableHold(row, patch)
                : await gateway.updatePending(id, patch);
            const updateError = settlement.error;
            if (updateError) diagnose({ code: 'update_failed', messageId: id });
            if (recovery && !updateError && 'matched' in settlement && !settlement.matched) {
                return jsonResponse({ skipped: true }, 200);
            }
            // Keep even escalation diagnostics free of message/reason text.
            if (verdict.verdict === 'escalate') diagnose({ code: 'escalated', messageId: id });
            return jsonResponse({ ok: !updateError, verdict: verdict.verdict }, updateError ? 500 : 200);
        } catch {
            diagnose({ code: 'worker_failed', messageId: id });
            return jsonResponse({ error: 'Moderation unavailable' }, 500);
        }
    };
}
