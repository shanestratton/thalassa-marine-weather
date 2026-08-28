import {
    deliverFeedbackEmail,
    FEEDBACK_MESSAGE_KINDS,
    type FeedbackEmailConfig,
    type FeedbackEmailDiagnostics,
    type FeedbackEmailJob,
} from './email.ts';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REFERENCE = /^FB-[0-9A-F]{8}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SOURCE = /^[a-z0-9][a-z0-9_-]{0,39}$/u;
const CURRENT_PATH = /^\/[^?#]{0,119}$/u;
const WORKER_KEY_HEADER = 'x-thalassa-worker-key';
const WORKER_KEY_MAX_LENGTH = 1_024;
const FEEDBACK_AREAS = new Set([
    'weather',
    'charts_obs',
    'passage_planning',
    'anchor_watch',
    'voyage_log',
    'crew_list',
    'vessel_nmea',
    'account',
    'website',
    'other',
]);
const BUG_IMPACTS = new Set(['blocking', 'serious', 'annoying', 'cosmetic']);
const FEATURE_IMPACTS = new Set(['game_changer', 'important', 'nice_to_have']);
const FEEDBACK_STATUSES = new Set(['new', 'reviewing', 'planned', 'in_progress', 'resolved', 'declined', 'duplicate']);
const DIAGNOSTIC_KEYS = new Set([
    'platform',
    'userAgent',
    'screen',
    'viewport',
    'language',
    'online',
    'currentPath',
]);

export const FEEDBACK_EMAIL_WORKER_BATCH_LIMIT = 10;
export const FEEDBACK_EMAIL_WORKER_LEASE_SECONDS = 90;

export interface FeedbackEmailQueueGateway {
    claim(leaseToken: string, limit: number, leaseSeconds: number): Promise<unknown[]>;
    finish(jobId: string, leaseToken: string, providerMessageId: string): Promise<void>;
    retry(
        jobId: string,
        leaseToken: string,
        errorCode: string,
        retryAfterSeconds: number,
        terminal: boolean,
    ): Promise<void>;
}

export interface FeedbackEmailWorkerResult {
    claimed: number;
    sent: number;
    retried: number;
    dead: number;
    checkpointFailures: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function requireAppliedFeedbackEmailCheckpoint(data: unknown, error: unknown, code: string): void {
    if (error || data !== true) throw new Error(code);
}

export function requireFeedbackEmailWorkerRequest(
    request: Request,
    serviceRoleKey: string | undefined,
): Response | null {
    if (request.method !== 'POST' || !serviceRoleKey) return requireServiceRolePost(request, serviceRoleKey);

    const authorization = request.headers.get('authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    if (
        matchesBoundedWorkerSecret(bearer, serviceRoleKey) ||
        matchesBoundedWorkerSecret(request.headers.get(WORKER_KEY_HEADER), serviceRoleKey)
    ) return null;

    // Cron may still use the project's legacy service-role JWT while the Edge
    // runtime exposes a modern service secret. Gateway JWT verification is
    // mandatory for this narrow compatibility path.
    if (hasGatewayVerifiedServiceRoleJwt(authorization)) return null;

    return jsonResponse({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
}

function matchesBoundedWorkerSecret(candidate: string | null, configured: string): boolean {
    if (
        !candidate ||
        candidate.length > WORKER_KEY_MAX_LENGTH ||
        configured.length < 1 ||
        configured.length > WORKER_KEY_MAX_LENGTH
    ) return false;

    const candidateBytes = new TextEncoder().encode(candidate);
    const configuredBytes = new TextEncoder().encode(configured);
    const comparedLength = Math.max(candidateBytes.length, configuredBytes.length);
    let difference = candidateBytes.length ^ configuredBytes.length;
    for (let index = 0; index < comparedLength; index += 1) {
        difference |= (candidateBytes[index] ?? 0) ^ (configuredBytes[index] ?? 0);
    }
    return difference === 0;
}

function hasGatewayVerifiedServiceRoleJwt(authorization: string | null): boolean {
    if (!authorization?.startsWith('Bearer ')) return false;
    const token = authorization.slice('Bearer '.length);
    if (token.length < 5 || token.length > 8_192) return false;
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some((segment) => !segment)) return false;
    const payloadSegment = segments[1];
    if (!/^[A-Za-z0-9_-]+$/u.test(payloadSegment)) return false;

    try {
        const base64 = payloadSegment.replaceAll('-', '+').replaceAll('_', '/');
        const padding = (4 - (base64.length % 4)) % 4;
        const payload = JSON.parse(atob(base64 + '='.repeat(padding)));
        return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload) &&
            payload.role === 'service_role';
    } catch {
        return false;
    }
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hasInlineControl(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= 31 || code === 127) return true;
    }
    return false;
}

function hasMultilineControl(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
    }
    return false;
}

