-- ============================================================
-- THALASSA MARKETPLACE — Supabase Migration
-- Peer-to-peer marine gear exchange with PostGIS geo-filtering
-- ============================================================

-- Enable PostGIS for geospatial filtering
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. Marketplace Listings Table
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    seller_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'AUD',
    category TEXT NOT NULL CHECK (category IN ('Electronics', 'Sails', 'Rigging', 'Hardware', 'Safety', 'Misc')),
    condition TEXT NOT NULL CHECK (condition IN ('New', 'Like New', 'Used - Good', 'Used - Fair', 'Needs Repair')),
    images TEXT[] DEFAULT '{}',
    location geometry(Point, 4326),
    location_name TEXT,  -- Human-readable marina/harbor name
    status TEXT DEFAULT 'available' CHECK (status IN ('available', 'pending', 'sold')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Spatial index for fast distance filtering
CREATE INDEX IF NOT EXISTS listings_geo_index ON marketplace_listings USING GIST (location);
-- Index for category + status filtering
CREATE INDEX IF NOT EXISTS listings_category_status_idx ON marketplace_listings (category, status, created_at DESC);
-- Index for seller lookups
CREATE INDEX IF NOT EXISTS listings_seller_idx ON marketplace_listings (seller_id);

-- 2. Marketplace Messages (channel stream + DM context)
CREATE TABLE IF NOT EXISTS marketplace_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    channel_id TEXT NOT NULL,
    listing_id UUID REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    message_type TEXT DEFAULT 'listing_card' CHECK (message_type IN ('text', 'listing_card')),
    content TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_msgs_channel_idx ON marketplace_messages (channel_id, created_at DESC);

-- 3. Row Level Security
ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_messages ENABLE ROW LEVEL SECURITY;

-- Listings: anyone authenticated can read available listings
DROP POLICY IF EXISTS "Listings are viewable by everyone" ON marketplace_listings;
CREATE POLICY "Listings are viewable by everyone"
ON marketplace_listings FOR SELECT
USING (auth.role() = 'authenticated');

-- Listings: users can only insert their own
DROP POLICY IF EXISTS "Users can create listings" ON marketplace_listings;
CREATE POLICY "Users can create listings"
ON marketplace_listings FOR INSERT
WITH CHECK (auth.uid() = seller_id);

-- Listings: users can only update their own
DROP POLICY IF EXISTS "Users can update own listings" ON marketplace_listings;
CREATE POLICY "Users can update own listings"
ON marketplace_listings FOR UPDATE
USING (auth.uid() = seller_id);

-- Listings: users can only delete their own
DROP POLICY IF EXISTS "Users can delete own listings" ON marketplace_listings;
CREATE POLICY "Users can delete own listings"
ON marketplace_listings FOR DELETE
USING (auth.uid() = seller_id);

-- Messages: anyone authenticated can read
DROP POLICY IF EXISTS "Messages are viewable by everyone" ON marketplace_messages;
CREATE POLICY "Messages are viewable by everyone"
ON marketplace_messages FOR SELECT
USING (auth.role() = 'authenticated');

-- Messages: users can send their own
DROP POLICY IF EXISTS "Users can send messages" ON marketplace_messages;
CREATE POLICY "Users can send messages"
ON marketplace_messages FOR INSERT
WITH CHECK (auth.uid() = sender_id);

-- 4. PostGIS RPC — Fetch listings within radius (nautical miles)
CREATE OR REPLACE FUNCTION get_listings_within_radius(
    user_lat DOUBLE PRECISION,
    user_lon DOUBLE PRECISION,
    radius_nm DOUBLE PRECISION DEFAULT 50,
    filter_category TEXT DEFAULT NULL,
    result_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    id UUID,
    seller_id UUID,
    title TEXT,
    description TEXT,
    price DECIMAL(10, 2),
    currency VARCHAR(3),
    category TEXT,
    condition TEXT,
    images TEXT[],
    location_name TEXT,
    status TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    distance_nm DOUBLE PRECISION
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        l.id, l.seller_id, l.title, l.description, l.price, l.currency,
        l.category, l.condition, l.images, l.location_name, l.status,
        l.created_at, l.updated_at,
        -- Convert meters to nautical miles (1 NM = 1852 m)
        ST_Distance(
            l.location::geography,
            ST_SetSRID(ST_MakePoint(user_lon, user_lat), 4326)::geography
        ) / 1852.0 AS distance_nm
    FROM marketplace_listings l
    WHERE l.status = 'available'
      AND l.location IS NOT NULL
      AND ST_DWithin(
          l.location::geography,
          ST_SetSRID(ST_MakePoint(user_lon, user_lat), 4326)::geography,
          radius_nm * 1852.0  -- Convert NM to meters for ST_DWithin
      )
      AND (filter_category IS NULL OR l.category = filter_category)
    ORDER BY distance_nm ASC
    LIMIT result_limit;
END;
$$;

-- 5. Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_marketplace_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 6. STORAGE BUCKET — marketplace-images
-- ============================================================

-- Create the storage bucket (Supabase-managed via `storage.buckets`)
INSERT INTO storage.buckets (id, name, public)
VALUES ('marketplace-images', 'marketplace-images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: Public read access (images are public)
DROP POLICY IF EXISTS "Marketplace images are publicly readable" ON storage.objects;
CREATE POLICY "Marketplace images are publicly readable"
ON storage.objects FOR SELECT
USING (bucket_id = 'marketplace-images');

-- Storage RLS: Authenticated users can upload to their own folder
DROP POLICY IF EXISTS "Users can upload marketplace images" ON storage.objects;
CREATE POLICY "Users can upload marketplace images"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'marketplace-images'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Storage RLS: Users can update their own images
DROP POLICY IF EXISTS "Users can update own marketplace images" ON storage.objects;
CREATE POLICY "Users can update own marketplace images"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'marketplace-images'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Storage RLS: Users can delete their own images
DROP POLICY IF EXISTS "Users can delete own marketplace images" ON storage.objects;
CREATE POLICY "Users can delete own marketplace images"
ON storage.objects FOR DELETE
USING (
    bucket_id = 'marketplace-images'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================
-- 7. ESCROW TRANSACTIONS — Zero-Mediation PIN Handoff (6% fee)
-- ============================================================

CREATE TABLE IF NOT EXISTS marketplace_escrow (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    listing_id UUID REFERENCES marketplace_listings(id) ON DELETE CASCADE,
    buyer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    seller_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,           -- Total amount in cents
    platform_fee_cents INTEGER NOT NULL,     -- 6% platform fee in cents
    seller_payout_cents INTEGER NOT NULL,    -- 94% seller payout in cents
    currency VARCHAR(3) DEFAULT 'AUD',
    stripe_payment_intent_id TEXT,           -- Stripe PI ID (auth-only, not captured)
    stripe_transfer_id TEXT,                 -- Stripe Transfer to seller (after capture)

    -- Zero-Mediation PIN system
    escrow_pin TEXT NOT NULL,                -- Random 4-digit PIN (e.g. '4921')
    escrow_status TEXT DEFAULT 'awaiting_handoff' CHECK (escrow_status IN (
        'awaiting_handoff',  -- Hold placed, waiting for buyer to give PIN to seller
        'released',          -- PIN matched, payment captured → seller paid
        'expired',           -- 48h passed without handoff → hold auto-canceled
        'canceled'           -- Buyer manually canceled before handoff
    )),
    escrow_expires_at TIMESTAMPTZ NOT NULL,  -- 48 hours after hold creation

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── MIGRATION: upgrade old escrow schema to PIN-based schema ──
-- If table already existed with old 'status' column, migrate it.
-- These are all safe to re-run (IF EXISTS / IF NOT EXISTS).

-- Step A: Rename old 'status' column to 'escrow_status' if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'marketplace_escrow' AND column_name = 'status'
    ) THEN
        -- Drop old CHECK constraint (name may vary)
        ALTER TABLE marketplace_escrow DROP CONSTRAINT IF EXISTS marketplace_escrow_status_check;
        ALTER TABLE marketplace_escrow RENAME COLUMN status TO escrow_status;
    END IF;
END $$;

-- Step B: Add missing PIN columns if they don't exist
ALTER TABLE marketplace_escrow ADD COLUMN IF NOT EXISTS escrow_pin TEXT;
ALTER TABLE marketplace_escrow ADD COLUMN IF NOT EXISTS escrow_expires_at TIMESTAMPTZ;
ALTER TABLE marketplace_escrow ADD COLUMN IF NOT EXISTS escrow_status TEXT;

-- Step C: Set defaults for old rows that lack the new columns
UPDATE marketplace_escrow SET escrow_pin = '0000' WHERE escrow_pin IS NULL;
UPDATE marketplace_escrow SET escrow_expires_at = now() + interval '48 hours' WHERE escrow_expires_at IS NULL;
UPDATE marketplace_escrow SET escrow_status = 'expired' WHERE escrow_status IS NULL;

-- Step D: Now make escrow_pin NOT NULL (safe after backfill)
ALTER TABLE marketplace_escrow ALTER COLUMN escrow_pin SET NOT NULL;
ALTER TABLE marketplace_escrow ALTER COLUMN escrow_expires_at SET NOT NULL;

-- Step E: Add the new CHECK constraint if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'marketplace_escrow_escrow_status_check'
    ) THEN
        ALTER TABLE marketplace_escrow ADD CONSTRAINT marketplace_escrow_escrow_status_check
        CHECK (escrow_status IN ('awaiting_handoff', 'released', 'expired', 'canceled'));
    END IF;
END $$;

-- Step F: Set column defaults
ALTER TABLE marketplace_escrow ALTER COLUMN escrow_status SET DEFAULT 'awaiting_handoff';

CREATE INDEX IF NOT EXISTS escrow_expires_idx
ON marketplace_escrow (escrow_status, escrow_expires_at)
WHERE escrow_status = 'awaiting_handoff';

ALTER TABLE marketplace_escrow ENABLE ROW LEVEL SECURITY;

-- Buyers can see their own escrow (including PIN)
DROP POLICY IF EXISTS "Buyers can view own escrow with PIN" ON marketplace_escrow;
CREATE POLICY "Buyers can view own escrow with PIN"
ON marketplace_escrow FOR SELECT
USING (auth.uid() = buyer_id);

-- Sellers can see their own escrow but NOT the PIN
DROP POLICY IF EXISTS "Sellers can view own escrow" ON marketplace_escrow;
CREATE POLICY "Sellers can view own escrow"
ON marketplace_escrow FOR SELECT
USING (auth.uid() = seller_id);

-- Only the Edge Function (service role) can insert/update escrow rows
DROP POLICY IF EXISTS "Service role can manage escrow" ON marketplace_escrow;
CREATE POLICY "Service role can manage escrow"
ON marketplace_escrow FOR ALL
USING (auth.role() = 'service_role');

-- Seller view: strips the PIN column so sellers can't see it
CREATE OR REPLACE VIEW marketplace_escrow_seller AS
SELECT
    id, listing_id, buyer_id, seller_id,
    amount_cents, platform_fee_cents, seller_payout_cents, currency,
    stripe_payment_intent_id,
    escrow_status, escrow_expires_at,
    created_at, updated_at
    -- NOTE: escrow_pin is intentionally excluded
FROM marketplace_escrow;

-- ============================================================
-- 8. ESCROW PIN VERIFICATION RPC
-- ============================================================

-- Called by seller to verify buyer's PIN and trigger capture
CREATE OR REPLACE FUNCTION verify_escrow_pin(
    p_escrow_id UUID,
    p_pin TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER  -- Runs as superuser to read PIN
AS $$
DECLARE
    v_escrow marketplace_escrow%ROWTYPE;
BEGIN
    -- Fetch the escrow record
    SELECT * INTO v_escrow
    FROM marketplace_escrow
    WHERE id = p_escrow_id;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Escrow not found');
    END IF;

    -- Verify caller is the seller
    IF v_escrow.seller_id != auth.uid() THEN
        RETURN json_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Check escrow is still awaiting handoff
    IF v_escrow.escrow_status != 'awaiting_handoff' THEN
        RETURN json_build_object('success', false, 'error',
            'Escrow is no longer active (status: ' || v_escrow.escrow_status || ')');
    END IF;

    -- Check not expired
    IF v_escrow.escrow_expires_at < now() THEN
        UPDATE marketplace_escrow SET escrow_status = 'expired', updated_at = now()
        WHERE id = p_escrow_id;
        RETURN json_build_object('success', false, 'error', 'Escrow has expired');
    END IF;

    -- Verify PIN
    IF v_escrow.escrow_pin != p_pin THEN
        RETURN json_build_object('success', false, 'error', 'Invalid PIN');
    END IF;

    -- PIN matches! Return success with PI ID for Edge Function to capture
    RETURN json_build_object(
        'success', true,
        'payment_intent_id', v_escrow.stripe_payment_intent_id,
        'amount_cents', v_escrow.amount_cents,
        'platform_fee_cents', v_escrow.platform_fee_cents,
        'seller_payout_cents', v_escrow.seller_payout_cents,
        'escrow_id', v_escrow.id
    );
END;
$$;

-- ============================================================
-- 9. AUTO-EXPIRY SWEEP (pg_cron)
-- ============================================================

-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Sweep function: cancels expired holds
CREATE OR REPLACE FUNCTION sweep_expired_escrows()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE marketplace_escrow
    SET escrow_status = 'expired', updated_at = now()
    WHERE escrow_status = 'awaiting_handoff'
      AND escrow_expires_at < now();

    -- Also reset the listing status back to 'available'
    UPDATE marketplace_listings l
    SET status = 'available', updated_at = now()
    FROM marketplace_escrow e
    WHERE e.listing_id = l.id
      AND e.escrow_status = 'expired'
      AND l.status = 'pending';
END;
$$;

-- Schedule: run every 15 minutes
SELECT cron.schedule(
    'sweep-expired-escrows',
    '*/15 * * * *',
    $$SELECT sweep_expired_escrows()$$
);

-- Add stripe_account_id to profiles for Stripe Connect onboarding
ALTER TABLE chat_profiles
ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;

-- Auto-update trigger for escrow
DROP TRIGGER IF EXISTS marketplace_escrow_updated ON marketplace_escrow;
CREATE TRIGGER marketplace_escrow_updated
    BEFORE UPDATE ON marketplace_escrow
    FOR EACH ROW
    EXECUTE FUNCTION update_marketplace_timestamp();

-- Also make the listings trigger idempotent
DROP TRIGGER IF EXISTS marketplace_listings_updated ON marketplace_listings;
CREATE TRIGGER marketplace_listings_updated
    BEFORE UPDATE ON marketplace_listings
    FOR EACH ROW
    EXECUTE FUNCTION update_marketplace_timestamp();

-- ============================================================
-- 10. SEED MARKETPLACE CHANNEL
-- ============================================================
-- Insert the Marketplace channel into chat_channels if it doesn't exist.
-- This ensures it appears in Crew Talk even if channels were seeded
-- before this migration was run.

INSERT INTO chat_channels (name, description, icon, is_global, status)
SELECT 'Marketplace', 'Buy, sell, and trade gear, boats, and services', '🏪', true, 'active'
WHERE NOT EXISTS (
    SELECT 1 FROM chat_channels WHERE name = 'Marketplace'
);
