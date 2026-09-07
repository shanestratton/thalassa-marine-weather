-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Thalassa — the Instrument Panel is invite-only                              ║
-- ║  Shane 2026-09-07: "we need to make that invite only. so when we invite a    ║
-- ║  crew member, we need a toggle that says share instrument panel."            ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝
--
-- The switch lives on the crew row: vessel_crew.permissions.can_view_instruments
-- (and 'instruments' in shared_registers, like every other register). Off by
-- default, set at invite time, changeable per crew member afterwards from the
-- Crew page. The live snapshot's read policy checks it: an accepted invite on
-- its own no longer shows the boat's instruments, and boat_members no longer
-- grants the read at all — it mirrors accepted crew and cannot carry the switch.
-- The skipper's own read (20260906170000, vessel_telemetry_owner_reads) is
-- untouched.

-- 1. The permission exists on every row, false unless the skipper ticks it.
ALTER TABLE public.vessel_crew
    ALTER COLUMN permissions SET DEFAULT '{
        "can_view_stores": false,
        "can_edit_stores": false,
        "can_view_galley": false,
        "can_view_nav": false,
        "can_view_weather": false,
        "can_edit_log": false,
        "can_view_instruments": false,
        "can_view_passage": false,
        "can_view_passage_meals": false,
        "can_view_passage_chat": false,
        "can_view_passage_route": false,
        "can_view_passage_checklist": false
    }'::jsonb;

UPDATE public.vessel_crew
   SET permissions = permissions || '{"can_view_instruments": false}'::jsonb
 WHERE NOT (permissions ? 'can_view_instruments');

-- 2. Crew read the boat's live snapshot only when the skipper shared it.
DROP POLICY IF EXISTS vessel_telemetry_crew_reads ON public.vessel_telemetry;
CREATE POLICY vessel_telemetry_crew_reads
    ON public.vessel_telemetry FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
              FROM public.vessel_crew AS membership
             WHERE membership.owner_id = vessel_telemetry.owner_id
               AND membership.crew_user_id = auth.uid()
               AND membership.status = 'accepted'
               AND COALESCE((membership.permissions ->> 'can_view_instruments')::boolean, false)
        )
    );

COMMENT ON POLICY vessel_telemetry_crew_reads ON public.vessel_telemetry IS
    'Crew see the live Instrument Panel only when the skipper ticked Share Instrument Panel on their invite (permissions.can_view_instruments). 2026-09-07.';
