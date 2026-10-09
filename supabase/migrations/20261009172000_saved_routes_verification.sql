-- Route checks that stick (build 125, package 125-07).
--
-- A route check (the verification envelope: this exact geometry, graded at
-- this keel against this chart library) lived only on the phone that made it.
-- A reinstall, a second phone or the 50-route library cap brought a checked
-- passage back unchecked; Shane's three Newport → Whitsundays legs went yellow
-- on 2026-10-08. Build 124 recovers passage legs from their voyages.notes
-- copy; this column carries the check for every saved route.
--
-- The check itself stays a device check: the server only stores the result.
-- Every reader re-validates it against the row's own points (a check for
-- other pins is ignored) and the device's own draft and chart rules.
--
-- Additive and nullable: existing rows stay NULL (no backfill; devices push
-- the checks they hold). Ownership is unchanged: the row's own policy
-- (saved_routes_own) already scopes it to its owner. The client probes for
-- this column and writes it only after it has seen it, so the app behaves
-- exactly as build 124 did until this migration is pushed.

ALTER TABLE public.saved_routes
    ADD COLUMN IF NOT EXISTS verification jsonb;

ALTER TABLE public.saved_routes
    DROP CONSTRAINT IF EXISTS saved_routes_verification_bounded;
ALTER TABLE public.saved_routes
    ADD CONSTRAINT saved_routes_verification_bounded CHECK (
        verification IS NULL OR (
            jsonb_typeof(verification) = 'object'
            AND verification->>'version' = '1'
            -- A 10,000-pin route's envelope is ~300 KB compact (~380 KB at
            -- worst, every leg acknowledged); the client never writes more
            -- than 400,000 characters compact, ~420 KB as jsonb text.
            AND octet_length(verification::text) <= 524288
        ) IS TRUE
    );

COMMENT ON COLUMN public.saved_routes.verification IS
    'Route check for this exact geometry (version 1 envelope: geometry key, per-leg grades, acknowledged legs, draft, chart fingerprint, checkedAt). Device-made; every reader re-validates it against the row points.';