function inline(value: unknown, min: number, max: number): string | null {
    return typeof value === 'string' &&
            value.length >= min &&
            value.length <= max &&
            !hasInlineControl(value)
        ? value
        : null;
}

function optionalInline(value: unknown, max: number): string | null | undefined {
    if (value === null) return null;
    return inline(value, 1, max) ?? undefined;
}

function multiline(value: unknown, min: number, max: number): string | null {
    return typeof value === 'string' &&
            value.length >= min &&
            value.length <= max &&
            !hasMultilineControl(value)
        ? value
        : null;
}

function optionalMultiline(value: unknown, max: number): string | null | undefined {
    if (value === null) return null;
    return multiline(value, 1, max) ?? undefined;
}

function diagnosticString(value: unknown, max: number): string | null {
    return typeof value === 'string' && value.length <= max && !hasInlineControl(value) ? value : null;
}

function parseDiagnostics(value: unknown): FeedbackEmailDiagnostics | null | undefined {
    if (value === null) return null;
    const input = record(value);
    if (!input || Object.keys(input).length !== 7 || Object.keys(input).some((key) => !DIAGNOSTIC_KEYS.has(key))) {
        return undefined;
    }
    const platform = diagnosticString(input.platform, 120);
    const userAgent = diagnosticString(input.userAgent, 512);
    const screen = diagnosticString(input.screen, 40);
    const viewport = diagnosticString(input.viewport, 40);
    const language = diagnosticString(input.language, 32);
    const currentPath = diagnosticString(input.currentPath, 120);
    if (
        platform === null ||
        userAgent === null ||
        screen === null ||
        viewport === null ||
        language === null ||
        currentPath === null ||
        !CURRENT_PATH.test(currentPath) ||
        typeof input.online !== 'boolean'
    ) return undefined;
    return { platform, userAgent, screen, viewport, language, online: input.online, currentPath };
}

export function parseClaimedFeedbackEmailJob(value: unknown, expectedLeaseToken: string): FeedbackEmailJob | null {
    const row = record(value);
    if (!row) return null;

    const jobId = inline(row.job_id, 36, 36);
    const leaseToken = inline(row.lease_token, 36, 36);
    const submissionId = inline(row.submission_id, 36, 36);
    const messageKind = typeof row.message_kind === 'string' &&
            FEEDBACK_MESSAGE_KINDS.includes(row.message_kind as (typeof FEEDBACK_MESSAGE_KINDS)[number])
        ? (row.message_kind as FeedbackEmailJob['messageKind'])
        : null;
    const attempts = typeof row.attempts === 'number' && Number.isSafeInteger(row.attempts) &&
            row.attempts >= 1 && row.attempts <= 1_000
        ? row.attempts
        : null;
    const reference = inline(row.reference, 11, 11);
    const kind = row.kind === 'bug' || row.kind === 'feature' ? row.kind : null;
    const name = inline(row.name, 2, 80);
    const email = inline(row.email, 3, 254);
    const area = typeof row.area === 'string' && FEEDBACK_AREAS.has(row.area) ? row.area : null;
    const title = inline(row.title, 5, 120);
    const details = multiline(row.details, 20, 4_000);
    const impact = typeof row.impact === 'string' &&
            ((kind === 'bug' && BUG_IMPACTS.has(row.impact)) ||
                (kind === 'feature' && FEATURE_IMPACTS.has(row.impact)))
        ? row.impact
        : null;
    const stepsToReproduce = optionalMultiline(row.steps_to_reproduce, 2_000);
    const expectedResult = optionalMultiline(row.expected_result, 2_000);
    const actualResult = optionalMultiline(row.actual_result, 2_000);
    const problemToSolve = optionalMultiline(row.problem_to_solve, 2_000);
    const idealOutcome = optionalMultiline(row.ideal_outcome, 2_000);
    const device = optionalInline(row.device, 120);
    const appVersion = optionalInline(row.app_version, 40);
    const appBuild = optionalInline(row.app_build, 40);
    const appPlatform = optionalInline(row.app_platform, 40);
    const diagnostics = parseDiagnostics(row.diagnostics);
    const source = typeof row.source === 'string' && SOURCE.test(row.source) ? row.source : null;
    const consentVersion = row.consent_version === 'product-feedback-v1' ? row.consent_version : null;
    const submissionStatus = typeof row.submission_status === 'string' && FEEDBACK_STATUSES.has(row.submission_status)
        ? row.submission_status
        : null;

    if (
        !jobId ||
        !leaseToken ||
        !submissionId ||
        !UUID.test(jobId) ||
        !UUID.test(leaseToken) ||
        !UUID.test(submissionId) ||
        leaseToken !== expectedLeaseToken ||
        !messageKind ||
        attempts === null ||
        !reference ||
        !REFERENCE.test(reference) ||
        !kind ||
        !name ||
        !email ||
        !EMAIL.test(email) ||
        !area ||
        !title ||
        !details ||
        !impact ||
        stepsToReproduce === undefined ||
        expectedResult === undefined ||
        actualResult === undefined ||
        problemToSolve === undefined ||
        idealOutcome === undefined ||
        device === undefined ||
        appVersion === undefined ||
        appBuild === undefined ||
        appPlatform === undefined ||
        diagnostics === undefined ||
        !source ||
        !consentVersion ||
        !submissionStatus ||
        (kind === 'bug' && (problemToSolve !== null || idealOutcome !== null)) ||
        (kind === 'feature' &&
            (stepsToReproduce !== null || expectedResult !== null || actualResult !== null || diagnostics !== null))
    ) return null;

    return {
        jobId,
        leaseToken,
        submissionId,
        messageKind,
        attempts,
        reference,
        kind,
        name,
        email,
        area,
        title,
        details,
        impact,
        stepsToReproduce,
        expectedResult,
        actualResult,
        problemToSolve,
        idealOutcome,
        device,
        appVersion,
        appBuild,
        appPlatform,
        diagnostics,
        source,
        consentVersion,
        submissionStatus,
    };
}

