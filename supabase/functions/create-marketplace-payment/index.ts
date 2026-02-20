// Supabase Edge Function: Create Stripe Payment Intent (AUTH-ONLY HOLD)
// Deploy: supabase functions deploy create-marketplace-payment
//
// Zero-Mediation Escrow Flow:
// 1. Creates a Stripe PaymentIntent with capture_method = 'manual' (auth-only hold)
// 2. Generates a random 4-digit PIN for the buyer
// 3. Creates escrow record with 48h expiry
// 4. Returns client_secret + PIN to buyer
// 5. Seller enters PIN → triggers capture-escrow-payment edge function
// 6. If 48h pass without PIN entry → pg_cron expires the hold

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';

const PLATFORM_FEE_PERCENT = 6;
const ESCROW_TTL_HOURS = 48;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/** Generate a random 4-digit PIN (1000-9999) */
const generatePin = (): string => {
    return String(Math.floor(1000 + Math.random() * 9000));
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
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return new Response(JSON.stringify({ error: 'Invalid token' }), {
                status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const { listing_id } = await req.json();
        if (!listing_id) {
            return new Response(JSON.stringify({ error: 'listing_id is required' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Fetch listing
        const { data: listing, error: listingError } = await supabase
            .from('marketplace_listings')
            .select('*')
            .eq('id', listing_id)
            .eq('status', 'available')
            .single();

        if (listingError || !listing) {
            return new Response(JSON.stringify({ error: 'Listing not found or no longer available' }), {
                status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        if (listing.seller_id === user.id) {
            return new Response(JSON.stringify({ error: 'Cannot purchase your own listing' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Get seller's connected Stripe account
        const { data: sellerProfile } = await supabase
            .from('chat_profiles')
            .select('stripe_account_id')
            .eq('user_id', listing.seller_id)
            .single();

        if (!sellerProfile?.stripe_account_id) {
            return new Response(JSON.stringify({ error: 'Seller has not set up Stripe payments' }), {
                status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Calculate fees
        const amountCents = Math.round(parseFloat(listing.price) * 100);
        const platformFeeCents = Math.round(amountCents * PLATFORM_FEE_PERCENT / 100);
        const sellerPayoutCents = amountCents - platformFeeCents;
        const stripeCurrency = (listing.currency || 'AUD').toLowerCase();

        // Generate 4-digit PIN
        const escrowPin = generatePin();

        // Calculate expiry (48 hours from now)
        const expiresAt = new Date(Date.now() + ESCROW_TTL_HOURS * 60 * 60 * 1000).toISOString();

        // Create Stripe Payment Intent — AUTH ONLY (capture_method: 'manual')
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: stripeCurrency,
            capture_method: 'manual',  // ← AUTH ONLY, no immediate capture
            application_fee_amount: platformFeeCents,
            transfer_data: {
                destination: sellerProfile.stripe_account_id,
            },
            metadata: {
                listing_id: listing.id,
                buyer_id: user.id,
                seller_id: listing.seller_id,
                listing_title: listing.title,
                platform_fee_percent: String(PLATFORM_FEE_PERCENT),
                escrow_type: 'zero_mediation_pin',
            },
            description: `Thalassa Escrow: ${listing.title}`,
            automatic_payment_methods: { enabled: true },
        });

        // Create escrow record with PIN
        const { data: escrow, error: escrowError } = await supabase
            .from('marketplace_escrow')
            .insert({
                listing_id: listing.id,
                buyer_id: user.id,
                seller_id: listing.seller_id,
                amount_cents: amountCents,
                platform_fee_cents: platformFeeCents,
                seller_payout_cents: sellerPayoutCents,
                currency: listing.currency || 'AUD',
                stripe_payment_intent_id: paymentIntent.id,
                escrow_pin: escrowPin,
                escrow_status: 'awaiting_handoff',
                escrow_expires_at: expiresAt,
            })
            .select('id')
            .single();

        if (escrowError) {
            // Rollback: cancel the PI if escrow insert fails
            await stripe.paymentIntents.cancel(paymentIntent.id);
            throw new Error(`Escrow creation failed: ${escrowError.message}`);
        }

        // Mark listing as pending
        await supabase
            .from('marketplace_listings')
            .update({ status: 'pending' })
            .eq('id', listing.id);

        return new Response(
            JSON.stringify({
                clientSecret: paymentIntent.client_secret,
                paymentIntentId: paymentIntent.id,
                escrowId: escrow.id,
                escrowPin: escrowPin,  // Only visible to buyer
                expiresAt,
                amountCents,
                platformFeeCents,
                sellerPayoutCents,
                currency: stripeCurrency,
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    } catch (err) {
        console.error('Marketplace payment error:', err);
        return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});
