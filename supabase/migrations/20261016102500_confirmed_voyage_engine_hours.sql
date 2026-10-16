-- Build136: explicit confirmation only. Owner+voyage is the durable receipt,
-- shared across phones. Lock the existing hour-meter row before the receipt or
-- carry row, so concurrent confirmations serialize in the same order.
-- Fractional logged hours are carried as seconds; the existing whole-hour
-- maintenance reading and old apps keep their established format.
CREATE TABLE IF NOT EXISTS public.voyage_engine_hours_receipts (
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    voyage_id TEXT NOT NULL CHECK (length(voyage_id) BETWEEN 1 AND 200),
    seconds INTEGER NOT NULL CHECK (seconds BETWEEN 1 AND 31622400),
    source TEXT NOT NULL CHECK (source IN ('log', 'rpm', 'mixed')),
    hours_after INTEGER NOT NULL CHECK (hours_after BETWEEN 0 AND 999999),
    remainder_seconds INTEGER NOT NULL CHECK (remainder_seconds BETWEEN 0 AND 3599),
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, voyage_id)
);
CREATE TABLE IF NOT EXISTS public.voyage_engine_hours_carry (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    reading_hours INTEGER NOT NULL CHECK (reading_hours BETWEEN 0 AND 999999),
    seconds INTEGER NOT NULL CHECK (seconds BETWEEN 0 AND 3599)
);
ALTER TABLE public.voyage_engine_hours_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voyage_engine_hours_carry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.voyage_engine_hours_receipts, public.voyage_engine_hours_carry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.voyage_engine_hours_receipts, public.voyage_engine_hours_carry TO authenticated;
CREATE POLICY "Owners read their confirmed voyage hours" ON public.voyage_engine_hours_receipts
    FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Owners read their partial engine hour" ON public.voyage_engine_hours_carry
    FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.confirm_voyage_engine_hours(
    p_voyage_id TEXT,
    p_seconds INTEGER,
    p_source TEXT,
    p_expected_hours INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
    owner_id UUID := auth.uid();
    current_hours INTEGER;
    carry_hours INTEGER;
    carry_seconds INTEGER := 0;
    total_seconds BIGINT;
    next_hours INTEGER;
    next_remainder INTEGER;
    receipt public.voyage_engine_hours_receipts%ROWTYPE;
BEGIN
    IF owner_id IS NULL THEN RAISE EXCEPTION 'Sign in to confirm engine hours' USING ERRCODE = '42501'; END IF;
    IF p_voyage_id IS NULL OR length(p_voyage_id) NOT BETWEEN 1 AND 200
       OR p_voyage_id !~ '^[A-Za-z0-9_-]+$'
       OR p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 31622400
       OR p_source IS NULL OR p_source NOT IN ('log', 'rpm', 'mixed')
       OR p_expected_hours IS NULL OR p_expected_hours NOT BETWEEN 0 AND 999999
    THEN RAISE EXCEPTION 'Invalid confirmed engine-hours entry' USING ERRCODE = '22023'; END IF;

    -- The client may change only its own reading. A shared crew binder is not
    -- an authority to add a different boat's voyage to the skipper's meter.
    SELECT hours INTO current_hours FROM public.vessel_engine_hours
        WHERE user_id = owner_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Set the engine hour-meter reading first' USING ERRCODE = '22023'; END IF;

    SELECT * INTO receipt FROM public.voyage_engine_hours_receipts
        WHERE user_id = owner_id AND voyage_id = p_voyage_id;
    IF FOUND THEN
        IF receipt.seconds <> p_seconds OR receipt.source <> p_source THEN
            RAISE EXCEPTION 'This voyage already has a different confirmed engine-hours entry' USING ERRCODE = '22023';
        END IF;
        RETURN jsonb_build_object('applied', false, 'hours', current_hours,
            'hoursAfterConfirmation', receipt.hours_after, 'remainderSeconds', receipt.remainder_seconds);
    END IF;
    IF current_hours <> p_expected_hours THEN
        RAISE EXCEPTION 'Engine hours changed on another device; review the current reading' USING ERRCODE = '40001';
    END IF;

    -- A later manual meter edit supersedes the old fractional estimate.
    SELECT reading_hours, seconds INTO carry_hours, carry_seconds
        FROM public.voyage_engine_hours_carry WHERE user_id = owner_id;
    IF NOT FOUND OR carry_hours <> current_hours THEN carry_seconds := 0; END IF;
    total_seconds := carry_seconds::bigint + p_seconds;
    next_hours := current_hours + (total_seconds / 3600)::integer;
    next_remainder := (total_seconds % 3600)::integer;
    IF next_hours > 999999 THEN RAISE EXCEPTION 'Engine-hour reading is out of range' USING ERRCODE = '22023'; END IF;

    UPDATE public.vessel_engine_hours SET hours = next_hours WHERE user_id = owner_id;
    INSERT INTO public.voyage_engine_hours_carry(user_id, reading_hours, seconds)
        VALUES(owner_id, next_hours, next_remainder)
        ON CONFLICT(user_id) DO UPDATE SET reading_hours = EXCLUDED.reading_hours, seconds = EXCLUDED.seconds;
    INSERT INTO public.voyage_engine_hours_receipts(user_id, voyage_id, seconds, source, hours_after, remainder_seconds)
        VALUES(owner_id, p_voyage_id, p_seconds, p_source, next_hours, next_remainder);
    RETURN jsonb_build_object('applied', true, 'hours', next_hours,
        'hoursAfterConfirmation', next_hours, 'remainderSeconds', next_remainder);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_voyage_engine_hours(TEXT, INTEGER, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_voyage_engine_hours(TEXT, INTEGER, TEXT, INTEGER) TO authenticated;
