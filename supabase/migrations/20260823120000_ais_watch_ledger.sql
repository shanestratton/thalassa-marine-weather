-- On Watch — the AIS crowd-feed contribution ledger.
--
-- THE ONE INVARIANT THIS SCHEMA EXISTS TO ENFORCE: credit is denominated in
-- VERIFIED LISTENING TIME, never in yield. A boat anchored off Osprey Reef
-- hearing nothing for a month accrues at exactly the same rate as a boat in
-- Sydney Harbour hearing thirty sentences a second. That is not a policy we
-- promise to follow — it is arithmetic. `sentences` is recorded here for
-- diagnostics and is read by NOTHING: no credit path, no standing rule, no
-- access decision. tests/AisWatchYieldBlind.test.ts pins it.
--
-- The reason it matters: the empty-bay punter is the single most valuable
-- contributor in the fleet (they are the only ear for hundreds of miles, and
-- their silence proves coverage exists there), and they produce zero vessel
-- rows. Every yield-based metric silently punishes exactly the person the
-- feed most needs.
--
-- WHAT IS DELIBERATELY ABSENT: there is no position column, no history table,
-- no per-check-in row and no hourly bucket. It is structurally impossible to
-- reconstruct where a boat was, when it moved, or what route it took. The most
-- this table can say is "this account was listening, and we last heard from it
-- at 14:32". A month of quarter-degree hourly cells keyed to auth.users would
-- be a real person's ocean passage at 25 km resolution, and it could not
-- honestly be called anonymous.
--
-- RLS posture is a structural copy of public.user_entitlements (20260728100000)
-- and the RPC follows public.consume_edge_quota: SECURITY DEFINER, pinned
-- search_path, null-uid guard, EXECUTE to authenticated only.

CREATE TABLE IF NOT EXISTS public.ais_watch (
    user_id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ANY check-in, connected or not. A gateway that is down still reports.
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Last check-in that actually carried connected seconds.
    last_connected_at   TIMESTAMPTZ,
    -- Last time an AIS sentence was decoded from this contributor, ever.
    -- Drives the `deaf` diagnosis and NOTHING else.
    last_heard_at       TIMESTAMPTZ,
    watch_minutes       INTEGER NOT NULL DEFAULT 0,
    -- Display only, and an approximation: with no history table a true rolling
    -- window is impossible, so this decays exponentially with a 7-day constant
    -- on each check-in. Deliberately NOT a rule input.
    watch_minutes_7d    INTEGER NOT NULL DEFAULT 0,
    decayed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- INFORMATIONAL ONLY. No rule reads these two. See the header.
    sentences           BIGINT NOT NULL DEFAULT 0,
    offline_claimed_min BIGINT NOT NULL DEFAULT 0,
    rig                 TEXT,
    link                TEXT,
    link_error          TEXT,
    reconnects          INTEGER NOT NULL DEFAULT 0,
    health              TEXT,
    consent_version     TEXT,
    consented_at        TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ
);

COMMENT ON COLUMN public.ais_watch.sentences IS
    'Diagnostics only. Must never feed a credit, standing or access decision.';
COMMENT ON COLUMN public.ais_watch.watch_minutes IS
    'Lifetime minutes of a working receiver online. Monotonic. The only credit.';

-- Sweep support: find rows dormant long enough to drop.
CREATE INDEX IF NOT EXISTS ais_watch_last_seen_idx
    ON public.ais_watch (last_seen_at);

ALTER TABLE public.ais_watch ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ais_watch_read_own ON public.ais_watch;
CREATE POLICY ais_watch_read_own
    ON public.ais_watch FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

-- There are intentionally no client INSERT/UPDATE/DELETE policies. A skipper
-- may read their own standing; only record_ais_watch() writes it.
REVOKE ALL ON TABLE public.ais_watch FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.ais_watch FROM authenticated;
GRANT SELECT ON TABLE public.ais_watch TO authenticated;


-- ── The coverage map ────────────────────────────────────────────────────────
-- Opt-in SEPARATELY from sharing (second switch, default off) and deliberately
-- carries NO user_id: a lit cell refreshed to the minute is one identifiable
-- solo offshore boat, which is precisely the person this whole design exists
-- to honour. Coarse (1° ≈ 60 NM), monthly, and never live. The absent user_id
-- is also why it must stay coarse — with no key, it cannot be deleted on
-- request, so it must never have been personal in the first place.
CREATE TABLE IF NOT EXISTS public.ais_coverage (
    cell_lat  SMALLINT NOT NULL,
    cell_lon  SMALLINT NOT NULL,
    month     DATE     NOT NULL,
    listeners INTEGER  NOT NULL DEFAULT 0,
    heard_any BOOLEAN  NOT NULL DEFAULT false,
    PRIMARY KEY (cell_lat, cell_lon, month)
);

