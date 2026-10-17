-- HELD: review/apply before deploying the 139-06 anchor-relay source.
-- Owner JWT + relay/session ownership remain the existing authorisation boundary.
-- The service validates canonical geometry; SQL bounds the envelope and opaque revision.
ALTER TABLE public.pi_anchor_sessions
    ADD COLUMN IF NOT EXISTS safe_area jsonb,
    ADD COLUMN IF NOT EXISTS safe_area_revision text,
    ADD COLUMN IF NOT EXISTS safe_area_vessel_id text;

ALTER TABLE public.pi_anchor_sessions
    ADD CONSTRAINT pi_anchor_safe_area_envelope_v1 CHECK (
        safe_area IS NULL OR (
            jsonb_typeof(safe_area) = 'object'
            AND safe_area ?& ARRAY['version','frame','zone']
            AND (safe_area - ARRAY['version','frame','zone']) = '{}'::jsonb
            AND jsonb_typeof(safe_area -> 'version') = 'number'
            AND safe_area ->> 'version' = '1'
            AND jsonb_typeof(safe_area -> 'frame') = 'object'
            AND jsonb_typeof(safe_area -> 'zone') IN ('object','null')
            AND octet_length(safe_area::text) <= 8192
            AND safe_area_revision IS NOT NULL
        )
    ),
    ADD CONSTRAINT pi_anchor_safe_area_revision_uuid CHECK (
        safe_area_revision IS NULL OR safe_area_revision ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
    ADD CONSTRAINT pi_anchor_safe_area_vessel_length CHECK (
        safe_area_vessel_id IS NULL OR length(safe_area_vessel_id) BETWEEN 1 AND 128
    );
COMMENT ON COLUMN public.pi_anchor_sessions.safe_area IS
    'Owner-authorised manual boundary or explicit circle with exact frame; canonical parser validates every read. SQL null is the legacy circle protocol.';
COMMENT ON COLUMN public.pi_anchor_sessions.safe_area_revision IS
    'Owner-issued watch/edit UUID echoed by the Pi; stale reports cannot renew a different boundary.';
COMMENT ON COLUMN public.pi_anchor_sessions.safe_area_vessel_id IS
    'Selected vessel identifier for the owner-authorised boundary; null is an explicit watch without a selected fleet vessel.';
