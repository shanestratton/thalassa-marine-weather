// Supabase Edge Function: Sweep Expired Escrows
// Deploy: supabase functions deploy sweep-expired-escrows
//
// Run on a schedule (or triggered by pg_cron calling sweep_expired_escrows())
// This function handles the Stripe side: cancels PaymentIntents for expired holds.
// The database-side status is already updated by the pg_cron sweep_expired_escrows() function.
//
// Can be invoked by pg_cron via: SELECT net.http_post(...) or manually via cron job.

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

        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        // Find all expired escrows that still have a Stripe PI to cancel
        const { data: expired, error } = await supabase
            .from('marketplace_escrow')
            .select('id, stripe_payment_intent_id, listing_id')
            .eq('escrow_status', 'expired')
            .not('stripe_payment_intent_id', 'is', null);

        if (error) throw error;

        let canceledCount = 0;

        for (const escrow of expired || []) {
            try {
                // Cancel the Stripe PaymentIntent (releases the hold)
                const pi = await stripe.paymentIntents.retrieve(escrow.stripe_payment_intent_id);

                if (pi.status === 'requires_capture') {
                    await stripe.paymentIntents.cancel(escrow.stripe_payment_intent_id);
                    canceledCount++;
                }

                // Reset listing to available
                if (escrow.listing_id) {
                    await supabase
                        .from('marketplace_listings')
                        .update({ status: 'available', updated_at: new Date().toISOString() })
                        .eq('id', escrow.listing_id)
                        .eq('status', 'pending');
                }
            } catch (stripeErr) {
                // Log but don't fail the whole sweep
                console.error(`Failed to cancel PI ${escrow.stripe_payment_intent_id}:`, stripeErr);
            }
        }

        return new Response(
            JSON.stringify({
                success: true,
                expired_count: expired?.length || 0,
                canceled_count: canceledCount,
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    } catch (err) {
        console.error('Sweep error:', err);
        return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
