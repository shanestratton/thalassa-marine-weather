-- Cast Off gates become advisory (Shane 2026-08-26: "can we start by
-- allowing it through first, then we will put the gates on").
--
-- The 2026-08-05 trigger re-verified the whole trace envelope under the
-- cast-off row lock — including a 60-second departure-time equality that a
-- skipper standing at the dock with a checked route could not satisfy. The
-- client side was progressively fixed (route-scoped fingerprints, inherited
-- recheck departures, tide-gated 30-minute tolerance) but this trigger kept
-- enforcing the original contract and threw first, so every fix appeared to
-- "not land".
--
-- Routing safety now lives in the app as visible advisories: the client
-- still computes traceCastOffBlockReason at Cast Off and shows it as an
-- inline heads-up on the active passage — it just no longer refuses. The
-- database keeps what only it can enforce: ownership, one active voyage per
-- owner, and the immutable manifest snapshot (cast_off_voyage and the
-- manifest-lock trigger are untouched).
--
-- When hard gates return, they must be satisfiable by the visible recheck
-- button in one tap — never a hidden second contract the UI can't explain.

DROP TRIGGER IF EXISTS enforce_traced_route_cast_off_verification_trigger ON public.voyages;
DROP FUNCTION IF EXISTS public.enforce_traced_route_cast_off_verification();
