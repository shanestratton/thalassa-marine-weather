import {
    deliverFoundingSkipperEmail,
    FOUNDING_SKIPPER_MESSAGE_KINDS,
    type FoundingSkipperEmailConfig,
    type FoundingSkipperEmailJob,
} from './email.ts';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const INLINE_CONTROL = /[\u0000-\u001f\u007f]/u;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SOURCE = /^[a-z0-9][a-z0-9_-]{0,39}$/u;
const WORKER_KEY_HEADER = 'x-thalassa-worker-key';
const WORKER_KEY_MAX_LENGTH = 1_024;

export const EMAIL_WORKER_BATCH_LIMIT = 10;
export const EMAIL_WORKER_LEASE_SECONDS = 90;

export interface FoundingSkipperEmailQueueGateway {
    claim(leaseToken: string, limit: number, leaseSeconds: number): Promise<unknown[]>;
    confirmAcceptedLease(
        jobId: string,
        applicationId: string,
        leaseToken: string,
    ): Promise<'ready' | 'cancel' | 'lost'>;
    finish(jobId: string, leaseToken: string, providerMessageId: string): Promise<void>;
    retry(
        jobId: string,
        leaseToken: string,
        errorCode: string,
        retryAfterSeconds: number,
        terminal: boolean,
    ): Promise<void>;
    cancel(jobId: string, leaseToken: string, reasonCode: string): Promise<void>;
}

