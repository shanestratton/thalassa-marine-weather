-- Marketplace stays server-disabled until explicitly launched. These changes
-- make its dormant database surface safe and repair message schema drift.

ALTER TABLE public.marketplace_listings
    ADD COLUMN IF NOT EXISTS boat_details JSONB,
    ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ;
ALTER TABLE public.marketplace_listings
    DROP CONSTRAINT IF EXISTS marketplace_listings_category_check;
ALTER TABLE public.marketplace_listings
    ADD CONSTRAINT marketplace_listings_category_check
    CHECK (category IN ('Boats', 'Outboards', 'Electronics', 'Sails', 'Rigging', 'Hardware', 'Safety', 'Misc'));

-- Exact PostGIS coordinates are needed for radius queries but should not be
-- downloadable from the base table by every signed-in user.
DROP POLICY IF EXISTS "Listings are viewable by everyone" ON public.marketplace_listings;
CREATE POLICY "Sellers read own listing records"
ON public.marketplace_listings FOR SELECT TO authenticated
USING (seller_id = auth.uid());

DROP VIEW IF EXISTS public.marketplace_listings_public;
CREATE VIEW public.marketplace_listings_public
WITH (security_barrier = true)
AS
SELECT id, seller_id, title, description, price, currency, category, condition,
       images, location_name, status, sold_at, created_at, updated_at, boat_details
FROM public.marketplace_listings
WHERE status = 'available'
   OR (status = 'sold' AND sold_at > now() - interval '48 hours');
REVOKE ALL ON public.marketplace_listings_public FROM PUBLIC, anon;
GRANT SELECT ON public.marketplace_listings_public TO authenticated;

ALTER TABLE public.marketplace_messages
    ALTER COLUMN channel_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS recipient_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS escrow_type TEXT,
    ADD COLUMN IF NOT EXISTS pin_code TEXT;

DROP POLICY IF EXISTS "Messages are viewable by everyone" ON public.marketplace_messages;
DROP POLICY IF EXISTS "Users can send messages" ON public.marketplace_messages;

CREATE POLICY "Marketplace participants read messages"
ON public.marketplace_messages FOR SELECT TO authenticated
USING (sender_id = auth.uid() OR recipient_id = auth.uid());

CREATE POLICY "Marketplace participants send messages"
ON public.marketplace_messages FOR INSERT TO authenticated
WITH CHECK (
    sender_id = auth.uid()
    AND recipient_id IS NOT NULL
    AND recipient_id <> auth.uid()
    AND NOT is_system
    AND escrow_type IS NULL
    AND pin_code IS NULL
    AND char_length(content) BETWEEN 1 AND 4000
    AND EXISTS (
        SELECT 1 FROM public.marketplace_listings l
        WHERE l.id = listing_id
          AND (
              (l.seller_id = recipient_id AND sender_id <> l.seller_id)
              OR l.seller_id = sender_id
          )
    )
);

ALTER TABLE public.marketplace_escrow
    ADD COLUMN IF NOT EXISTS pin_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;

-- The handoff PIN is a bearer secret. Retain the legacy column name for
-- compatibility but store only a SHA-256 digest in it.
UPDATE public.marketplace_escrow
SET escrow_pin = encode(extensions.digest(escrow_pin, 'sha256'), 'hex')
WHERE escrow_pin ~ '^[0-9]{4,6}$';

DROP POLICY IF EXISTS "Sellers can view own escrow" ON public.marketplace_escrow;
DROP POLICY IF EXISTS "Service role can manage escrow" ON public.marketplace_escrow;

-- The base table contains the buyer-only PIN. Sellers receive a safe projection.
DROP VIEW IF EXISTS public.marketplace_escrow_seller;
CREATE VIEW public.marketplace_escrow_seller
WITH (security_barrier = true)
AS
SELECT id, listing_id, buyer_id, seller_id, amount_cents, platform_fee_cents,
       seller_payout_cents, currency, escrow_status, escrow_expires_at,
       created_at, updated_at
