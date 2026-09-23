/**
 * Executes the real guest-comment migration in a fresh in-memory PostgreSQL
 * (PGlite), never the linked project. No network or production credentials.
 *
 * Install @electric-sql/pglite outside this repo, then run:
 * PGLITE_MODULE_PATH=/absolute/path/node_modules/@electric-sql/pglite/dist/index.js \
 *   node scripts/check-diary-comments-db.mjs
 *
 * Fixture tables contain only the columns the migration uses. auth.uid() and
 * the existing persisted quota function are test doubles; actual PostgreSQL
 * roles, grants, RLS, SQL functions, constraints and transactions execute here.
 * PGlite has one session: this validates revocation orderings/idempotency, not
 * simultaneous PostgreSQL sessions or the shared edge quota implementation.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const modulePath = process.env.PGLITE_MODULE_PATH;
if (!modulePath) throw new Error('Set PGLITE_MODULE_PATH to an isolated @electric-sql/pglite installation.');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
let checks = 0;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = uuid(1),
    CREW = uuid(2),
    STRANGER = uuid(3),
    NEW_OWNER = uuid(4);
const BOAT = uuid(100),
    OTHER_BOAT = uuid(101),
    CONFIG = uuid(200);
const PUBLIC = uuid(300),
    PRIVATE = uuid(301),
    CREW_ENTRY = uuid(302),
    WRONG_BOAT = uuid(303),
    STRANGER_ENTRY = uuid(304);
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
async function equal(sql, expected, label, params = []) {
    const rows = await query(sql, params);
    assert.deepEqual(rows[0]?.value, expected, label);
    checks++;
}
async function denied(sql, code, label, params = []) {
    await assert.rejects(
        () => db.query(sql, params),
        (error) => error.code === code,
        label,
    );
    checks++;
}
async function asRole(role, user = '') {
    await db.exec(`RESET ROLE; SET ROLE ${role};`);
    await query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user]);
}
const submit = 'SELECT public.submit_diary_guest_comment($1,$2,$3,$4,$5) AS value';
const read = 'SELECT count(*)::int AS value FROM public.read_public_diary_comments($1,$2)';
const moderate = 'SELECT public.moderate_diary_guest_comment($1,$2) AS value';
const args = (entry = PUBLIC, id = 400, body = 'Lovely trip!') => ['serene-summer', entry, uuid(id), 'Marta', body];

try {
    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id UUID PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
        $$;
        GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
        CREATE TABLE public.diary_entries (id UUID PRIMARY KEY, user_id UUID, boat_id UUID, is_public BOOLEAN);
        CREATE TABLE public.voyage_log_configs (id UUID PRIMARY KEY, handle TEXT UNIQUE, owner_id UUID, boat_id UUID, scope TEXT, enabled BOOLEAN);
        CREATE TABLE public.boat_members (boat_id UUID, user_id UUID);
        GRANT SELECT ON public.voyage_log_configs TO authenticated;
        CREATE FUNCTION public.consume_edge_quota(TEXT, INTEGER, INTEGER) RETURNS BOOLEAN LANGUAGE sql AS $$
            SELECT coalesce(current_setting('test.quota', true), '') <> 'deny';
        $$;
        INSERT INTO auth.users VALUES ('${OWNER}'), ('${CREW}'), ('${STRANGER}'), ('${NEW_OWNER}');
        INSERT INTO public.voyage_log_configs VALUES ('${CONFIG}', 'serene-summer', '${OWNER}', '${BOAT}', 'personal', true);
        INSERT INTO public.diary_entries VALUES
            ('${PUBLIC}', '${OWNER}', '${BOAT}', true),
            ('${PRIVATE}', '${OWNER}', '${BOAT}', false),
            ('${CREW_ENTRY}', '${CREW}', '${BOAT}', true),
            ('${WRONG_BOAT}', '${OWNER}', '${OTHER_BOAT}', true),
            ('${STRANGER_ENTRY}', '${STRANGER}', '${BOAT}', true);
        INSERT INTO public.boat_members VALUES ('${BOAT}', '${OWNER}'), ('${BOAT}', '${CREW}');
    `);
    await db.exec(
        await readFile(
            new URL('../supabase/migrations/20260920120000_moderated_diary_guest_comments.sql', import.meta.url),
            'utf8',
        ),
    );

    // The public edge is the only actor permitted to submit/read public RPCs.
    await asRole('anon');
    await denied('SELECT * FROM public.diary_guest_comments', '42501', 'anonymous cannot read pending rows');
    await denied(submit, '42501', 'anonymous cannot bypass edge quota by directly invoking submission', args());
    await denied(read, '42501', 'anonymous cannot directly invoke service RPC', ['serene-summer', PUBLIC]);
    await denied(moderate, '42501', 'anonymous cannot approve', [uuid(999), 'approve']);
    await asRole('authenticated', STRANGER);
    await denied(submit, '42501', 'authenticated cannot bypass edge quota', args());
    await denied(
        'INSERT INTO public.diary_guest_comments(entry_id,log_config_id,submission_id,guest_name,body) VALUES ($1,$2,$3,$4,$5)',
        '42501',
        'authenticated cannot insert directly',
        [PUBLIC, CONFIG, uuid(999), 'Marta', 'Hello'],
    );
    await denied(
        "UPDATE public.diary_guest_comments SET status='approved'",
        '42501',
        'authenticated cannot approve directly',
    );
    await denied('DELETE FROM public.diary_guest_comments', '42501', 'authenticated cannot delete directly');

    await asRole('service_role');
    await equal(submit, false, 'private entry rejected', args(PRIVATE));
    await equal(submit, false, 'wrong boat rejected', args(WRONG_BOAT));
    await equal(submit, false, 'crew excluded from personal log', args(CREW_ENTRY));
    await equal(submit, false, 'unrelated author excluded', args(STRANGER_ENTRY));
    await equal(submit, false, 'unknown entry rejected', args(uuid(999)));
    await equal(submit, false, 'unknown handle rejected', ['missing', PUBLIC, uuid(400), 'Marta', 'Hello']);
    await equal(submit, true, 'public entry accepts a pending comment', args());
    await equal(submit, true, 'uncertain retry accepted without duplication', args());
    await equal('SELECT count(*)::int AS value FROM public.diary_guest_comments', 1, 'retry retains one row');
    await denied(submit, '22023', 'idempotency key cannot replace guest words', args(PUBLIC, 400, 'Changed words'));
    await denied(submit, '22023', 'markup denied at SQL boundary', args(PUBLIC, 401, '<script>bad</script>'));
    await denied(submit, '22023', 'links denied at SQL boundary', args(PUBLIC, 401, 'https://example.com'));
    await denied(submit, '22023', 'overlong body denied at SQL boundary', args(PUBLIC, 401, 'x'.repeat(2001)));
    await equal(read, 0, 'pending is never public', ['serene-summer', PUBLIC]);
    const [{ id: commentId }] = await query('SELECT id FROM public.diary_guest_comments');
    await asRole('authenticated', STRANGER);
    await equal(
        'SELECT count(*)::int AS value FROM public.diary_guest_comments',
        0,
        'RLS hides rows from other skippers',
    );
    await equal(moderate, false, 'other skipper cannot approve', [commentId, 'approve']);
    await asRole('authenticated', OWNER);
    await equal('SELECT count(*)::int AS value FROM public.diary_guest_comments', 1, 'owner can review pending rows');
    await denied(moderate, '22023', 'invalid moderation action rejected', [commentId, 'publish-everything']);
    await query("SELECT set_config('test.quota', 'deny', false)");
    await denied(moderate, '54000', 'moderation respects existing quota denial', [commentId, 'approve']);
    await query("SELECT set_config('test.quota', '', false)");
    await equal(moderate, true, 'owner can approve', [commentId, 'approve']);
    await asRole('service_role');
    await equal(read, 1, 'approved comment visible', ['serene-summer', PUBLIC]);

    // Publication and ownership changes are checked at read/submission time.
    await db.exec('RESET ROLE');
    await query('UPDATE public.diary_entries SET is_public=false WHERE id=$1', [PUBLIC]);
    await asRole('service_role');
    await equal(read, 0, 'unpublish immediately hides existing approval', ['serene-summer', PUBLIC]);
    await equal(submit, false, 'unpublished target rejects additional submissions', args(PUBLIC, 402));
    await db.exec('RESET ROLE');
    await query('UPDATE public.diary_entries SET is_public=true WHERE id=$1', [PUBLIC]);
    await query('UPDATE public.voyage_log_configs SET enabled=false WHERE id=$1', [CONFIG]);
    await asRole('service_role');
    await equal(read, 0, 'disabled sharing hides approval', ['serene-summer', PUBLIC]);
    await equal(submit, false, 'disabled sharing rejects submission', args(PUBLIC, 402));
    await db.exec('RESET ROLE');
    await query("UPDATE public.voyage_log_configs SET enabled=true, scope='combined' WHERE id=$1", [CONFIG]);
    await asRole('service_role');
    await equal(submit, true, 'combined sharing accepts published crew entry', args(CREW_ENTRY, 403));
    const [{ id: crewComment }] = await query('SELECT id FROM public.diary_guest_comments WHERE entry_id=$1', [
        CREW_ENTRY,
    ]);
    await asRole('authenticated', OWNER);
    await equal(moderate, true, 'skipper approves crew-entry comment', [crewComment, 'approve']);
    await db.exec('RESET ROLE');
    await query('DELETE FROM public.boat_members WHERE user_id=$1', [CREW]);
    await asRole('service_role');
    await equal(read, 0, 'removed crew author no longer shared', ['serene-summer', CREW_ENTRY]);
    await equal(submit, false, 'removed crew author cannot receive guest submissions', args(CREW_ENTRY, 404));
    await db.exec('RESET ROLE');
    await query('UPDATE public.voyage_log_configs SET owner_id=$1 WHERE id=$2', [NEW_OWNER, CONFIG]);
    await asRole('service_role');
    await equal(read, 0, 'ownership transfer invalidates old owner approval even while entry remains public', [
        'serene-summer',
        PUBLIC,
    ]);
    await asRole('authenticated', OWNER);
    await equal(moderate, false, 'delayed prior-owner approval loses authority after transfer', [commentId, 'approve']);
    await equal(
        'SELECT count(*)::int AS value FROM public.diary_guest_comments',
        0,
        'former owner loses moderation read',
    );
    await asRole('authenticated', NEW_OWNER);
    await equal(moderate, true, 'new owner can approve existing guest words', [commentId, 'approve']);
    await asRole('service_role');
    await equal(read, 1, 'new owner approval restores public comment', ['serene-summer', PUBLIC]);
    await asRole('authenticated', NEW_OWNER);
    await equal(moderate, true, 'new owner can remove an approved comment', [commentId, 'reject']);
    await asRole('service_role');
    await equal(read, 0, 'rejected comment disappears', ['serene-summer', PUBLIC]);

    // Inventory checks and duplicate handling run in the migration functions.
    await query('DELETE FROM public.diary_guest_comments WHERE log_config_id=$1', [CONFIG]);
    for (let i = 0; i < 100; i++) await query(submit, args(PUBLIC, 1000 + i));
    await denied(submit, '54000', '100 pending comments cap', args(PUBLIC, 2000));
    await equal(submit, true, 'retry succeeds even when queue is full', args(PUBLIC, 1000));
    await query('DELETE FROM public.diary_guest_comments WHERE log_config_id=$1', [CONFIG]);
    await query(
        `INSERT INTO public.diary_guest_comments(entry_id,log_config_id,submission_id,guest_name,body,status,reviewed_by)
        SELECT $1, $2, gen_random_uuid(), 'Guest', 'Approved comment', 'approved', $3 FROM generate_series(1,200)`,
        [PUBLIC, CONFIG, NEW_OWNER],
    );
    await denied(submit, '54000', '200 daily per-log cap includes reviewed rows', args(PUBLIC, 2001));
    await equal(read, 100, 'public read payload remains bounded', ['serene-summer', PUBLIC]);
    await db.exec('RESET ROLE');
    await query('DELETE FROM public.diary_entries WHERE id=$1', [PUBLIC]);
    await equal(
        'SELECT count(*)::int AS value FROM public.diary_guest_comments',
        0,
        'entry deletion cascades comments',
    );

    console.log(`PASS: ${checks} executable PostgreSQL comment boundary assertions. Fresh in-memory database only.`);
} finally {
    await db.close();
}
