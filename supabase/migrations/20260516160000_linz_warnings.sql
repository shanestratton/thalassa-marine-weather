-- ═══════════════════════════════════════════════════════════════
-- LINZ / Maritime NZ — NAVAREA XIV navigational warnings cache
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Maritime NZ's public warnings page (https://www.maritimenz.govt.nz/
-- navigational-warnings/) is behind a Cloudflare JS challenge that
-- Deno fetch can't solve. The workaround is a GitHub Actions cron job
-- that runs Playwright in headless Chromium (which CF lets through),
-- scrapes the in-force warnings, and writes them to this table. The
-- proxy-linz-msi edge function then serves the cached rows in the
-- same RawBroadcastWarn shape the iOS client already understands.
--
-- Population: scripts/linz-msi-scrape/scrape.mjs via
-- .github/workflows/linz-msi-scrape.yml (every 6 hours).
-- Serving:    supabase/functions/proxy-linz-msi/index.ts
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.linz_warnings (
    -- Composite-but-stable id: "<navArea>-<msgYear>/<msgNumber>".
    -- Matches the shape NoticeToMarinersService already de-dupes on.
    id          TEXT PRIMARY KEY,

    msg_year    INTEGER NOT NULL,
    msg_number  INTEGER NOT NULL,
    nav_area    TEXT    NOT NULL,                 -- 'XIV' (or coastal subcode)
    subregion   TEXT    NOT NULL DEFAULT '',
    text        TEXT    NOT NULL,                 -- full body, header-prefixed
    status      TEXT    NOT NULL DEFAULT 'A',     -- only in-force scraped
    issue_date  TEXT    NOT NULL DEFAULT '',      -- "DDHHMMZ MON YYYY"
    authority   TEXT    NOT NULL DEFAULT 'MARITIME NZ',

    -- When the scraper last saw this warning. Rows missing from a fresh
    -- scrape are deleted (warning withdrawn / cancelled).
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_linz_warnings_fetched_at
    ON public.linz_warnings (fetched_at DESC);

-- RLS off — only the edge function (service-role) and the scraper
-- (service-role) ever touch this table. No direct client access.
ALTER TABLE public.linz_warnings DISABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════
-- Done. To inspect after the first GH Actions run:
--   SELECT id, issue_date, left(text, 80) FROM public.linz_warnings
--     ORDER BY msg_year DESC, msg_number DESC LIMIT 20;
-- ═══════════════════════════════════════════════════════════════