FROM public.marketplace_escrow
WHERE seller_id = auth.uid();
REVOKE ALL ON public.marketplace_escrow_seller FROM PUBLIC, anon;
GRANT SELECT ON public.marketplace_escrow_seller TO authenticated;

CREATE OR REPLACE FUNCTION public.verify_escrow_pin(p_escrow_id UUID, p_pin TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_escrow public.marketplace_escrow%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL OR p_pin !~ '^[0-9]{6}$' THEN
        RETURN json_build_object('success', false, 'error', 'Invalid PIN');
    END IF;

    SELECT * INTO v_escrow FROM public.marketplace_escrow
    WHERE id = p_escrow_id FOR UPDATE;
    IF NOT FOUND OR v_escrow.seller_id <> auth.uid() THEN
        RETURN json_build_object('success', false, 'error', 'Escrow not found');
    END IF;
    IF v_escrow.escrow_status <> 'awaiting_handoff' THEN
        RETURN json_build_object('success', false, 'error', 'Escrow is no longer active');
    END IF;
    IF v_escrow.escrow_expires_at < now() THEN
        UPDATE public.marketplace_escrow SET escrow_status = 'expired' WHERE id = p_escrow_id;
        RETURN json_build_object('success', false, 'error', 'Escrow has expired');
    END IF;
    IF v_escrow.pin_locked_until IS NOT NULL AND v_escrow.pin_locked_until > now() THEN
        RETURN json_build_object('success', false, 'error', 'Too many attempts; try again later');
    END IF;
    IF v_escrow.escrow_pin <> encode(digest(p_pin, 'sha256'), 'hex') THEN
        UPDATE public.marketplace_escrow
        SET pin_attempt_count = pin_attempt_count + 1,
            pin_locked_until = CASE WHEN pin_attempt_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
        WHERE id = p_escrow_id;
        RETURN json_build_object('success', false, 'error', 'Invalid PIN');
    END IF;

    UPDATE public.marketplace_escrow SET pin_attempt_count = 0, pin_locked_until = NULL WHERE id = p_escrow_id;
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
REVOKE ALL ON FUNCTION public.verify_escrow_pin(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_escrow_pin(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_listings_within_radius(
    user_lat DOUBLE PRECISION,
    user_lon DOUBLE PRECISION,
    radius_nm DOUBLE PRECISION DEFAULT 50,
    filter_category TEXT DEFAULT NULL,
    result_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    id UUID, seller_id UUID, title TEXT, description TEXT, price DECIMAL(10, 2),
    currency VARCHAR(3), category TEXT, condition TEXT, images TEXT[], location_name TEXT,
    status TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, distance_nm DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL OR user_lat NOT BETWEEN -90 AND 90 OR user_lon NOT BETWEEN -180 AND 180 THEN
        RAISE EXCEPTION 'Authentication and valid coordinates required';
    END IF;
    RETURN QUERY
    SELECT l.id, l.seller_id, l.title, l.description, l.price, l.currency,
           l.category, l.condition, l.images, l.location_name, l.status,
           l.created_at, l.updated_at,
           extensions.ST_Distance(l.location::extensions.geography,
               extensions.ST_SetSRID(extensions.ST_MakePoint(user_lon, user_lat), 4326)::extensions.geography) / 1852.0
    FROM public.marketplace_listings l
    WHERE l.status = 'available' AND l.location IS NOT NULL
      AND extensions.ST_DWithin(l.location::extensions.geography,
          extensions.ST_SetSRID(extensions.ST_MakePoint(user_lon, user_lat), 4326)::extensions.geography,
          LEAST(GREATEST(radius_nm, 1), 200) * 1852.0)
      AND (filter_category IS NULL OR l.category = filter_category)
    ORDER BY extensions.ST_Distance(
        l.location::extensions.geography,
        extensions.ST_SetSRID(extensions.ST_MakePoint(user_lon, user_lat), 4326)::extensions.geography
    ) ASC
    LIMIT LEAST(GREATEST(result_limit, 1), 100);
END;
$$;
REVOKE ALL ON FUNCTION public.get_listings_within_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_listings_within_radius(DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, INTEGER) TO authenticated;
