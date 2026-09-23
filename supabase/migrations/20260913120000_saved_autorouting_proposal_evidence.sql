-- Private planned-only proposal evidence. No ownership, RLS or activation changes.
-- Deploy separately; clients retain full local evidence if this column is absent.
ALTER TABLE public.saved_routes
    ADD COLUMN IF NOT EXISTS proposal_evidence jsonb;

ALTER TABLE public.saved_routes
    DROP CONSTRAINT IF EXISTS saved_routes_points_sane;
ALTER TABLE public.saved_routes
    ADD CONSTRAINT saved_routes_points_sane CHECK (
        jsonb_typeof(points) = 'array' AND jsonb_array_length(points) BETWEEN 2 AND 10000
    );

ALTER TABLE public.saved_routes
    ADD CONSTRAINT saved_routes_proposal_evidence_bounded CHECK (
        proposal_evidence IS NULL OR (
            jsonb_typeof(proposal_evidence) = 'object'
            -- Client evidence stays <=1 MiB compact JSON. JSONB text adds
            -- whitespace: 2 MiB is serialization headroom, not a client budget increase.
            AND octet_length(proposal_evidence::text) <= 2097152
            AND proposal_evidence->>'origin' = 'sevencs-trial'
            AND proposal_evidence->>'version' = '1'
            AND proposal_evidence->>'plannedOnlyAcknowledged' = 'true'
        ) IS TRUE
    );

COMMENT ON COLUMN public.saved_routes.proposal_evidence IS
    'Historical SevenCs trial origin and local/provider checks for a planned-only saved route; never navigation verification or clearance. Raw licensed provider payloads are excluded.';
