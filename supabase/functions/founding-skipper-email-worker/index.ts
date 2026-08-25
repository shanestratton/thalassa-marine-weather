import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse } from '../_shared/http-security.ts';
import { readFoundingSkipperEmailConfig } from './email.ts';
import {
    type FoundingSkipperEmailQueueGateway,
    requireAppliedEmailQueueCheckpoint,
    requireFoundingSkipperEmailWorkerRequest,
    runFoundingSkipperEmailWorker,
} from './worker.ts';

function queueGateway(admin: SupabaseClient): FoundingSkipperEmailQueueGateway {
    return {
        async claim(leaseToken, limit, leaseSeconds) {
            const { data, error } = await admin.rpc('claim_founding_skipper_email_jobs', {
                p_lease_token: leaseToken,
                p_limit: limit,
                p_lease_seconds: leaseSeconds,
            });
            if (error) throw new Error('email_queue_claim_failed');
            if (data === null || data === undefined) return [];
            return Array.isArray(data) ? data : [data];
        },
        async confirmAcceptedLease(jobId, applicationId, leaseToken) {
            const { data: application, error: applicationError } = await admin
                .from('founding_skipper_applications')
                .select('status')
                .eq('id', applicationId)
                .maybeSingle();
            if (applicationError) throw new Error('email_acceptance_fence_failed');

            // Read the lease last so it is the freshest persisted state before
            // the Resend POST. A missing/reclaimed lease must never be altered
            // by this invocation.
            const { data: outbox, error: outboxError } = await admin
                .from('founding_skipper_email_outbox')
                .select('application_id, message_kind, state, lease_token')
                .eq('id', jobId)
                .maybeSingle();
            if (outboxError) throw new Error('email_acceptance_fence_failed');
            if (!outbox || outbox.state !== 'processing' || outbox.lease_token !== leaseToken) return 'lost';
            if (
                outbox.application_id !== applicationId ||
                outbox.message_kind !== 'applicant_accepted_v1' ||
                !application ||
                application.status !== 'accepted'
            ) {
                return 'cancel';
            }
            return 'ready';
        },
        async finish(jobId, leaseToken, providerMessageId) {
            const { data, error } = await admin.rpc('finish_founding_skipper_email_job', {
                p_job_id: jobId,
                p_lease_token: leaseToken,
                p_provider_message_id: providerMessageId,
            });
            requireAppliedEmailQueueCheckpoint(data, error, 'email_queue_finish_failed');
        },
        async retry(jobId, leaseToken, errorCode, retryAfterSeconds, terminal) {
            const { data, error } = await admin.rpc('retry_founding_skipper_email_job', {
                p_job_id: jobId,
                p_lease_token: leaseToken,
                p_error_code: errorCode,
                p_retry_after_seconds: retryAfterSeconds,
                p_terminal: terminal,
            });
            requireAppliedEmailQueueCheckpoint(data, error, 'email_queue_retry_failed');
        },
        async cancel(jobId, leaseToken, reasonCode) {
            const { data, error } = await admin.rpc('cancel_founding_skipper_email_job', {
                p_job_id: jobId,
                p_lease_token: leaseToken,
                p_reason_code: reasonCode,
            });
            requireAppliedEmailQueueCheckpoint(data, error, 'email_queue_cancel_failed');
        },
    };
}

Deno.serve(async (req: Request) => {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authorizationFailure = requireFoundingSkipperEmailWorkerRequest(req, serviceRoleKey);
    if (authorizationFailure) return authorizationFailure;

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl || !serviceRoleKey) {
        return jsonResponse({ error: 'Email worker database is not configured' }, 500);
    }
    const emailConfig = readFoundingSkipperEmailConfig();
    if (!emailConfig) {
        // Fail before claiming: configuration outages must not consume the
        // outbox's finite attempt budget or turn deliverable mail into dead letters.
        console.error('[founding-skipper-email-worker] email delivery is not configured');
        return jsonResponse({ error: 'Email delivery is temporarily unavailable' }, 503);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    try {
        const result = await runFoundingSkipperEmailWorker(
            queueGateway(admin),
            emailConfig,
        );
        return jsonResponse(result, result.checkpointFailures > 0 ? 503 : 200);
    } catch {
        console.error('[founding-skipper-email-worker] queue claim failed');
        return jsonResponse({ error: 'Email queue is temporarily unavailable' }, 503);
    }
});
