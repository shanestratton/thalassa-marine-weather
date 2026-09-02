-- Public AIS: the skipper's own switch for republishing nearby traffic.
--
-- AIS targets returned to the public voyage page are OTHER boats' positions,
-- reaching anyone who has the link. Whether to publish them is a decision only
-- the skipper can make — and, with AISHub's licence position on re-publishing
-- the aggregate still unconfirmed (their 2026-03-18 permission covers FEEDING
-- them, not redistribution), it needs to be answerable in one tap rather than
-- a redeploy.
--
-- Defaults TRUE because that is the state Shane asked for on 2026-09-02 ("we
-- might just as well let the punters at home see whats around us") and the
-- state already live; the column exists so it can be turned off instantly.
--
-- Enforced SERVER-SIDE in supabase/functions/voyage-log: switching it off must
-- drop the WORK (the vessels_nearby RPC and its metadata follow-up), not merely
-- hide the markers — the same reasoning that parked the feature in July.

ALTER TABLE public.voyage_log_configs
    ADD COLUMN IF NOT EXISTS public_ais_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.voyage_log_configs.public_ais_enabled IS
    'Publish nearby AIS traffic on this vessel''s public page. Off drops the lookup entirely.';
