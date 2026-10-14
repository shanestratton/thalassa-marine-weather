/**
 * Run the held quiet-boat migration (129-08) in isolated, in-memory
 * PostgreSQL, over the very cases the TypeScript model is tested on
 * (tests/fixtures/boat-quiet/cases.json, tests/BoatQuietWatchModel.test.ts).
 * No project credentials, database connection or persistent database is used.
 *
 * NOT YET RUN: written with 129-08, to be run with Shane's yes. Install the
 * pinned package in a temporary directory OUTSIDE this repo (the one
 * scripts/check-official-alerts-db.mjs uses):
 *   npm install --prefix /absolute/temp/path --ignore-scripts --no-audit --no-fund \
 *     --save-exact @electric-sql/pglite@0.5.8
 *   PGLITE_MODULE_PATH=/absolute/temp/path/node_modules/@electric-sql/pglite/dist/index.js \
 *     node scripts/check-boat-quiet-db.mjs
 *
 * What it proves:
 * - 125's file then the held file apply, and the held file applies twice;
 * - vessel_quiet_watch_verdict() answers every case as the model does;
 * - vessel_quiet_watch_message() says every case's words;
 * - vessel_quiet_watch_recipients() pages the owner and only the crew who
 *   qualify (not pending, declined, guests, opted out or being deleted);
 * - check_vessel_quiet_watch(): one page per recipient per outage, nothing
 *   more while she is quiet, then one all-clear to exactly those it paged,
 *   with a page the queue still held set aside first;
 * - the skipper's switch as the app writes it under 125's grants, as
 *   authenticated: PostgREST's upsert shape is refused (42501, no UPDATE on
 *   owner_id), the update-then-insert the app sends is taken;
 * - switched off with a page open: one closing word to those paged;
 * - the crew calls: a qualifying member reads and sets their own pages; a
 *   guest cannot turn pages off; anon can call neither.
 * PGlite is PostgreSQL compiled to WASM, not the deployed Supabase server.
 * Single-session tests do not establish concurrency or query plans.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.PGLITE_MODULE_PATH;
if (!modulePath) throw new Error('Set PGLITE_MODULE_PATH to an isolated @electric-sql/pglite installation.');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const base = await read('supabase/migrations/20261009150000_vessel_quiet_watch.sql');
const held = await read('supabase/held-migrations/20261014180000_vessel_quiet_watch_crew.sql');
const cases = JSON.parse(await read('tests/fixtures/boat-quiet/cases.json'));
let checks = 0;
const eq = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
};

const db = new PGlite();
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const as = async (role, uid, sql, params = []) => {
    await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${uid ?? ''}', false); SET ROLE ${role}`);
    try {
        return await rows(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
};

const OWNER = cases.recipients.owner;
const crewIds = [...new Set(cases.recipients.crew.map((c) => c.crewUserId))];
try {
    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role BYPASSRLS;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
        CREATE SCHEMA auth;
        GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
        CREATE TABLE auth.users (id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
            $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
        CREATE FUNCTION public.block_tombstoned_account_write() RETURNS trigger LANGUAGE plpgsql AS
            'BEGIN RETURN NEW; END';
        CREATE TABLE public.account_deletion_jobs (user_id uuid PRIMARY KEY);
        CREATE TABLE public.boats (id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL);
        CREATE TABLE public.user_active_vessels (user_id uuid PRIMARY KEY, boat_id uuid NOT NULL);
        CREATE TABLE public.vessel_crew (
            id bigserial PRIMARY KEY, owner_id uuid NOT NULL, crew_user_id uuid NOT NULL,
            status text NOT NULL, role text NOT NULL, permissions jsonb NOT NULL DEFAULT '{}', voyage_id text
        );
        CREATE TABLE public.vessel_telemetry (
            owner_id uuid PRIMARY KEY, boat_id uuid, reported_at timestamptz NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now(), extra jsonb NOT NULL DEFAULT '{}'
        );
        CREATE TABLE public.push_notification_queue (
            id bigserial PRIMARY KEY, recipient_user_id uuid NOT NULL, notification_type text NOT NULL,
            title text NOT NULL, body text NOT NULL, data jsonb, created_at timestamptz NOT NULL DEFAULT now(),
            sent_at timestamptz, processing_at timestamptz, last_error text
        );
    `);
    for (const id of [OWNER, ...crewIds, '00000000-0000-4000-8000-0000000000aa']) {
        await rows('INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    }
    await db.exec(base);
    await db.exec(held);
    await db.exec(held); // a re-run is a no-op

    // ── The verdicts ──────────────────────────────────────────────────────
    const ms = (iso) => (iso ? Date.parse(iso) : null);
    const iso = (t) => (t === null ? null : new Date(t).toISOString());
    for (const c of cases.verdicts) {
        const r = c.row;
        const t = c.telemetry;
        const busMs = t?.busAtMs ? ms(t.busAtMs) : null;
        const heard = t ? ms(t.updatedAt) : null;
        // The bus is what her Pi dates it (bus_at_ms), never reported_at.
        const bus = t && busMs !== null ? Math.min(heard, busMs) : null;
        const w = r.window ?? null;
        const [{ verdict }] = await rows(
            `SELECT public.vessel_quiet_watch_verdict($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::time, $13::time, $14) AS verdict`,
            [
                c.now,
                r.enabled ?? true,
                r.armedAt ?? '2026-10-01T00:00:00Z',
                iso(heard),
                iso(bus),
                r.pagedAt ?? null,
                r.pagedLastHeardAt ?? null,
                r.pagedBusAt ?? null,
                r.clearedAt ?? null,
                r.quietAfterMinutes ?? 15,
                w?.dow ?? null,
                w?.start ?? null,
                w?.end ?? null,
                w?.tz ?? null,
            ],
        );
        eq(verdict, c.expect, c.name);
    }

    // ── The words ─────────────────────────────────────────────────────────
    for (const m of cases.messages) {
        const [said] = await rows('SELECT title, body FROM public.vessel_quiet_watch_message($1, $2, $3, $4)', [
            m.kind,
            m.boatName,
            m.minutes,
            m.busUnknown,
        ]);
        eq(said, { title: m.title, body: m.body }, `${m.kind} ${m.boatName}`);
    }

    // ── Who is paged ──────────────────────────────────────────────────────
    for (const c of cases.recipients.crew) {
        await rows(
            `INSERT INTO public.vessel_crew (owner_id, crew_user_id, status, role, permissions) VALUES ($1, $2, $3, $4, $5)`,
            [OWNER, c.crewUserId, c.status, c.role, JSON.stringify({ can_view_instruments: c.canViewInstruments })],
        );
    }
    for (const id of cases.recipients.optouts) {
        await rows('INSERT INTO public.vessel_quiet_watch_optouts (user_id, owner_id) VALUES ($1, $2)', [id, OWNER]);
    }
    for (const id of cases.recipients.deleting) {
        await rows('INSERT INTO public.account_deletion_jobs (user_id) VALUES ($1)', [id]);
    }
    const [{ recipients }] = await rows('SELECT public.vessel_quiet_watch_recipients($1) AS recipients', [OWNER]);
    eq(recipients, cases.recipients.expect, 'recipients');

    // ── One outage, start to finish (real clock: every statement commits) ──
    const boat = '00000000-0000-4000-8000-0000000000b0';
    await rows('INSERT INTO public.boats (id, owner_id, name) VALUES ($1, $2, $3)', [boat, OWNER, 'Αύρα']);
    await rows(
        `INSERT INTO public.vessel_telemetry (owner_id, boat_id, reported_at, updated_at, extra)
         VALUES ($1, $2, now() - interval '16 minutes', now() - interval '16 minutes',
                 jsonb_build_object('bus_at_ms', floor(extract(epoch FROM now() - interval '16 minutes') * 1000)))`,
        [OWNER, boat],
    );
    await rows(
        `INSERT INTO public.vessel_quiet_watch (owner_id, enabled, window_dow, window_start, window_end, window_tz)
         VALUES ($1, true, 3, '19:30', '19:50', 'Pacific/Auckland')`,
        [OWNER],
    );
    // Armed a day ago, so the silence counts from last heard.
    await rows(`UPDATE public.vessel_quiet_watch SET armed_at = now() - interval '1 day' WHERE owner_id = $1`, [OWNER]);
    const queue = () =>
        rows(
            'SELECT recipient_user_id AS recipient, notification_type AS type, title, data FROM public.push_notification_queue ORDER BY id',
        );

    await rows('SELECT public.check_vessel_quiet_watch()');
    let sent = await queue();
    eq(
        sent.map((p) => [p.recipient, p.type, p.title]),
        cases.recipients.expect.map((id) => [id, 'boat_quiet', 'Αύρα’s Pi is offline, or the boat’s internet is down']),
        'one page each',
    );
    eq(new Set(sent.map((p) => p.data.collapse)).size, 1, 'one collapse key per boat');
    eq(/^[0-9a-f]{16}$/.test(sent[0].data.collapse), true, 'the key send-push accepts');

    await rows('SELECT public.check_vessel_quiet_watch()');
    eq((await queue()).length, sent.length, 'nothing more while she is quiet');

    // A page whose first send failed, still in the queue: the all-clear sets it aside.
    await rows(
        `INSERT INTO public.push_notification_queue (recipient_user_id, notification_type, title, body, data)
         VALUES ($1, 'boat_quiet', 'held', 'held', jsonb_build_object('collapse', $2::text))`,
        [OWNER, sent[0].data.collapse],
    );
    await rows(`UPDATE public.push_notification_queue SET sent_at = now() WHERE title <> 'held'`);

    // A crew member opts out mid-outage: the all-clear still goes to those paged.
    await rows('INSERT INTO public.vessel_quiet_watch_optouts (user_id, owner_id) VALUES ($1, $2)', [
        cases.recipients.expect[1],
        OWNER,
    ]);
    await rows(
        `UPDATE public.vessel_telemetry SET reported_at = now(), updated_at = now(),
             extra = jsonb_build_object('bus_at_ms', floor(extract(epoch FROM now()) * 1000)) WHERE owner_id = $1`,
        [OWNER],
    );
    await rows('SELECT public.check_vessel_quiet_watch()');
    sent = (await queue()).filter((p) => p.type === 'boat_quiet_clear');
    eq(
        sent.map((p) => [p.recipient, p.title]),
        cases.recipients.expect.map((id) => [id, 'Αύρα is reporting again']),
        'one all-clear each, to those paged',
    );
    const [state] = await rows(
        'SELECT paged_at, paged_recipients, paged_kind, cleared_at IS NOT NULL AS cleared FROM public.vessel_quiet_watch WHERE owner_id = $1',
        [OWNER],
    );
    eq(state, { paged_at: null, paged_recipients: null, paged_kind: null, cleared: true }, 'the page is closed');
    const [held] = await rows(
        `SELECT sent_at IS NOT NULL AS done, last_error FROM public.push_notification_queue WHERE title = 'held'`,
    );
    eq(held, { done: true, last_error: 'superseded by the all-clear' }, 'the held page is set aside');

    // ── The skipper's switch, as the app writes it (125's grants) ─────────
    const second = '00000000-0000-4000-8000-0000000000aa';
    await assert.rejects(
        as(
            'authenticated',
            second,
            `INSERT INTO public.vessel_quiet_watch AS q (owner_id, enabled, window_dow, window_start, window_end, window_tz)
             VALUES ($1, true, 3, '19:30', '19:50', 'Europe/Lisbon')
             ON CONFLICT (owner_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, enabled = EXCLUDED.enabled`,
            [second],
        ),
        /permission denied/,
        'PostgREST’s upsert shape names owner_id in its SET: refused',
    );
    checks++;
    eq(
        await as(
            'authenticated',
            second,
            `UPDATE public.vessel_quiet_watch SET enabled = true, window_dow = 3, window_start = '19:30',
                 window_end = '19:50', window_tz = 'Europe/Lisbon' WHERE owner_id = $1 RETURNING owner_id`,
            [second],
        ),
        [],
        'the update finds no row yet',
    );
    await as(
        'authenticated',
        second,
        `INSERT INTO public.vessel_quiet_watch (owner_id, enabled, window_dow, window_start, window_end, window_tz)
         VALUES ($1, true, 3, '19:30', '19:50', 'Europe/Lisbon')`,
        [second],
    );
    eq(
        await as(
            'authenticated',
            second,
            `UPDATE public.vessel_quiet_watch SET enabled = false WHERE owner_id = $1 RETURNING owner_id, enabled`,
            [second],
        ),
        [{ owner_id: second, enabled: false }],
        'then the update takes',
    );

    // ── Switched off with a page open: one closing word to those paged ─────
    await rows(
        `UPDATE public.vessel_quiet_watch SET paged_at = now(), paged_last_heard_at = now(),
             paged_recipients = $2::uuid[], paged_kind = 'pi_offline' WHERE owner_id = $1`,
        [OWNER, cases.recipients.expect],
    );
    await as('authenticated', OWNER, 'UPDATE public.vessel_quiet_watch SET enabled = false WHERE owner_id = $1', [
        OWNER,
    ]);
    eq(
        (await queue()).filter((p) => p.data?.reason === 'watch_off').map((p) => [p.recipient, p.title]),
        cases.recipients.expect.map((id) => [id, 'Αύρα’s quiet-boat watch is off']),
        'one closing word each',
    );
    await rows('UPDATE public.vessel_quiet_watch SET enabled = true WHERE owner_id = $1', [OWNER]);

    // ── The crew calls ────────────────────────────────────────────────────
    const member = cases.recipients.expect[2];
    const guest = cases.recipients.crew.find((c) => c.role === 'punter' && c.crewUserId !== member).crewUserId;
    const boats = await as('authenticated', member, 'SELECT * FROM public.vessel_quiet_watch_crew_boats()');
    eq(boats, [{ owner_id: OWNER, boat_name: 'Αύρα', watch_on: true, paging_me: true }], 'a member sees her');
    eq(
        await as('authenticated', guest, 'SELECT * FROM public.vessel_quiet_watch_crew_boats()'),
        [],
        'a guest sees none',
    );
    await as('authenticated', member, 'SELECT public.set_vessel_quiet_watch_crew_page($1, false)', [OWNER]);
    eq(
        (await as('authenticated', member, 'SELECT paging_me FROM public.vessel_quiet_watch_crew_boats()'))[0]
            .paging_me,
        false,
        'turned off',
    );
    await as('authenticated', member, 'SELECT public.set_vessel_quiet_watch_crew_page($1, true)', [OWNER]);
    await assert.rejects(
        as('authenticated', guest, 'SELECT public.set_vessel_quiet_watch_crew_page($1, false)', [OWNER]),
        /Only crew she shares her instruments with/,
    );
    checks++;
    for (const sql of [
        'SELECT * FROM public.vessel_quiet_watch_crew_boats()',
        `SELECT public.set_vessel_quiet_watch_crew_page('${OWNER}', false)`,
        `SELECT public.vessel_quiet_watch_recipients('${OWNER}')`,
        'SELECT public.check_vessel_quiet_watch()',
        'SELECT * FROM public.vessel_quiet_watch_optouts',
    ]) {
        await assert.rejects(as('anon', null, sql), /permission denied/, sql);
        checks++;
    }
    for (const sql of [
        `SELECT public.vessel_quiet_watch_recipients('${OWNER}')`,
        'SELECT * FROM public.vessel_quiet_watch_optouts',
    ]) {
        await assert.rejects(as('authenticated', member, sql), /permission denied/, sql);
        checks++;
    }
    console.log(`boat-quiet: ${checks} checks passed`);
} finally {
    await db.close();
}
