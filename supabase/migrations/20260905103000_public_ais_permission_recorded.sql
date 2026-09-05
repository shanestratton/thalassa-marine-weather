-- The redistribution permission exists. The record said it did not.
--
-- 20260902120000_public_ais_toggle.sql was written the same day Shane asked
-- for the toggle, and its header records AISHub's position on republishing
-- the aggregate as "still unconfirmed". Later that day Desimir (AISHub) gave
-- written permission for public display of the aggregate — credit appreciated,
-- not required. The column comment inherited the stale wording, and an
-- external audit on 2026-09-05 read it and recommended defaulting the feature
-- off "until written rights exist". They exist. The default stands.
--
-- Applied migrations are not edited, so the correction lives here, on the
-- object the audit actually read.

COMMENT ON COLUMN public.voyage_log_configs.public_ais_enabled IS
    'Publish nearby AIS traffic on this vessel''s public page. Off drops the lookup entirely. '
    'Redistribution of the AISHub aggregate for public display was permitted in writing by AISHub '
    '(Desimir) on 2026-09-02; attribution appreciated, not required. Default TRUE is deliberate.';
