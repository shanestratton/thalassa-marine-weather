import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { jsonResponse } from '../_shared/http-security.ts';
import { readFeedbackEmailConfig } from './email.ts';
import {
    type FeedbackEmailQueueGateway,
    requireAppliedFeedbackEmailCheckpoint,
    requireFeedbackEmailWorkerRequest,
    runFeedbackEmailWorker,
} from './worker.ts';

function queueGateway(admin: SupabaseClient): FeedbackEmailQueueGateway {
    return {
        async claim(leaseToken, limit, leaseSeconds) {
            const { data, error } = await admin.rpc('claim_product_feedback_email_jobs', {
                p_lease_token: leaseToken,
                p_limit: limit,
                p_lease_seconds: leaseSeconds,
            });
            if (error) throw new Error('feedback_email_queue_claim_failed');
            if (data === null || data === undefined) return [];
            return Array.isArray(data) ? data : [data];
        },
        async finish(jobId, leaseToken, providerMessageId) {
            const { data, error } = await admin.rpc('finish_product_feedback_email_job', {
                p_job_id: jobId,
                p_lease_token: leaseToken,
                p_provider_message_id: providerMessageId,
            });
            requireAppliedFeedbackEmailCheckpoint(data, error, 'feedback_email_queue_finish_failed');
        },
        async retry(jobId, leaseToken, errorCode, retryAfterSeconds, terminal) {
            const { data, error } = await admin.rpc('retry_product_feedback_email_job', {
                p_job_id: jobId,
                p_lease_token: leaseToken,
                p_error_code: errorCode,
                p_retry_after_seconds: retryAfterSeconds,
                p_terminal: terminal,
            });
            requireAppliedFeedbackEmailCheckpoint(data, error, 'feedback_email_queue_retry_failed');
        },
    };
}

Deno.serve(async (req: Request) => {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authorizationFailure = requireFeedbackEmailWorkerRequest(req, serviceRoleKey);
    if (authorizationFailure) return authorizationFailure;

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl || !serviceRoleKey) {
        return jsonResponse({ error: 'Feedback email worker database is not configured' }, 500);
    }

    const emailConfig = readFeedbackEmailConfig();
    if (!emailConfig) {
        // Configuration failures must happen before claiming so an outage does
        // not consume the queue's finite attempt budget.
        console.error('[feedback-email-worker] email delivery is not configured');
        return jsonResponse({ error: 'Email delivery is temporarily unavailable' }, 503);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    try {
        const result = await runFeedbackEmailWorker(queueGateway(admin), emailConfig);
        return jsonResponse(result, result.checkpointFailures > 0 ? 503 : 200);
    } catch {
        console.error('[feedback-email-worker] queue claim failed');
        return jsonResponse({ error: 'Feedback email queue is temporarily unavailable' }, 503);
    }
});
