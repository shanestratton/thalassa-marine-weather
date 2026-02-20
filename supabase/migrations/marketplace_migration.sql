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
CREATE POLICY "Listings are viewable by everyone"
ON marketplace_listings FOR SELECT
USING (auth.role() = 'authenticated');

-- Listings: users can only insert their own
CREATE POLICY "Users can create listings"
ON marketplace_listings FOR INSERT
WITH CHECK (auth.uid() = seller_id);

-- Listings: users can only update their own
CREATE POLICY "Users can update own listings"
ON marketplace_listings FOR UPDATE
USING (auth.uid() = seller_id);

-- Listings: users can only delete their own
CREATE POLICY "Users can delete own listings"
ON marketplace_listings FOR DELETE
USING (auth.uid() = seller_id);

-- Messages: anyone authenticated can read
CREATE POLICY "Messages are viewable by everyone"
ON marketplace_messages FOR SELECT
USING (auth.role() = 'authenticated');

-- Messages: users can send their own
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

CREATE TRIGGER marketplace_listings_updated
    BEFORE UPDATE ON marketplace_listings
    FOR EACH ROW
    EXECUTE FUNCTION update_marketplace_timestamp();

-- ============================================================
-- 6. STORAGE BUCKET — marketplace-images
-- ============================================================

-- Create the storage bucket (Supabase-managed via `storage.buckets`)
INSERT INTO storage.buckets (id, name, public)
VALUES ('marketplace-images', 'marketplace-images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: Public read access (images are public)
CREATE POLICY "Marketplace images are publicly readable"
ON storage.objects FOR SELECT
USING (bucket_id = 'marketplace-images');

-- Storage RLS: Authenticated users can upload to their own folder
CREATE POLICY "Users can upload marketplace images"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'marketplace-images'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Storage RLS: Users can update their own images
CREATE POLICY "Users can update own marketplace images"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'marketplace-images'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Storage RLS: Users can delete their own images
CREATE POLICY "Users can delete own marketplace images"
ON storage.objects FOR DELETE
USING (
    bucket_id = 'marketplace-images'
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================
-- 7. ESCROW TRANSACTIONS — Stripe Connect (6% platform fee)
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
    stripe_payment_intent_id TEXT,           -- Stripe PI ID
    stripe_transfer_id TEXT,                 -- Stripe Transfer to seller
    status TEXT DEFAULT 'pending' CHECK (status IN (
        'pending',       -- Payment Intent created, awaiting payment
        'paid',          -- Payment captured, funds held in escrow
        'released',      -- Funds released to seller
        'refunded',      -- Buyer refunded
        'disputed'       -- Payment disputed
    )),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE marketplace_escrow ENABLE ROW LEVEL SECURITY;

-- Buyers and sellers can view their own escrow transactions
CREATE POLICY "Users can view own escrow"
ON marketplace_escrow FOR SELECT
USING (auth.uid() = buyer_id OR auth.uid() = seller_id);

-- Only the Edge Function (service role) inserts escrow rows
-- Authenticated users cannot insert directly
CREATE POLICY "Service role can manage escrow"
ON marketplace_escrow FOR ALL
USING (auth.role() = 'service_role');

-- Add stripe_account_id to profiles for Stripe Connect onboarding
-- (sellers need a connected Stripe account to receive payouts)
ALTER TABLE chat_profiles
ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;

-- Auto-update trigger for escrow
CREATE TRIGGER marketplace_escrow_updated
    BEFORE UPDATE ON marketplace_escrow
    FOR EACH ROW
    EXECUTE FUNCTION update_marketplace_timestamp();
