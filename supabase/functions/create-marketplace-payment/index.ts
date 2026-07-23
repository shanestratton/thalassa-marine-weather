// Supabase Edge Function: Create Stripe Payment Intent (AUTH-ONLY HOLD)
// Deploy: supabase functions deploy create-marketplace-payment
//
// Zero-Mediation Escrow Flow:
// 1. Creates a Stripe PaymentIntent with capture_method = 'manual' (auth-only hold)
// 2. Generates a cryptographically-random 6-digit PIN for the buyer
// 3. Creates escrow record with 48h expiry
// 4. Returns client_secret + PIN to buyer
// 5. Seller enters PIN → triggers capture-escrow-payment edge function
// 6. If 48h pass without PIN entry → pg_cron expires the hold

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.14.0?target=deno';
import { requireAuthenticatedQuota, withCors } from '../_shared/auth-rate-limit.ts';
import { jsonResponse, readJsonObject } from '../_shared/http-security.ts';

const PLATFORM_FEE_PERCENT = 6;
const ESCROW_TTL_HOURS = 48;
const STRIPE_TIMEOUT_MS = 12_000;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200): Response => jsonResponse(body, status, corsHeaders);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Generate a random 6-digit PIN (100000-999999). */
const generatePin = (): string => {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return String(100000 + (value[0] % 900000));
};

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'POST') return json({ error: 'POST required' }, 405);

    const caller = await requireAuthenticatedQuota(req, 'marketplace_payment_create', 10, 3600);
    if (caller instanceof Response) return withCors(caller, corsHeaders);

    let rollbackClient: ReturnType<typeof createClient> | null = null;
    let rollbackListingId: string | null = null;
    let rollbackPaymentIntentId: string | null = null;
    let stripeForRollback: Stripe | null = null;
    try {
        if (Deno.env.get('MARKETPLACE_ENABLED') !== 'true') {
            return json({ error: 'Marketplace payments are not currently available' }, 503);
        }
        const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        if (!stripeKey || !supabaseUrl || !supabaseServiceKey) {
            console.error('[marketplace-payment] Required server configuration is missing');
            return json({ error: 'Marketplace payments are not currently available' }, 503);
        }

        const stripe = new Stripe(stripeKey, {
            apiVersion: '2023-10-16',
            httpClient: Stripe.createFetchHttpClient(),
            timeout: STRIPE_TIMEOUT_MS,
            maxNetworkRetries: 1,
        });
        stripeForRollback = stripe;

        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        rollbackClient = supabase;

        const body = await readJsonObject(req, 2_048);
        const listingId = typeof body?.listing_id === 'string' ? body.listing_id.trim() : '';
        if (!UUID_PATTERN.test(listingId)) {
            return json({ error: 'A valid listing_id is required' }, 400);
        }

        // Fetch listing
        const { data: listing, error: listingError } = await supabase
            .from('marketplace_listings')
            .select('*')
            .eq('id', listingId)
            .eq('status', 'available')
            .single();

        if (listingError || !listing) {
            return json({ error: 'Listing not found or no longer available' }, 404);
        }

        if (listing.seller_id === caller.userId) {
            return json({ error: 'Cannot purchase your own listing' }, 400);
        }

        // Get seller's connected Stripe account
        const { data: sellerProfile } = await supabase
            .from('chat_profiles')
            .select('stripe_account_id')
            .eq('user_id', listing.seller_id)
            .single();

        if (
            typeof sellerProfile?.stripe_account_id !== 'string' ||
            !/^acct_[A-Za-z0-9]{8,}$/.test(sellerProfile.stripe_account_id)
        ) {
            return json({ error: 'Seller has not set up Stripe payments' }, 400);
        }

        // Calculate fees
        const amountCents = Math.round(parseFloat(listing.price) * 100);
        const platformFeeCents = Math.round((amountCents * PLATFORM_FEE_PERCENT) / 100);
        const sellerPayoutCents = amountCents - platformFeeCents;
        const stripeCurrency = (listing.currency || 'AUD').toLowerCase();
        if (!Number.isSafeInteger(amountCents) || amountCents < 100 || amountCents > 10_000_000) {
            return json({ error: 'Listing price is outside payment limits' }, 400);
        }
        if (!['aud', 'nzd', 'usd'].includes(stripeCurrency)) {
            return json({ error: 'Unsupported listing currency' }, 400);
        }

        // Claim the listing atomically before creating a Stripe hold. This
        // prevents two buyers racing through the earlier read-then-write flow.
        const { data: reserved, error: reserveError } = await supabase
            .from('marketplace_listings')
            .update({ status: 'pending', updated_at: new Date().toISOString() })
            .eq('id', listing.id)
            .eq('status', 'available')
            .select('id')
            .maybeSingle();
        if (reserveError || !reserved) {
            return json({ error: 'Listing was reserved by another buyer' }, 409);
        }
        rollbackListingId = listing.id;

        // Generate 6-digit PIN
        const escrowPin = generatePin();
        // Calculate expiry (48 hours from now)
        const expiresAt = new Date(Date.now() + ESCROW_TTL_HOURS * 60 * 60 * 1000).toISOString();

        // Create Stripe Payment Intent — AUTH ONLY (capture_method: 'manual')
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: stripeCurrency,
            capture_method: 'manual', // ← AUTH ONLY, no immediate capture
            application_fee_amount: platformFeeCents,
            transfer_data: {
                destination: sellerProfile.stripe_account_id,
            },
            metadata: {
                listing_id: listing.id,
                buyer_id: caller.userId,
                seller_id: listing.seller_id,
                listing_title: listing.title,
                platform_fee_percent: String(PLATFORM_FEE_PERCENT),
                escrow_type: 'zero_mediation_pin',
            },
            description: `Thalassa Escrow: ${listing.title}`,
            automatic_payment_methods: { enabled: true },
        });
        rollbackPaymentIntentId = paymentIntent.id;

        // Create escrow record with PIN
        const { data: escrow, error: escrowError } = await supabase
            .from('marketplace_escrow')
            .insert({
                listing_id: listing.id,
                buyer_id: caller.userId,
                seller_id: listing.seller_id,
                amount_cents: amountCents,
                platform_fee_cents: platformFeeCents,
                seller_payout_cents: sellerPayoutCents,
                currency: listing.currency || 'AUD',
                stripe_payment_intent_id: paymentIntent.id,
                // The database hashes this with bcrypt before storage.
                escrow_pin: escrowPin,
                escrow_status: 'awaiting_handoff',
                escrow_expires_at: expiresAt,
            })
            .select('id')
            .single();

        if (escrowError) {
            throw new Error(`Escrow creation failed: ${escrowError.message}`);
        }
        rollbackListingId = null;
        rollbackPaymentIntentId = null;

        return json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            escrowId: escrow.id,
            escrowPin: escrowPin, // Only visible to buyer
            expiresAt,
            amountCents,
            platformFeeCents,
            sellerPayoutCents,
            currency: stripeCurrency,
        });
    } catch (err) {
        if (rollbackPaymentIntentId && stripeForRollback) {
            await stripeForRollback.paymentIntents.cancel(rollbackPaymentIntentId).catch(() => undefined);
        }
        if (rollbackListingId && rollbackClient) {
            await rollbackClient
                .from('marketplace_listings')
                .update({ status: 'available', updated_at: new Date().toISOString() })
                .eq('id', rollbackListingId)
                .eq('status', 'pending');
        }
        console.error('Marketplace payment error:', err);
        return json({ error: 'Marketplace payment could not be created' }, 500);
    }
});
