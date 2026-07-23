// Reconcile expired or interrupted Stripe escrow holds.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { jsonResponse, requireServiceRolePost } from '../_shared/http-security.ts';

interface ReconciliationRow {
    escrow_id: string;
    payment_intent_id: string;
    listing_id: string;
    escrow_status: 'awaiting_handoff' | 'capture_pending' | 'expired' | 'canceled';
    escrow_expires_at: string;
}

const STRIPE_TIMEOUT_MS = 12_000;

serve(async (req) => {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const authorizationFailure = requireServiceRolePost(req, serviceRoleKey);
    if (authorizationFailure) return authorizationFailure;

    try {
        const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        if (!stripeKey || !supabaseUrl || !serviceRoleKey) {
            return jsonResponse({ error: 'Server dependencies are not configured' }, 500);
        }

        const stripe = new Stripe(stripeKey, {
            apiVersion: '2023-10-16',
            httpClient: Stripe.createFetchHttpClient(),
            timeout: STRIPE_TIMEOUT_MS,
            maxNetworkRetries: 1,
        });
        const supabase = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const { data, error } = await supabase.rpc('claim_marketplace_escrow_reconciliation', {
            p_limit: 10,
        });
        if (error) throw error;

        const rows = (Array.isArray(data) ? data : []) as ReconciliationRow[];
        let canceledCount = 0;
        let finalizedCount = 0;
        let releasedCount = 0;
        let failedCount = 0;

        for (const escrow of rows) {
            try {
                if (
                    !/^[0-9a-f-]{36}$/i.test(escrow.escrow_id) ||
                    !/^pi_[A-Za-z0-9]{8,}$/.test(escrow.payment_intent_id)
                ) {
                    throw new Error('Invalid reconciliation row');
                }

                const paymentIntent = await stripe.paymentIntents.retrieve(escrow.payment_intent_id);
                if (paymentIntent.status === 'succeeded') {
                    const { data: finalized, error: finalizeError } = await supabase.rpc(
                        'finalize_marketplace_escrow_release',
                        {
                            p_escrow_id: escrow.escrow_id,
                            p_payment_intent_id: escrow.payment_intent_id,
                        },
                    );
                    if (finalizeError || !finalized?.success) {
                        throw finalizeError ?? new Error('Escrow finalization failed');
                    }
                    finalizedCount++;
                    continue;
                }

                const expiresAt = Date.parse(escrow.escrow_expires_at);
                if (
                    escrow.escrow_status === 'capture_pending' &&
                    Number.isFinite(expiresAt) &&
                    expiresAt > Date.now() &&
                    paymentIntent.status === 'requires_capture'
                ) {
                    const { data: released, error: releaseError } = await supabase.rpc(
                        'release_marketplace_escrow_capture',
                        {
                            p_escrow_id: escrow.escrow_id,
                            p_payment_intent_id: escrow.payment_intent_id,
                        },
                    );
                    if (releaseError || !released) {
                        throw releaseError ?? new Error('Escrow capture release failed');
                    }
                    releasedCount++;
                    continue;
                }

                if (paymentIntent.status !== 'canceled') {
                    await stripe.paymentIntents.cancel(
                        escrow.payment_intent_id,
                        {},
                        { idempotencyKey: `thalassa-expire-${escrow.escrow_id}` },
                    );
                }

                const { data: completed, error: completionError } = await supabase.rpc(
                    'complete_marketplace_escrow_cancellation',
                    {
                        p_escrow_id: escrow.escrow_id,
                        p_payment_intent_id: escrow.payment_intent_id,
                    },
                );
                if (completionError || !completed) {
                    throw completionError ?? new Error('Escrow cancellation finalization failed');
                }
                canceledCount++;
            } catch (reconciliationError) {
                failedCount++;
                console.error(
                    `[sweep-expired-escrows] Reconciliation failed for ${escrow.escrow_id}:`,
                    reconciliationError,
                );
            }
        }

        return jsonResponse({
            success: true,
            claimed_count: rows.length,
            canceled_count: canceledCount,
            finalized_count: finalizedCount,
            released_count: releasedCount,
            failed_count: failedCount,
        });
    } catch (error) {
        console.error('[sweep-expired-escrows] Sweep failed:', error);
        return jsonResponse({ error: 'Escrow sweep failed' }, 500);
    }
});
