-- Shore Watch, broadcast by the boat's Pi instead of a second phone.
--
-- Shane 2026-08-29: "lets wire up the shore watch to the pi, as long as it
-- still works device to device and pi to device." The point is that a skipper
-- should need a Pi OR a tablet aboard, not both — and a mains-powered Pi that
-- never sleeps is a far better watchkeeper than a phone in a bunk.
--
-- WHY A RELAY AND NOT A LOGIN. The anchor-watch channel is created with
-- `private: true` (services/AnchorWatchSyncService.ts), so joining it needs an
-- authenticated Supabase session. Putting one on the Pi would leave a
-- long-lived user credential on a boat computer that can be stolen with the
-- boat. The diary relay already solved this exact problem the right way —
-- "The Pi never holds a Supabase service-role key. It stores only the scoped
-- per-Pi relay credential supplied by the signed-in app" — so the anchor
-- relay reuses that identity rather than inventing a second one. One Pi, one
-- credential, in one place to revoke.
--
-- WHAT THIS TABLE ADDS. The relay credential says WHICH PI is calling. It says
-- nothing about which channel that Pi may broadcast to, and anchor-watch
-- sessions live only on the devices — there is no server-side record of them.
-- Without a binding, a compromised Pi could broadcast a fabricated position to
-- any session code it could guess. So the signed-in app authorises the pairing
-- explicitly: this relay, this session code, until this time.
--
-- The expiry matters as much as the binding. An anchor watch is a thing you
-- start and finish; a standing permission to broadcast someone's boat position
-- is not. It is refreshed by the app while the watch runs and simply lapses
-- when it stops.

CREATE TABLE IF NOT EXISTS public.pi_anchor_sessions (
    relay_id      TEXT PRIMARY KEY
                      REFERENCES public.pi_diary_relays(relay_id) ON DELETE CASCADE,
    owner_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Matches the app's generator: 12 chars, unambiguous alphabet.
    session_code  TEXT NOT NULL CHECK (session_code ~ '^[A-Za-z0-9]{12}$'),
    authorised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Never open-ended. The app re-authorises while the watch is running.
    expires_at    TIMESTAMPTZ NOT NULL,
    CONSTRAINT pi_anchor_sessions_expiry_bounded
        CHECK (expires_at > authorised_at AND expires_at <= authorised_at + INTERVAL '48 hours')
);

CREATE INDEX IF NOT EXISTS pi_anchor_sessions_owner_idx
    ON public.pi_anchor_sessions (owner_id);

ALTER TABLE public.pi_anchor_sessions ENABLE ROW LEVEL SECURITY;

-- Same posture as pi_diary_relays: the edge function reaches this with the
-- service role. No client, authenticated or otherwise, reads or writes it
-- directly — a token hash's neighbour is not a table to hand out.
REVOKE ALL ON TABLE public.pi_anchor_sessions FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.pi_anchor_sessions IS
    'Binds a Pi relay to the one anchor-watch session code it may broadcast to, with an expiry. Written by the anchor-relay Edge Function on behalf of the signed-in app; never client-writable.';

-- The write fence that every user-owned table added after 2026-08-06 needs, so
-- a tombstoned account cannot have rows written back to it. See
-- 20260806120000_account_deletion_durability.sql.
DROP TRIGGER IF EXISTS account_deletion_write_fence ON public.pi_anchor_sessions;
-- The argument names the FK column(s) to auth.users. The installer derives it
-- from the catalogue; a hand-written trigger has to say it, and a fence with
-- no argument silently checks nothing.
CREATE TRIGGER account_deletion_write_fence
    BEFORE INSERT OR UPDATE ON public.pi_anchor_sessions
    FOR EACH ROW EXECUTE FUNCTION public.block_tombstoned_account_write('owner_id');
