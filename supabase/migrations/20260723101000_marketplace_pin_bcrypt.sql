-- Six-digit PINs have only 900,000 possibilities; a fast SHA digest can be
-- cracked offline. Hash all newly-created hand-off PINs with bcrypt and expire
-- any pre-launch active rows that used the legacy representation.

UPDATE public.marketplace_escrow
SET escrow_status = 'expired',
    updated_at = now()
WHERE escrow_status = 'awaiting_handoff'
  AND escrow_pin !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$';

CREATE OR REPLACE FUNCTION public.hash_marketplace_escrow_pin()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    IF NEW.escrow_pin ~ '^[0-9]{6}$' THEN
        NEW.escrow_pin := crypt(NEW.escrow_pin, gen_salt('bf', 12));
    ELSIF NEW.escrow_pin !~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' THEN
        RAISE EXCEPTION 'Escrow PIN must be a six-digit value';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hash_marketplace_escrow_pin
    ON public.marketplace_escrow;
CREATE TRIGGER trg_hash_marketplace_escrow_pin
    BEFORE INSERT OR UPDATE OF escrow_pin ON public.marketplace_escrow
    FOR EACH ROW EXECUTE FUNCTION public.hash_marketplace_escrow_pin();

CREATE OR REPLACE FUNCTION public.verify_escrow_pin(
    p_escrow_id UUID,
    p_pin TEXT
)
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
    IF NOT public.consume_edge_quota('escrow_pin', 30, 3600) THEN
        RETURN json_build_object(
            'success', false,
            'error', 'Too many attempts; try again later'
        );
    END IF;

    SELECT * INTO v_escrow
    FROM public.marketplace_escrow
    WHERE id = p_escrow_id
    FOR UPDATE;
    IF NOT FOUND OR v_escrow.seller_id <> auth.uid() THEN
        RETURN json_build_object('success', false, 'error', 'Escrow not found');
    END IF;
    IF v_escrow.escrow_status <> 'awaiting_handoff' THEN
        RETURN json_build_object(
            'success', false,
            'error', 'Escrow is no longer active'
        );
    END IF;
    IF v_escrow.escrow_expires_at < now() THEN
        UPDATE public.marketplace_escrow
        SET escrow_status = 'expired'
        WHERE id = p_escrow_id;
        RETURN json_build_object('success', false, 'error', 'Escrow has expired');
    END IF;
    IF v_escrow.pin_locked_until IS NOT NULL
       AND v_escrow.pin_locked_until > now() THEN
        RETURN json_build_object(
            'success', false,
            'error', 'Too many attempts; try again later'
        );
    END IF;
    IF crypt(p_pin, v_escrow.escrow_pin) <> v_escrow.escrow_pin THEN
        UPDATE public.marketplace_escrow
        SET pin_attempt_count = pin_attempt_count + 1,
            pin_locked_until = CASE
                WHEN pin_attempt_count + 1 >= 5
                    THEN now() + interval '15 minutes'
                ELSE NULL
            END
        WHERE id = p_escrow_id;
        RETURN json_build_object('success', false, 'error', 'Invalid PIN');
    END IF;

    UPDATE public.marketplace_escrow
    SET pin_attempt_count = 0,
        pin_locked_until = NULL
    WHERE id = p_escrow_id;
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
REVOKE ALL ON FUNCTION public.verify_escrow_pin(UUID, TEXT)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_escrow_pin(UUID, TEXT)
    TO authenticated;
