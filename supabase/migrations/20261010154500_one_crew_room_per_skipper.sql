-- One Crew Chat per skipper, held by the database (2026-10-10, build 126,
-- package 126-13).
--
-- Authority
-- ─────────
-- Shane, 2026-10-09 ~11:30, on the chat lockdown: "yes to db changes".
-- Shane, 2026-10-09, starting build 126: "ok,  start on 126?". Standing
-- order: our own recommendation for every call that needs an answer.
-- Never pushed by an agent: Shane runs the push himself, after
-- 20261010154000 and before 20261010155000.
--
-- Why
-- ───
-- Build 125 finds the skipper's Crew Chat by owner (the oldest active private
-- 👥 room) and reads it back after a create, so two phones racing land in
-- one room (services/crew/crewChatRoom.ts). Nothing in the database stopped
-- a second room, though: on 2026-10-09 live held 39 copies of one
-- passage's crew room, made by older builds' name lookup. Shane deleted them
-- by hand that day (live at 16:35: 1 crew room, 'Crew Chat', 2 members), so
-- this file deletes nothing. What was left is the guard.
--
-- What
-- ────
-- 1. A pre-check: if any skipper already has more than one active private 👥
--    room, the push stops with a count (no ids), and nothing is deleted or
--    changed. Expected 0; the rehearsal counts it first.
-- 2. A unique partial index, chat_channels_one_crew_room_per_owner, on
--    owner_id WHERE is_private AND icon = '👥' AND status = 'active': the
--    same room the app finds and makes. A second create fails with 23505,
--    which build 126's crewChatRoom.ts reads as "another phone made it" and
--    goes on to the read-back. Rooms without an owner (an account deleted)
--    are NULL owners, which a unique index never counts as equal.
-- 3. The push fails unless the index exists, is unique and valid, and is on
--    owner_id alone with that predicate.
--
-- What older builds see
-- ─────────────────────
-- * builds 102-124 make a room per passage (createVoyageChannel). For a
--   skipper who already has a Crew Chat, that create now fails with 23505.
--   It already failed for every skipper who is not a chat moderator (42501,
--   shown as "Sign in"), and testers are on 125.
-- * build 125 classifies a 23505 on the create as "Crew Chat didn't open";
--   it only happens when two of the skipper's phones create at the same
--   moment, and the next tap finds the room.
-- * A moderator-approved private proposal that uses the 👥 icon, for an
--   owner who already has a Crew Chat, is refused too. Rare, and the right
--   answer anyway (125-17: block 👥 in proposals later).
--
-- The index briefly takes a SHARE lock on chat_channels while it builds
-- (milliseconds at this size); lock_timeout bounds the wait. Not
-- CONCURRENTLY: the CLI applies a file inside one transaction.
--
-- Undo
-- ────
--     DROP INDEX IF EXISTS public.chat_channels_one_crew_room_per_owner;
-- (builds 125+ keep working without it; they read the oldest room back).
--
-- No BEGIN/COMMIT: the CLI applies the file, and the rolled-back rehearsal
-- runs it twice to prove a re-run is a no-op. lock_timeout is set for the
-- session and reset at the end.

SET lock_timeout = '5s';

DO $precheck$
DECLARE
    crowded INTEGER;
BEGIN
    SELECT count(*) INTO crowded FROM (
        SELECT owner_id
          FROM public.chat_channels
         WHERE is_private AND icon = '👥' AND status = 'active'
           AND owner_id IS NOT NULL
         GROUP BY owner_id
        HAVING count(*) > 1
    ) AS owners;
    IF crowded > 0 THEN
        RAISE EXCEPTION 'one crew room per skipper: % skipper(s) already have more than one active Crew Chat; nothing was deleted or changed', crowded;
    END IF;
END;
$precheck$;

CREATE UNIQUE INDEX IF NOT EXISTS chat_channels_one_crew_room_per_owner
    ON public.chat_channels (owner_id)
    WHERE is_private AND icon = '👥' AND status = 'active';

COMMENT ON INDEX public.chat_channels_one_crew_room_per_owner IS
    'One active private 👥 room (Crew Chat) per skipper. A second create fails 23505; crewChatRoom.ts reads the existing room back (2026-10-10).';

DO $check$
DECLARE
    predicate TEXT;
BEGIN
    SELECT pg_get_expr(i.indpred, i.indrelid) INTO predicate
      FROM pg_index AS i
     WHERE i.indexrelid = to_regclass('public.chat_channels_one_crew_room_per_owner')
       AND i.indrelid = 'public.chat_channels'::regclass
       AND i.indisunique
       AND i.indisvalid
       AND i.indnatts = 1
       AND i.indexprs IS NULL
       AND i.indpred IS NOT NULL
       AND i.indkey[0] = (
           SELECT a.attnum FROM pg_attribute AS a
            WHERE a.attrelid = 'public.chat_channels'::regclass AND a.attname = 'owner_id'
       );
    IF predicate IS NULL
       OR position('is_private' IN predicate) = 0
       OR position('icon' IN predicate) = 0
       OR position('👥' IN predicate) = 0
       OR position('status' IN predicate) = 0
       OR position('''active''' IN predicate) = 0 THEN
        RAISE EXCEPTION 'one crew room per skipper: % is missing or wrong', 'chat_channels_one_crew_room_per_owner';
    END IF;
END;
$check$;

RESET lock_timeout;