function claimIdentity(value: unknown, expectedLeaseToken: string): { jobId: string; leaseToken: string } | null {
    const row = record(value);
    const jobId = typeof row?.job_id === 'string' ? row.job_id : '';
    const leaseToken = typeof row?.lease_token === 'string' ? row.lease_token : '';
    return UUID.test(jobId) && leaseToken === expectedLeaseToken ? { jobId, leaseToken } : null;
}

export async function runFeedbackEmailWorker(
    gateway: FeedbackEmailQueueGateway,
    config: FeedbackEmailConfig | null,
    fetcher: FetchLike = fetch,
    leaseToken = crypto.randomUUID(),
): Promise<FeedbackEmailWorkerResult> {
    const claimed = await gateway.claim(
        leaseToken,
        FEEDBACK_EMAIL_WORKER_BATCH_LIMIT,
        FEEDBACK_EMAIL_WORKER_LEASE_SECONDS,
    );
    const result: FeedbackEmailWorkerResult = {
        claimed: claimed.length,
        sent: 0,
        retried: 0,
        dead: 0,
        checkpointFailures: 0,
    };

    for (const claimedRow of claimed) {
        const identity = claimIdentity(claimedRow, leaseToken);
        const job = parseClaimedFeedbackEmailJob(claimedRow, leaseToken);
        if (!job) {
            if (!identity) {
                result.checkpointFailures += 1;
                continue;
            }
            try {
                await gateway.retry(identity.jobId, identity.leaseToken, 'invalid_job_payload', 0, true);
                result.dead += 1;
            } catch {
                result.checkpointFailures += 1;
            }
            continue;
        }

        const delivery = await deliverFeedbackEmail(job, config, fetcher);
        try {
            if (delivery.outcome === 'sent') {
                await gateway.finish(job.jobId, job.leaseToken, delivery.providerMessageId);
                result.sent += 1;
            } else if (delivery.outcome === 'dead') {
                await gateway.retry(job.jobId, job.leaseToken, delivery.errorCode, 0, true);
                result.dead += 1;
            } else {
                await gateway.retry(
                    job.jobId,
                    job.leaseToken,
                    delivery.errorCode,
                    delivery.retryAfterSeconds,
                    delivery.terminal,
                );
                if (delivery.terminal) result.dead += 1;
                else result.retried += 1;
            }
        } catch {
            // Lease expiry makes an uncheckpointed delivery recoverable, while
            // Resend's stable idempotency key prevents duplicate messages.
            result.checkpointFailures += 1;
        }
    }

    return result;
}
