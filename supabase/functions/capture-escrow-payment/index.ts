// Supabase Edge Function: Capture Escrow Payment via 4-Digit PIN
// Deploy: supabase functions deploy capture-escrow-payment
//
// Flow:
// 1. Seller enters buyer's 4-digit PIN
// 2. RPC `verify_escrow_pin` validates PIN in database
// 3. If valid, this function captures the Stripe PaymentIntent
// 4. 94% goes to seller via Connect, 6% retained as platform fee
// 5. Escrow status updated to 'released', listing marked 'sold'

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
        if (!stripeKey) throw new Error('STRIPE_SECRET_KEY not configured');

        const stripe = new Stripe(stripeKey, {
            apiVersion: '2023-10-16',
            httpClient: Stripe.createFetchHttpClient(),
        });

        // Auth
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Not authenticated' }), {
                status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

        // Create two clients: one as the caller (for RPC auth check), one as service role (for updates)
        const supabaseUser = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
            global: { headers: { Authorization: authHeader } },
        });
        const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

        const { escrow_id, pin } = await req.json();

        if (!escrow_id || !pin) {
            return new Response(JSON.stringify({ error: 'escrow_id and pin are required' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Step 1: Verify PIN via database RPC (runs as the calling user for auth check)
        const { data: verifyResult, error: rpcError } = await supabaseUser.rpc('verify_escrow_pin', {
            p_escrow_id: escrow_id,
            p_pin: pin,
        });

        if (rpcError) {
            return new Response(JSON.stringify({ error: `Verification failed: ${rpcError.message}` }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (!verifyResult?.success) {
            return new Response(JSON.stringify({ error: verifyResult?.error || 'PIN verification failed' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Step 2: Capture the Stripe Payment Intent
        const paymentIntentId = verifyResult.payment_intent_id;

        const capturedPI = await stripe.paymentIntents.capture(paymentIntentId);

        if (capturedPI.status !== 'succeeded') {
            return new Response(JSON.stringify({ error: `Capture failed: ${capturedPI.status}` }), {
                status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Step 3: Update escrow status to 'released'
        await supabaseAdmin
            .from('marketplace_escrow')
            .update({
                escrow_status: 'released',
                updated_at: new Date().toISOString(),
            })
            .eq('id', verifyResult.escrow_id);

        // Step 4: Mark listing as 'sold'
        const { data: escrow } = await supabaseAdmin
            .from('marketplace_escrow')
            .select('listing_id')
            .eq('id', verifyResult.escrow_id)
            .single();

        if (escrow?.listing_id) {
            await supabaseAdmin
                .from('marketplace_listings')
                .update({ status: 'sold', updated_at: new Date().toISOString() })
                .eq('id', escrow.listing_id);
        }

        return new Response(
            JSON.stringify({
                success: true,
                captured: true,
                amountCents: verifyResult.amount_cents,
                sellerPayoutCents: verifyResult.seller_payout_cents,
                platformFeeCents: verifyResult.platform_fee_cents,
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    } catch (err) {
        console.error('Escrow capture error:', err);
        return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
