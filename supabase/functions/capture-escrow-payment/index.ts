// Supabase Edge Function: Capture Escrow Payment via 6-Digit PIN
// Deploy: supabase functions deploy capture-escrow-payment
//
// Flow:
// 1. Seller enters buyer's 6-digit PIN
// 2. RPC `verify_escrow_pin` validates PIN in database
// 3. If valid, this function captures the Stripe PaymentIntent
// 4. 94% goes to seller via Connect, 6% retained as platform fee
// 5. Escrow status updated to 'released', listing marked 'sold'

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200): Response => jsonResponse(body, status, corsHeaders);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRIPE_TIMEOUT_MS = 12_000;

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

    const caller = await requireAuthenticatedQuota(req, 'marketplace_payment_capture', 20, 3600);
    if (caller instanceof Response) return withCors(caller, corsHeaders);

    try {
        if (Deno.env.get('MARKETPLACE_ENABLED') !== 'true') {
            return json({ error: 'Marketplace payments are not currently available' }, 503);
        }
        const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
        const authHeader = req.headers.get('authorization');
        if (!stripeKey || !supabaseUrl || !supabaseServiceKey || !anonKey || !authHeader) {
            console.error('[capture-escrow] Required server configuration is missing');
            return json({ error: 'Marketplace payments are not currently available' }, 503);
        }

        const stripe = new Stripe(stripeKey, {
            apiVersion: '2023-10-16',
            httpClient: Stripe.createFetchHttpClient(),
            timeout: STRIPE_TIMEOUT_MS,
            maxNetworkRetries: 1,
        });

        // Create two clients: one as the caller (for RPC auth check), one as service role (for updates)
        const supabaseUser = createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

        const body = await readJsonObject(req, 2_048);
        const escrowId = typeof body?.escrow_id === 'string' ? body.escrow_id.trim() : '';
        const pin = typeof body?.pin === 'string' ? body.pin : '';
        if (!UUID_PATTERN.test(escrowId) || !/^\d{6}$/.test(pin)) {
            return json({ error: 'A valid escrow_id and six-digit PIN are required' }, 400);
        }

        // Step 1: Verify PIN via database RPC (runs as the calling user for auth check)
        const { data: verifyResult, error: rpcError } = await supabaseUser.rpc('verify_escrow_pin', {
            p_escrow_id: escrowId,
            p_pin: pin,
        });

        if (rpcError) {
            console.error(`[capture-escrow] PIN RPC failed: ${rpcError.message}`);
            return json({ error: 'PIN verification is temporarily unavailable' }, 503);
        }

        if (!verifyResult?.success) {
            const safeReason =
                typeof verifyResult?.error === 'string' &&
                [
                    'Invalid PIN',
                    'Escrow not found',
                    'Escrow is no longer active',
                    'Escrow has expired',
                    'Too many attempts; try again later',
                ].includes(verifyResult.error)
                    ? verifyResult.error
                    : 'PIN verification failed';
            return json({ error: safeReason }, safeReason.startsWith('Too many') ? 429 : 400);
        }

        // Step 2: Capture the Stripe Payment Intent
        const paymentIntentId =
            typeof verifyResult.payment_intent_id === 'string' ? verifyResult.payment_intent_id : '';
        const verifiedEscrowId = typeof verifyResult.escrow_id === 'string' ? verifyResult.escrow_id : '';
        if (verifiedEscrowId !== escrowId || !/^pi_[A-Za-z0-9]{8,}$/.test(paymentIntentId)) {
            console.error('[capture-escrow] PIN RPC returned an invalid payment reference');
            return json({ error: 'Escrow payment reference is invalid' }, 500);
        }

        let capturedPI: Stripe.PaymentIntent;
        try {
            capturedPI = await stripe.paymentIntents.capture(
                paymentIntentId,
                {},
                { idempotencyKey: `thalassa-escrow-${verifiedEscrowId}` },
            );
        } catch (captureError) {
            // Stripe may have completed a previous request whose response was
            // lost. Retrieve the intent so a retry can reconcile the database.
            console.warn('[capture-escrow] Capture call failed; checking intent state');
            capturedPI = await stripe.paymentIntents.retrieve(paymentIntentId);
            if (capturedPI.status !== 'succeeded') {
                await supabaseAdmin.rpc('release_marketplace_escrow_capture', {
                    p_escrow_id: verifiedEscrowId,
                    p_payment_intent_id: paymentIntentId,
                });
                throw captureError;
            }
        }

        if (capturedPI.status !== 'succeeded') {
            await supabaseAdmin.rpc('release_marketplace_escrow_capture', {
                p_escrow_id: verifiedEscrowId,
                p_payment_intent_id: paymentIntentId,
            });
            console.error(`[capture-escrow] Stripe returned non-success status: ${capturedPI.status}`);
            return json({ error: 'Payment capture is not complete' }, 503);
        }

        // Finalize escrow + listing in one database transaction. The RPC is
        // idempotent, so a retry safely repairs a lost post-capture response.
        const { data: finalization, error: finalizationError } = await supabaseAdmin.rpc(
            'finalize_marketplace_escrow_release',
            {
                p_escrow_id: verifiedEscrowId,
                p_payment_intent_id: paymentIntentId,
            },
        );
        if (finalizationError || !finalization?.success) {
            console.error(
                `[capture-escrow] Captured payment requires reconciliation: ${
                    finalizationError?.message ?? finalization?.error ?? 'unknown failure'
                }`,
            );
            return json({ error: 'Payment captured; finalization is pending' }, 503);
        }

        return json({
            success: true,
            captured: true,
            amountCents: verifyResult.amount_cents,
            sellerPayoutCents: verifyResult.seller_payout_cents,
            platformFeeCents: verifyResult.platform_fee_cents,
        });
    } catch (err) {
        console.error('Escrow capture error:', err);
        return json({ error: 'Escrow payment could not be captured' }, 500);
    }
});
