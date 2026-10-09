-- New voyage-log handles use the intended slug rule (2026-10-10, build 126,
-- package 126-19, live drift finding B-12 = C3).
--
-- Not pushed with this commit: it goes in the 126 release push.
--
-- Why
-- ───
-- 20260517100000_slugify_glue_trailing_numbers.sql changed slugify so a
-- trailing number or short roman numeral glues to the word before it
-- ("Serenity 3" → serenity3), because the old rule's serenity-3 collides with
-- the auto-suffix voyage_log_set_handle gives the third "Serenity", pushing
-- the second arrival to serenity-3-2. Live records it as applied, but the
-- read-only drift scan of 2026-10-10 found live's slugify('Serenity 3') still
-- returning serenity-3. Only new handles are affected, and only cosmetically
-- (the public page URL).
--
-- What
-- ────
-- slugify re-created verbatim from 20260517100000 (same signature, body,
-- language and volatility), and that file's seven examples as the
-- self-check. Existing handles are untouched: nothing is rewritten, so every
-- public URL already handed out keeps working.
--
-- Undo
-- ────
-- Re-create slugify from 20260514120000_voyage_log.sql (the old rule).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.slugify(input TEXT)
RETURNS TEXT AS $$
    WITH lowered AS (
        SELECT lower(coalesce(input, '')) AS s
    ),
    -- Glue trailing digits / short romans to the prior word.
    glued AS (
        SELECT regexp_replace(
            s,
            '([a-z])\s+(\d+|i{1,3}|i?v|vi{1,3}|i?x|xi{1,3})$',
            '\1\2',
            'g'
        ) AS s
        FROM lowered
    )
    SELECT trim(both '-' from regexp_replace(s, '[^a-z0-9]+', '-', 'g'))
    FROM glued;
$$ LANGUAGE sql IMMUTABLE;

DO $check$
DECLARE
    pair TEXT[];
BEGIN
    FOREACH pair SLICE 1 IN ARRAY ARRAY[
        ARRAY['Serenity', 'serenity'],
        ARRAY['Serenity 3', 'serenity3'],
        ARRAY['Serenity II', 'serenityii'],
        ARRAY['Salty Dog', 'salty-dog'],
        ARRAY['Lucky Number 7', 'lucky-number7'],
        ARRAY['Lucky 7 Boat', 'lucky-7-boat'],
        ARRAY['S/V Wanderer', 's-v-wanderer']
    ] LOOP
        IF public.slugify(pair[1]) IS DISTINCT FROM pair[2] THEN
            RAISE EXCEPTION 'slugify_trailing_numbers_repair: slugify(%) = %, expected %', pair[1], public.slugify(pair[1]), pair[2];
        END IF;
    END LOOP;
END;
$check$;

RESET lock_timeout;
