-- Auto routes on the phone with Thalassa's own router (2026-10-01): planned-only
-- proposals saved from it carry evidence origin 'thalassa-inshore'. Widen the
-- origin check only; size, version and the planned-only acknowledgement are
-- unchanged, and rows saved before today ('sevencs-trial') stay valid.
-- No ownership, RLS or activation changes. Until this is pushed the client
-- keeps such saves on the device ('schema-pending').
ALTER TABLE public.saved_routes
    DROP CONSTRAINT IF EXISTS saved_routes_proposal_evidence_bounded;
ALTER TABLE public.saved_routes
    ADD CONSTRAINT saved_routes_proposal_evidence_bounded CHECK (
        proposal_evidence IS NULL OR (
            jsonb_typeof(proposal_evidence) = 'object'
            -- Client evidence stays <=1 MiB compact JSON. JSONB text adds
            -- whitespace: 2 MiB is serialization headroom, not a client budget increase.
            AND octet_length(proposal_evidence::text) <= 2097152
            AND proposal_evidence->>'origin' IN ('sevencs-trial', 'thalassa-inshore')
            AND proposal_evidence->>'version' = '1'
            AND proposal_evidence->>'plannedOnlyAcknowledged' = 'true'
        ) IS TRUE
    );

COMMENT ON COLUMN public.saved_routes.proposal_evidence IS
    'Historical origin and local/router checks for a planned-only saved route: thalassa-inshore (Auto on the phone, from 2026-10-01) or sevencs-trial (earlier trial rows); never navigation verification or clearance. Raw licensed provider payloads and router internals are excluded.';