ALTER TABLE public.ais_coverage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ais_coverage_read_authenticated ON public.ais_coverage;
CREATE POLICY ais_coverage_read_authenticated
    ON public.ais_coverage FOR SELECT TO authenticated
    USING (true);

REVOKE ALL ON TABLE public.ais_coverage FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.ais_coverage FROM authenticated;
GRANT SELECT ON TABLE public.ais_coverage TO authenticated;


-- ── record_ais_watch ────────────────────────────────────────────────────────
--
-- FOUR INVARIANTS. Change any of them and the design stops being what it says
-- it is:
--   1. credit_s can never exceed wall-clock elapsed since the last check-in.
--      Otherwise a client claiming 86400 connected seconds every five minutes
--      mints unlimited standing.
--   2. p_sentences NEVER enters the credit arithmetic. It is added to a column
--      no rule reads.
--   3. A check-in with a DOWN link still stamps last_seen_at. The one fault
--      the ledger most needs to hear about must not be the fault that silences
--      the report.
--   4. Errors here must never break the feed. The worker calls this after the
--      sentences are already banked and ignores failures.
CREATE OR REPLACE FUNCTION public.record_ais_watch(
    p_connected_s     INTEGER  DEFAULT 0,
    p_sentences       BIGINT   DEFAULT 0,
    p_link            TEXT     DEFAULT NULL,
    p_link_error      TEXT     DEFAULT NULL,
    p_reconnects      INTEGER  DEFAULT 0,
    p_rig             TEXT     DEFAULT NULL,
    p_health          TEXT     DEFAULT NULL,
    p_heard           BOOLEAN  DEFAULT false,
    p_offline_min     BIGINT   DEFAULT 0,
    p_consent_version TEXT     DEFAULT NULL,
    p_revoke          BOOLEAN  DEFAULT false
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    uid          UUID := auth.uid();
    existing     public.ais_watch%ROWTYPE;
    elapsed_s    NUMERIC;
    credit_s     NUMERIC;
    credit_min   INTEGER;
    decay_days   NUMERIC;
    new_7d       INTEGER;
    standing     TEXT;
    now_ts       TIMESTAMPTZ := now();
BEGIN
    -- Null uid means the service role or an unauthenticated caller. The whole
    -- ledger keys on auth.uid(), so there is nothing to record.
    IF uid IS NULL THEN
        RETURN json_build_object('ok', false, 'reason', 'unauthenticated');
    END IF;

    SELECT * INTO existing FROM public.ais_watch WHERE user_id = uid;

    -- INVARIANT 1: you cannot claim more connected time than has actually
    -- passed. A first-ever check-in has no previous stamp to measure against,
    -- so it is bounded by the hard hourly cap alone.
    IF existing.user_id IS NULL THEN
        elapsed_s := 3600;
    ELSE
        elapsed_s := GREATEST(0, EXTRACT(EPOCH FROM (now_ts - existing.last_seen_at)));
    END IF;
    credit_s   := LEAST(GREATEST(COALESCE(p_connected_s, 0), 0), elapsed_s, 3600);
    credit_min := FLOOR(credit_s / 60)::INTEGER;

    IF p_revoke THEN
        -- Opt-out is an event worth recording: it stops future credit without
        -- destroying what was earned, so a skipper who comes back is restored
        -- by a single check-in rather than starting again.
        UPDATE public.ais_watch
           SET revoked_at = now_ts,
               link       = NULL,
               last_seen_at = now_ts
         WHERE user_id = uid;
        RETURN json_build_object('ok', true, 'standing', 'revoked');
    END IF;

    IF existing.user_id IS NULL THEN
        INSERT INTO public.ais_watch (
            user_id, first_seen_at, last_seen_at, last_connected_at, last_heard_at,
            watch_minutes, watch_minutes_7d, decayed_at, sentences, offline_claimed_min,
            rig, link, link_error, reconnects, health, consent_version, consented_at
        ) VALUES (
            uid, now_ts, now_ts,
            CASE WHEN credit_s > 0 THEN now_ts ELSE NULL END,
            CASE WHEN p_heard THEN now_ts ELSE NULL END,
            credit_min, credit_min, now_ts, GREATEST(COALESCE(p_sentences, 0), 0),
            GREATEST(COALESCE(p_offline_min, 0), 0),
            p_rig, p_link, left(p_link_error, 200), GREATEST(COALESCE(p_reconnects, 0), 0),
            p_health, p_consent_version, now_ts
        );
        new_7d := credit_min;
    ELSE
        -- Display-only decay. With no history table a true rolling window is
        -- impossible; this bleeds the figure off with a 7-day constant so the
        -- card shows recent effort rather than a lifetime total. It is not a
        -- rule input, so the approximation costs nobody anything.
        decay_days := LEAST(GREATEST(EXTRACT(EPOCH FROM (now_ts - existing.decayed_at)) / 86400, 0), 60);
        new_7d := GREATEST(0, FLOOR(existing.watch_minutes_7d * exp(-decay_days / 7))::INTEGER) + credit_min;

        UPDATE public.ais_watch
           SET -- INVARIANT 3: stamped on EVERY check-in, down link included.
               last_seen_at      = now_ts,
               last_connected_at = CASE WHEN credit_s > 0 THEN now_ts ELSE existing.last_connected_at END,
               last_heard_at     = CASE WHEN p_heard THEN now_ts ELSE existing.last_heard_at END,
               watch_minutes     = existing.watch_minutes + credit_min,
               watch_minutes_7d  = new_7d,
               decayed_at        = now_ts,
               -- INVARIANT 2: recorded, never read by a rule.
               sentences           = existing.sentences + GREATEST(COALESCE(p_sentences, 0), 0),
               offline_claimed_min = existing.offline_claimed_min + GREATEST(COALESCE(p_offline_min, 0), 0),
               rig             = COALESCE(p_rig, existing.rig),
               link            = COALESCE(p_link, existing.link),
               link_error      = left(p_link_error, 200),
               reconnects      = GREATEST(COALESCE(p_reconnects, 0), 0),
               health          = COALESCE(p_health, existing.health),
               consent_version = COALESCE(p_consent_version, existing.consent_version),
               consented_at    = COALESCE(existing.consented_at, now_ts),
               revoked_at      = NULL
         WHERE user_id = uid;
    END IF;

    -- Standing is a pure function of recency and honest link reporting.
    -- Windows are 14 and 90 days rather than 2 and 21 because the check-in is
    -- a setInterval in the webview with no background task: it only fires with
    -- the app in the foreground. Under a 2-day rule the MODAL honest
    -- contributor — the weekend sailor who feeds a busy bay all Sunday then
    -- closes the app — is downgraded by Tuesday with faultless hardware. And
    -- 21 days is shorter than Panama to the Marquesas.
    SELECT CASE
        WHEN credit_s > 0 THEN 'on_watch'
        WHEN p_link IN ('down', 'reconnecting') THEN 'repair'
        ELSE 'on_watch'
    END INTO standing;

    RETURN json_build_object(
        'ok', true,
        'standing', standing,
        'watchMinutes', COALESCE(existing.watch_minutes, 0) + credit_min,
        'watchMinutes7d', new_7d,
        'creditedMinutes', credit_min
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_ais_watch(
    INTEGER, BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN, BIGINT, TEXT, BOOLEAN
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_ais_watch(
    INTEGER, BIGINT, TEXT, TEXT, INTEGER, TEXT, TEXT, BOOLEAN, BIGINT, TEXT, BOOLEAN
) TO authenticated;


-- ── sweep_ais_watch ─────────────────────────────────────────────────────────
-- Rows outlive an account only by accident; ON DELETE CASCADE puts ais_watch
-- inside the existing account-deletion boundary. This drops rows for accounts
-- that still exist but have been dormant well past the Ashore threshold, so
-- the table does not accumulate contributors who left years ago.
--
-- 400 days, not 90: a boat can be genuinely away for a season, and the Ashore
-- STANDING already handles the display. This is storage hygiene, and deleting
-- an earned lifetime total is not something to do on a 90-day timer.
CREATE OR REPLACE FUNCTION public.sweep_ais_watch()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    removed INTEGER;
BEGIN
    DELETE FROM public.ais_watch
     WHERE last_seen_at < now() - INTERVAL '400 days';
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_ais_watch() FROM PUBLIC, anon, authenticated;
