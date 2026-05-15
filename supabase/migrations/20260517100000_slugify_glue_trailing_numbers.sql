-- ═══════════════════════════════════════════════════════════════
-- Slugify fix: glue trailing numbers/roman numerals to the prior
-- word so "Serenity 3" → `serenity3` instead of `serenity-3`.
--
-- Why this matters: `voyage_log_set_handle` already auto-suffixes
-- collisions as `<base>-2`, `<base>-3`, … The OLD slugify rule
-- produced `serenity-3` for BOTH:
--   • the third user named "Serenity" (auto-suffix)
--   • the first user named "Serenity 3" (literal number in name)
-- which guaranteed a collision the moment both exist. The UNIQUE
-- constraint on `handle` then forces the second arriver into
-- `serenity-3-2`, which is hideous AND surprises the punter whose
-- vessel is literally called "Serenity 3".
--
-- New rule: a trailing pure-digit or recognized-roman-numeral token
-- glues to the prior word with no hyphen. Everything else slugs
-- the old way. Examples:
--   "Serenity"        → serenity        (unchanged)
--   "Serenity 3"      → serenity3
--   "Serenity II"     → serenityii
--   "Salty Dog"       → salty-dog       (unchanged)
--   "Lucky Number 7"  → lucky-number7
--   "Lucky 7 Boat"    → lucky-7-boat    (number not trailing, untouched)
--   "S/V Wanderer"    → s-v-wanderer    (unchanged)
--
-- Roman alternation is strict — `i{1,3}|i?v|vi{1,3}|i?x|xi{1,3}`
-- covers I–XIII — to avoid matching ordinary words like "dog" or
-- "civic" that happen to contain roman-numeral letters.
--
-- Existing rows are not rewritten. Handles already minted stay
-- the way they were minted (we promised punters their URL); this
-- is forward-looking for new inserts.
-- ═══════════════════════════════════════════════════════════════

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

-- ── Self-check (visible in psql, harmless in production) ───────
-- SELECT
--     public.slugify('Serenity')        AS s1,   -- 'serenity'
--     public.slugify('Serenity 3')      AS s2,   -- 'serenity3'
--     public.slugify('Serenity II')     AS s3,   -- 'serenityii'
--     public.slugify('Salty Dog')       AS s4,   -- 'salty-dog'
--     public.slugify('Lucky Number 7')  AS s5,   -- 'lucky-number7'
--     public.slugify('Lucky 7 Boat')    AS s6,   -- 'lucky-7-boat'
--     public.slugify('S/V Wanderer')    AS s7;   -- 's-v-wanderer'