export interface FoundingSkipperEmailWorkerResult {
    claimed: number;
    sent: number;
    retried: number;
    dead: number;
    cancelled: number;
    skipped: number;
    checkpointFailures: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function requireAppliedEmailQueueCheckpoint(data: unknown, error: unknown, code: string): void {
    if (error || data !== true) throw new Error(code);
}

export function requireFoundingSkipperEmailWorkerRequest(
    request: Request,
    serviceRoleKey: string | undefined,
): Response | null {
    if (request.method !== 'POST' || !serviceRoleKey) {
        return requireServiceRolePost(request, serviceRoleKey);
    }

    const authorization = request.headers.get('authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    if (
        matchesBoundedWorkerSecret(bearer, serviceRoleKey) ||
        matchesBoundedWorkerSecret(request.headers.get(WORKER_KEY_HEADER), serviceRoleKey)
    ) {
        return null;
    }

    // Supabase may expose a modern secret as SUPABASE_SERVICE_ROLE_KEY while
    // pg_net/Vault still invokes the function with the project's legacy
    // service-role JWT. `verify_jwt = true` in supabase/config.toml verifies
    // that JWT's signature and lifetime at the Edge gateway before this code
    // runs; this second check only narrows an already verified JWT to the
    // service_role claim. Never deploy this compatibility path with gateway
    // JWT verification disabled.
    if (hasGatewayVerifiedServiceRoleJwt(authorization)) return null;

    return jsonResponse({ error: 'Unauthorized' }, 401, {
        'WWW-Authenticate': 'Bearer',
    });
}

function matchesBoundedWorkerSecret(candidate: string | null, configured: string): boolean {
    if (
        !candidate ||
        candidate.length > WORKER_KEY_MAX_LENGTH ||
        configured.length < 1 ||
        configured.length > WORKER_KEY_MAX_LENGTH
    ) {
        return false;
    }

    // The fast-wake gateway credential is intentionally public, so the
    // dedicated worker header is the authorization secret. Avoid an early-exit
    // string comparison that could expose a useful remote timing oracle.
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

function inline(value: unknown, min: number, max: number): string | null {
    return typeof value === 'string' &&
            value.length >= min &&
            value.length <= max &&
            !INLINE_CONTROL.test(value)
        ? value
        : null;
}

function multiline(value: unknown, max: number): string | null | undefined {
    if (value === null) return null;
    return typeof value === 'string' && value.length <= max && !MULTILINE_CONTROL.test(value) ? value : undefined;
}

export function parseClaimedFoundingSkipperEmailJob(
    value: unknown,
    expectedLeaseToken: string,
): FoundingSkipperEmailJob | null {
    const row = record(value);
    if (!row) return null;

    const jobId = inline(row.job_id, 36, 36);
    const leaseToken = inline(row.lease_token, 36, 36);
    const applicationId = inline(row.application_id, 36, 36);
    const rawMessageKind = row.message_kind ?? row.kind;
    const messageKind = typeof rawMessageKind === 'string' &&
            FOUNDING_SKIPPER_MESSAGE_KINDS.includes(
                rawMessageKind as (typeof FOUNDING_SKIPPER_MESSAGE_KINDS)[number],
            )
        ? (rawMessageKind as FoundingSkipperEmailJob['messageKind'])
        : null;
    const rawAttempts = row.attempts ?? row.attempt_count;
    const attempts = typeof rawAttempts === 'number' && Number.isSafeInteger(rawAttempts) && rawAttempts >= 1 &&
            rawAttempts <= 1_000
        ? rawAttempts
        : null;
    const name = inline(row.name ?? row.application_name, 2, 80);
    const email = inline(row.email ?? row.application_email, 3, 254);
    const boatType = inline(row.boat_type, 1, 40);
    const homeWaters = inline(row.home_waters, 2, 120);
    const appleDevice = inline(row.apple_device, 1, 40);
    const boatingFrequency = inline(row.boating_frequency, 1, 40);
    const interests = Array.isArray(row.interests) && row.interests.length >= 1 && row.interests.length <= 6 &&
            row.interests.every((interest) => inline(interest, 1, 40))
        ? (row.interests as string[])
        : null;
    const notes = multiline(row.notes, 800);
    const source = typeof row.source === 'string' && SOURCE.test(row.source) ? row.source : null;
    const consentVersion =
        row.consent_version === 'founding-skippers-v1' || row.consent_version === 'founding-skippers-v2'
            ? row.consent_version
            : null;
    const applicationStatus = inline(row.application_status, 1, 40);

    if (
        !jobId ||
        !leaseToken ||
        !applicationId ||
        !UUID.test(jobId) ||
        !UUID.test(leaseToken) ||
        !UUID.test(applicationId) ||
        leaseToken !== expectedLeaseToken ||
        !messageKind ||
        attempts === null ||
        !name ||
        !email ||
        !EMAIL.test(email) ||
        !boatType ||
        !homeWaters ||
        !appleDevice ||
        !boatingFrequency ||
        !interests ||
        notes === undefined ||
        !source ||
        !consentVersion ||
        !applicationStatus
    ) {
        return null;
    }

    return {
        jobId,
        leaseToken,
        applicationId,
        messageKind,
        attempts,
        name,
        email,
        boatType,
        homeWaters,
        appleDevice,
        boatingFrequency,
        interests,
        notes,
        source,
        consentVersion,
        applicationStatus,
    };
}

function claimIdentity(value: unknown, expectedLeaseToken: string): { jobId: string; leaseToken: string } | null {
    const row = record(value);
    const jobId = typeof row?.job_id === 'string' ? row.job_id : '';
    const leaseToken = typeof row?.lease_token === 'string' ? row.lease_token : '';
    return UUID.test(jobId) && leaseToken === expectedLeaseToken ? { jobId, leaseToken } : null;
}

export async function runFoundingSkipperEmailWorker(
    gateway: FoundingSkipperEmailQueueGateway,
    config: FoundingSkipperEmailConfig | null,
    fetcher: FetchLike = fetch,
    leaseToken = crypto.randomUUID(),
): Promise<FoundingSkipperEmailWorkerResult> {
    const claimed = await gateway.claim(leaseToken, EMAIL_WORKER_BATCH_LIMIT, EMAIL_WORKER_LEASE_SECONDS);
    const result: FoundingSkipperEmailWorkerResult = {
        claimed: claimed.length,
        sent: 0,
        retried: 0,
        dead: 0,
        cancelled: 0,
        skipped: 0,
        checkpointFailures: 0,
    };

    for (const claimedRow of claimed) {
        const identity = claimIdentity(claimedRow, leaseToken);
        const job = parseClaimedFoundingSkipperEmailJob(claimedRow, leaseToken);
        if (!job) {
            if (!identity) {
                result.checkpointFailures += 1;
                continue;
            }
            try {
                await gateway.cancel(identity.jobId, identity.leaseToken, 'invalid_job_payload');
                result.cancelled += 1;
            } catch {
                result.checkpointFailures += 1;
            }
            continue;
        }

        if (job.messageKind !== 'operator_new_v1' && job.consentVersion !== 'founding-skippers-v2') {
            try {
                await gateway.cancel(job.jobId, job.leaseToken, 'applicant_email_not_consented');
                result.cancelled += 1;
            } catch {
                result.checkpointFailures += 1;
            }
            continue;
        }

        if (job.messageKind === 'applicant_accepted_v1' && job.applicationStatus !== 'accepted') {
            try {
                await gateway.cancel(job.jobId, job.leaseToken, 'application_not_accepted');
                result.cancelled += 1;
            } catch {
                result.checkpointFailures += 1;
            }
            continue;
        }

        if (job.messageKind === 'applicant_accepted_v1') {
            let fence: 'ready' | 'cancel' | 'lost';
            try {
                // This is deliberately the final database operation before
                // the provider call. It closes the ordinary review/rejection
                // race and proves this invocation still owns the job lease.
                fence = await gateway.confirmAcceptedLease(job.jobId, job.applicationId, job.leaseToken);
            } catch {
                result.checkpointFailures += 1;
                continue;
            }
            if (fence === 'lost') {
                result.skipped += 1;
                continue;
            }
            if (fence === 'cancel') {
                try {
                    await gateway.cancel(job.jobId, job.leaseToken, 'application_not_accepted');
                    result.cancelled += 1;
                } catch {
                    result.checkpointFailures += 1;
                }
                continue;
            }
        }

        const delivery = await deliverFoundingSkipperEmail(job, config, fetcher);
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
            // The lease expiry makes an uncheckpointed delivery recoverable.
            // Resend's stable idempotency key prevents a duplicate message.
            result.checkpointFailures += 1;
        }
    }

    return result;
}
