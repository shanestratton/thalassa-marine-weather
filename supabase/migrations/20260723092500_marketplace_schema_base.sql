-- Canonical marketplace foundation.
--
-- The original marketplace_migration.sql was a dashboard-run prototype and is
-- intentionally not replayed: it exposed all chat messages, stored hand-off
-- PINs in plaintext, and installed a non-idempotent cron job. This migration
-- provides only the schema and least-privilege baseline needed by the hardened
-- migrations that follow.

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.marketplace_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
    description TEXT CHECK (description IS NULL OR char_length(description) <= 5000),
    price DECIMAL(10, 2) NOT NULL CHECK (price BETWEEN 1 AND 100000),
    currency VARCHAR(3) NOT NULL DEFAULT 'AUD'
        CHECK (currency IN ('AUD', 'NZD', 'USD')),
    category TEXT NOT NULL CHECK (category IN (
        'Electronics', 'Sails', 'Rigging', 'Hardware', 'Safety', 'Misc'
    )),
    condition TEXT NOT NULL CHECK (condition IN (
        'New', 'Like New', 'Used - Good', 'Used - Fair', 'Needs Repair'
    )),
    images TEXT[] NOT NULL DEFAULT '{}',
    location extensions.geometry(Point, 4326),
    location_name TEXT CHECK (location_name IS NULL OR char_length(location_name) <= 200),
    status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'pending', 'sold')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listings_geo_index
    ON public.marketplace_listings USING GIST (location);
CREATE INDEX IF NOT EXISTS listings_category_status_idx
    ON public.marketplace_listings(category, status, created_at DESC);
CREATE INDEX IF NOT EXISTS listings_seller_idx
    ON public.marketplace_listings(seller_id);

CREATE TABLE IF NOT EXISTS public.marketplace_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id TEXT,
    listing_id UUID NOT NULL
        REFERENCES public.marketplace_listings(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    message_type TEXT NOT NULL DEFAULT 'text'
        CHECK (message_type IN ('text', 'listing_card')),
    content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_msgs_channel_idx
    ON public.marketplace_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_msgs_listing_idx
    ON public.marketplace_messages(listing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.marketplace_escrow (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL
        REFERENCES public.marketplace_listings(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 100 AND 10000000),
    platform_fee_cents INTEGER NOT NULL CHECK (platform_fee_cents >= 0),
    seller_payout_cents INTEGER NOT NULL CHECK (seller_payout_cents >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'AUD'
        CHECK (currency IN ('AUD', 'NZD', 'USD')),
    stripe_payment_intent_id TEXT,
    stripe_transfer_id TEXT,
    -- This column is retained for client compatibility but stores a digest,
    -- never a recoverable PIN. A later migration upgrades it to bcrypt.
    escrow_pin TEXT NOT NULL,
    escrow_status TEXT NOT NULL DEFAULT 'awaiting_handoff'
        CHECK (escrow_status IN (
            'awaiting_handoff', 'released', 'expired', 'canceled'
        )),
    escrow_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (buyer_id <> seller_id),
    CHECK (platform_fee_cents + seller_payout_cents = amount_cents)
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_escrow_active_listing_idx
    ON public.marketplace_escrow(listing_id)
    WHERE escrow_status = 'awaiting_handoff';
CREATE INDEX IF NOT EXISTS escrow_expires_idx
    ON public.marketplace_escrow(escrow_status, escrow_expires_at)
    WHERE escrow_status = 'awaiting_handoff';
CREATE INDEX IF NOT EXISTS marketplace_escrow_buyer_idx
    ON public.marketplace_escrow(buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_escrow_seller_idx
    ON public.marketplace_escrow(seller_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.update_marketplace_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marketplace_listings_updated
    ON public.marketplace_listings;
CREATE TRIGGER marketplace_listings_updated
    BEFORE UPDATE ON public.marketplace_listings
    FOR EACH ROW EXECUTE FUNCTION public.update_marketplace_timestamp();

DROP TRIGGER IF EXISTS marketplace_escrow_updated
    ON public.marketplace_escrow;
CREATE TRIGGER marketplace_escrow_updated
    BEFORE UPDATE ON public.marketplace_escrow
    FOR EACH ROW EXECUTE FUNCTION public.update_marketplace_timestamp();

ALTER TABLE public.marketplace_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketplace_escrow ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can create listings" ON public.marketplace_listings;
DROP POLICY IF EXISTS "Users can update own listings" ON public.marketplace_listings;
DROP POLICY IF EXISTS "Users can delete own listings" ON public.marketplace_listings;
CREATE POLICY "Users can create listings"
    ON public.marketplace_listings FOR INSERT TO authenticated
    WITH CHECK (seller_id = auth.uid());
CREATE POLICY "Users can update own listings"
    ON public.marketplace_listings FOR UPDATE TO authenticated
    USING (seller_id = auth.uid())
    WITH CHECK (seller_id = auth.uid());
CREATE POLICY "Users can delete own listings"
    ON public.marketplace_listings FOR DELETE TO authenticated
    USING (seller_id = auth.uid());

-- The next migration replaces these read/message policies with safe views and
-- participant-only access. They are secure defaults if replay stops here.
CREATE POLICY "Listings are viewable by everyone"
    ON public.marketplace_listings FOR SELECT TO authenticated
    USING (seller_id = auth.uid());
CREATE POLICY "Messages are viewable by everyone"
    ON public.marketplace_messages FOR SELECT TO authenticated
    USING (sender_id = auth.uid());
CREATE POLICY "Users can send messages"
    ON public.marketplace_messages FOR INSERT TO authenticated
    WITH CHECK (
        sender_id = auth.uid()
        AND char_length(content) BETWEEN 1 AND 4000
    );
CREATE POLICY "Buyers read own escrow"
    ON public.marketplace_escrow FOR SELECT TO authenticated
    USING (buyer_id = auth.uid());

INSERT INTO storage.buckets(id, name, public)
VALUES ('marketplace-images', 'marketplace-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS "Marketplace images are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload marketplace images" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own marketplace images" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own marketplace images" ON storage.objects;
CREATE POLICY "Marketplace images are publicly readable"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'marketplace-images');
CREATE POLICY "Users can upload marketplace images"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'marketplace-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );
CREATE POLICY "Users can update own marketplace images"
    ON storage.objects FOR UPDATE TO authenticated
    USING (
        bucket_id = 'marketplace-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
    )
    WITH CHECK (
        bucket_id = 'marketplace-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );
CREATE POLICY "Users can delete own marketplace images"
    ON storage.objects FOR DELETE TO authenticated
    USING (
        bucket_id = 'marketplace-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

ALTER TABLE public.chat_profiles
    ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
