/** Actual PostgreSQL17.6, exact empty localhost fixture only. No product credentials. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const exact = 'postgresql://postgres:fixture-only-password@127.0.0.1:5432/community_chart_notes140_test';
if (
    process.env.THALASSA_DISPOSABLE_COMMUNITY_TEST !== '1' ||
    process.env.COMMUNITY_TEST_DATABASE_URL !== exact ||
    !process.env.PG_MODULE_PATH ||
    Object.keys(process.env).some((k) => /^PG/i.test(k) && k !== 'PG_MODULE_PATH' && process.env[k]) ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_SERVICE_ROLE_KEY
)
    throw Error('Exact disposable localhost community chart-note fixture required');
const pg = await import(pathToFileURL(process.env.PG_MODULE_PATH).href);
const Pool = pg.Pool ?? pg.default.Pool;
const pool = new Pool({
    connectionString: exact,
    max: 12,
    statement_timeout: 15000,
    query_timeout: 18000,
    connectionTimeoutMillis: 5000,
});
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const reviewMigration = await read('../migrations/20261017010813_community_place_reviews.sql');
const migration = await read('../migrations/20261017011927_community_chart_notes.sql');
const a = '10000000-0000-4000-8000-000000000001',
    b = '10000000-0000-4000-8000-000000000002',
    mod = '10000000-0000-4000-8000-000000000003',
    anonUser = '10000000-0000-4000-8000-000000000004';
let checks = 0;
const clients = new Set();
const races = [];
const eq = (a, b, label) => {
    assert.deepEqual(a, b, label);
    checks++;
};
async function connect(uid = null, role = 'authenticated') {
    const c = await pool.connect();
    clients.add(c);
    await c.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)", [
        uid ?? '',
        role,
    ]);
    await c.query('set role ' + role);
    return c;
}
async function done(c) {
    try {
        await c.query('rollback');
        await c.query('reset role');
    } finally {
        c.release();
        clients.delete(c);
    }
}
async function call(uid, action, input = {}, role = uid ? 'authenticated' : 'anon') {
    const c = await connect(uid, role);
    try {
        return (await c.query('select public.community_chart_notes($1,$2::jsonb) v', [action, input])).rows[0].v;
    } finally {
        await done(c);
    }
}
async function photo(uid, action, input) {
    const c = await connect(null, 'service_role');
    try {
        return (await c.query('select public.community_chart_photo($1,$2,$3::jsonb) v', [action, uid, input])).rows[0]
            .v;
    } finally {
        await done(c);
    }
}
async function rejects(fn, rx, label) {
    await assert.rejects(fn, rx, label);
    checks++;
}
const today = new Date().toISOString().slice(0, 10);
const draft = {
    kind: 'hazard',
    latitude: -27,
    longitude: 153,
    message: 'Floating debris observed. Unofficial.',
    observed_date: today,
    terms_version: '2026-10-17',
    public_consent: 'publish-pin-and-note-v1',
};
const bbox = [152, -28, 154, -26];
const listing = async (u = null) => (await call(u, 'list', { bbox })).notes;
const mine = async (id) => (await call(a, 'mine', { id })).note;
const age = () => pool.query("update community_private.chart_notes set updated_at=now()-interval '10 seconds'");
async function oldCall(uid, action, input) {
    const c = await connect(uid, uid ? 'authenticated' : 'anon');
    try {
        return (await c.query('select public.community_reviews($1,$2::jsonb) v', [action, input])).rows[0].v;
    } finally {
        await done(c);
    }
}
async function oldPhoto(uid, action, input) {
    const c = await connect(null, 'service_role');
    try {
        return (await c.query('select public.community_review_photo($1,$2,$3::jsonb) v', [action, uid, input])).rows[0]
            .v;
    } finally {
        await done(c);
    }
}
async function moderate(id, decision, extra = {}) {
    const r = (await call(mod, 'queue')).queue.find((n) => n.id === id);
    assert.ok(r, 'current queue item');
    return call(mod, 'moderate', { id, revision: r.revision, decision, ...extra });
}
async function blocked(pid) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
        if ((await pool.query('select cardinality(pg_blocking_pids($1))>0 blocked', [pid])).rows[0].blocked) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw Error('Competing transaction did not demonstrably block');
}
try {
    const pre = (
        await pool.query(
            "select current_setting('server_version') version,exists(select 1 from pg_namespace where nspname in('auth','storage','community_private')) occupied",
        )
    ).rows[0];
    assert.match(pre.version, /^17\.6(?:\D|$)/);
    checks++;
    eq(pre.occupied, false, 'empty localhost host');
    await pool.query(await read('./community-reviews-base.sql'));
    const fence = await read('../migrations/20261005160000_tombstone_fence_fails_closed.sql');
    await pool.query(
        fence.match(/CREATE OR REPLACE FUNCTION public\.block_tombstoned_account_write\(\)[\s\S]*?\$\$;/)[0],
    );
    const roles = await read('../migrations/20261010154000_chat_membership_question_and_crew_removal.sql');
    await pool.query(roles.match(/CREATE OR REPLACE FUNCTION public\.is_chat_moderator\([\s\S]*?\$\$;/)[0]);
    await pool.query(reviewMigration);
    const oldFunctions = (
        await pool.query(
            "select oid::regprocedure::text signature,pg_get_functiondef(oid) body from pg_proc where oid in('public.community_reviews(text,jsonb)'::regprocedure,'public.community_review_photo(text,uuid,jsonb)'::regprocedure,'public.account_deletion_storage_inventory(uuid)'::regprocedure,'public.block_tombstoned_storage_write()'::regprocedure) order by 1",
        )
    ).rows;
    await pool.query(migration);
    eq(
        (
            await pool.query(
                "select oid::regprocedure::text signature,pg_get_functiondef(oid) body from pg_proc where oid in('public.community_reviews(text,jsonb)'::regprocedure,'public.community_review_photo(text,uuid,jsonb)'::regprocedure,'public.account_deletion_storage_inventory(uuid)'::regprocedure,'public.block_tombstoned_storage_write()'::regprocedure) order by 1",
            )
        ).rows,
        oldFunctions,
        'old review/photo RPC and both deletion bodies byte-identical',
    );
    await pool.query(
        'create trigger account_deletion_write_fence before insert or update on storage.objects for each row execute function public.block_tombstoned_storage_write()',
    );
    await pool.query('insert into auth.users values($1,false),($2,false),($3,false),($4,true)', [a, b, mod, anonUser]);
    await pool.query("insert into public.chat_roles values($1,'moderator',false)", [mod]);
    for (const table of [
        'chart_notes',
        'chart_note_votes',
        'chart_note_reports',
        'chart_note_moderation',
        'chart_vote_quota',
    ]) {
        eq(
            (
                await pool.query('select relrowsecurity from pg_class where oid=$1::regclass', [
                    'community_private.' + table,
                ])
            ).rows[0].relrowsecurity,
            true,
            table + ' RLS',
        );
        for (const u of [null, a, mod])
            await rejects(
                async () => {
                    const c = await connect(u, u ? 'authenticated' : 'anon');
                    try {
                        await c.query('select * from community_private.' + table);
                    } finally {
                        await done(c);
                    }
                },
                /permission denied/,
                table + ' raw isolation',
            );
    }
    eq(
        (await pool.query("select count(*)::int n from pg_publication_tables where schemaname='community_private'"))
            .rows[0].n,
        0,
        'no private Realtime',
    );
    eq(
        (
            await pool.query(
                "select has_function_privilege('authenticated','public.community_chart_photo(text,uuid,jsonb)','execute') allowed",
            )
        ).rows[0].allowed,
        false,
        'photo service only',
    );
    eq(
        (
            await pool.query(
                "select has_function_privilege('service_role','community_private.chart_note_public(uuid,uuid)','execute') allowed",
            )
        ).rows[0].allowed,
        false,
        'helper cannot publish guessed ID',
    );
    await rejects(() => call(null, 'save', draft), /Sign in/, 'anonymous cannot create');
    await rejects(() => call(anonUser, 'save', draft), /Sign in/, 'anonymous auth cannot create');
    await rejects(() => call(a, 'save', { ...draft, public_consent: '' }), /consent/, 'pin publication explicit');
    for (const extra of [
        { latitude: 86 },
        { longitude: 181 },
        { kind: 'official' },
        { message: 'x'.repeat(1201) },
        { observed_date: '1900-01-01' },
    ])
        await rejects(
            () => call(a, 'save', { ...draft, ...extra }),
            /constraint|characters|date/i,
            'bounds ' + JSON.stringify(extra).slice(0, 50),
        );
    for (const box of [
        [150, -28, 155, -26],
        [154, -28, 152, -26],
        ['NaN', -28, 154, -26],
        [152, -90, 154, -26],
    ])
        await rejects(() => call(null, 'list', { bbox: box }), /Zoom|bounded/, 'bounded viewport');
    let saved = await call(a, 'save', { ...draft, owner_id: b, status: 'visible', reviewed: true });
    let n = (await listing())[0];
    eq(n.id, saved.id, 'actual visible note');
    eq(
        Object.keys(n).sort(),
        [
            'id',
            'revision',
            'kind',
            'latitude',
            'longitude',
            'message',
            'observed_date',
            'expires_at',
            'confirms',
            'denies',
            'my_vote',
            'mine',
            'reviewed',
            'photo_id',
        ].sort(),
        'exact public projection',
    );
    eq(n.reviewed, false, 'client cannot self-review');
    eq(Date.parse(n.expires_at) - Date.parse(n.observed_date), 30 * 86400000, 'fixed expiry');
    eq(await call(b, 'mine', { id: n.id }), null, 'other owner cannot edit');
    await rejects(
        () => call(a, 'vote', { id: n.id, revision: n.revision, choice: 'confirm' }),
        /Voting/,
        'self vote refused',
    );
    const clocks = (
        await pool.query('select observed_date,expires_at,updated_at from community_private.chart_notes where id=$1', [
            n.id,
        ])
    ).rows[0];
    await call(b, 'vote', { id: n.id, revision: n.revision, choice: 'confirm' });
    await call(b, 'vote', { id: n.id, revision: n.revision, choice: 'confirm' });
    eq((await listing())[0].confirms, 1, 'one vote per actor');
    eq((await listing(b))[0].my_vote, 'confirm', 'only own choice exposed');
    await call(b, 'vote', { id: n.id, revision: n.revision, choice: 'deny' });
    eq([(await listing())[0].confirms, (await listing())[0].denies], [0, 1], 'choice replacement');
    await call(b, 'vote', { id: n.id, revision: n.revision, choice: 'withdraw' });
    eq((await listing())[0].denies, 0, 'withdraw');
    eq(
        (
            await pool.query(
                'select observed_date,expires_at,updated_at from community_private.chart_notes where id=$1',
                [n.id],
            )
        ).rows[0],
        clocks,
        'votes do not renew any note clock',
    );
    await call(b, 'vote', { id: n.id, revision: n.revision, choice: 'confirm' });
    await age();
    const edited = await call(a, 'save', { ...draft, id: n.id, revision: n.revision, message: 'Changed observation.' });
    await rejects(
        () => call(b, 'vote', { id: n.id, revision: n.revision, choice: 'deny' }),
        /changed/,
        'stale vote revision rejected',
    );
    eq((await listing())[0].confirms, 0, 'edit invalidates old votes');
    await rejects(
        () => call(b, 'save', { ...draft, id: n.id, revision: edited.revision }),
        /Owner/,
        'other owner cannot overwrite',
    );
    await rejects(() => call(b, 'delete', { id: n.id }), /Owner/, 'other owner cannot delete');
    const notePhoto = await photo(a, 'reserve', { note_id: n.id, revision: edited.revision });
    await photo(a, 'finish', { id: notePhoto.id, bytes: 100, digest: 'a'.repeat(64) });
    for (const uid of [a, b, mod])
        for (const action of ['access', 'finish'])
            await rejects(
                () => oldPhoto(uid, action, { id: notePhoto.id, bytes: 100, digest: 'a'.repeat(64) }),
                /Photo unavailable/,
                'old API cannot expose note photo ' + action,
            );
    await rejects(
        () => oldPhoto(a, 'reserve', { review_id: n.id, revision: edited.revision }),
        /Review unavailable/,
        'old reserve cannot attach note UUID',
    );
    eq((await listing())[0].photo_id, null, 'pending photo absent publicly');
    await photo(a, 'access', { id: notePhoto.id });
    checks++;
    await photo(mod, 'access', { id: notePhoto.id });
    checks++;
    await rejects(() => photo(b, 'access', { id: notePhoto.id }), /Photo unavailable/, 'pending private');
    const queued = (await call(mod, 'queue')).queue.find((q) => q.id === n.id);
    await moderate(n.id, 'approve-photo', { photo_id: notePhoto.id, photo_revision: queued.photo_revision });
    eq((await listing())[0].photo_id, notePhoto.id, 'only approved photo published');
    await photo(b, 'access', { id: notePhoto.id });
    checks++;
    await rejects(
        () => oldPhoto(mod, 'access', { id: notePhoto.id }),
        /Photo unavailable/,
        'old moderator path still cannot reveal approved note photo',
    );
    const old = await oldCall(a, 'save', {
        place_id: 'osm-node12345',
        kind: 'anchorage',
        holding: 'good',
        protection: [],
        swell: 'calm',
        facilities: [],
        notes: 'Old client circle remains a review.',
        terms_version: '2026-10-17',
    });
    const oldP = await oldPhoto(a, 'reserve', { review_id: old.id, revision: old.revision });
    await oldPhoto(a, 'finish', { id: oldP.id, bytes: 100, digest: 'b'.repeat(64) });
    await rejects(
        () => photo(mod, 'access', { id: oldP.id }),
        /Photo unavailable/,
        'new API cannot reveal old review photo',
    );
    await rejects(
        () => photo(a, 'reserve', { note_id: old.id, revision: old.revision }),
        /Community note unavailable/,
        'new reserve cannot attach review UUID',
    );
    await rejects(() => call(b, 'queue'), /Moderator/, 'queue role enforced');
    await call(b, 'report', { id: n.id, reason: 'privacy' });
    eq(await listing(), [], 'report removes public note immediately');
    await rejects(
        () => photo(b, 'access', { id: notePhoto.id }),
        /Photo unavailable/,
        'report withdraws approved photo',
    );
    await rejects(
        () => call(mod, 'moderate', { id: n.id, revision: edited.revision, decision: 'approve' }),
        /changed/,
        'stale moderation refused',
    );
    await age();
    let own = await mine(n.id);
    const heldEdit = await call(a, 'save', {
        ...draft,
        id: n.id,
        revision: own.revision,
        message: 'Edited while held.',
    });
    eq(heldEdit.status, 'held', 'owner cannot self-clear a report');
    await moderate(n.id, 'approve');
    await call(b, 'block', { id: n.id });
    eq(await listing(b), [], 'block filters same contributor');
    eq((await listing()).length, 1, 'anonymous projection not account-linked');
    await pool.query('delete from community_private.review_blocks where owner_id=$1', [b]);
    // A moderator holds the actual author fence. A competing vote refuses instead of deadlocking.
    own = await mine(n.id);
    await age();
    const locker = await connect(mod);
    await locker.query('begin');
    await locker.query('select public.community_chart_notes($1,$2::jsonb)', [
        'moderate',
        { id: n.id, revision: own.revision, decision: 'approve' },
    ]);
    await rejects(
        () => call(b, 'vote', { id: n.id, revision: own.revision, choice: 'confirm' }),
        /busy/,
        'cross-owner vote race refuses',
    );
    races.push('moderation→busy vote refusal');
    const waiter = await connect(a),
        pid = (await waiter.query('select pg_backend_pid() pid')).rows[0].pid;
    const waiting = waiter.query('select public.community_chart_notes($1,$2::jsonb)', [
        'save',
        { ...draft, id: n.id, revision: own.revision, message: 'Owner edit after held moderator fence.' },
    ]);
    waiting.catch(() => {});
    await blocked(pid);
    await locker.query('commit');
    await waiting;
    await done(waiter);
    await done(locker);
    races.push('moderation→blocking-proven owner edit');
    own = await mine(n.id);
    const late = await photo(a, 'reserve', { note_id: n.id, revision: own.revision });
    const reporter = await connect(b);
    await reporter.query('begin');
    await reporter.query('select public.community_chart_notes($1,$2::jsonb)', [
        'report',
        { id: n.id, reason: 'unsafe' },
    ]);
    const finisher = await connect(null, 'service_role'),
        fpid = (await finisher.query('select pg_backend_pid() pid')).rows[0].pid;
    const finishing = finisher.query('select public.community_chart_photo($1,$2,$3::jsonb)', [
        'finish',
        a,
        { id: late.id, bytes: 100, digest: 'c'.repeat(64) },
    ]);
    finishing.catch(() => {});
    await blocked(fpid);
    await reporter.query('commit');
    await rejects(() => finishing, /Upload retired/, 'report wins late photo finish');
    await done(finisher);
    await done(reporter);
    races.push('report→blocking-proven photo finish refusal');
    // Expiry is derived from observation, not edit/vote/moderation. No stale API can revive it.
    await pool.query(
        "update community_private.chart_notes set observed_date=$2::date-30,expires_at=($2::date)::timestamp at time zone 'UTC' where id=$1",
        [n.id, today],
    );
    await rejects(
        async () => call(b, 'vote', { id: n.id, revision: (await mine(n.id)).revision, choice: 'confirm' }),
        /unavailable/,
        'expired vote held',
    );
    await rejects(
        async () => call(mod, 'moderate', { id: n.id, revision: (await mine(n.id)).revision, decision: 'approve' }),
        /unavailable/,
        'expired moderation held',
    );
    eq(await listing(), [], 'expired not public');
    eq(
        (await call(mod, 'queue')).queue.some((q) => q.id === n.id),
        false,
        'expired not in moderation queue',
    );
    const live = await call(a, 'save', { ...draft, message: 'Deletion reach fixture.' });
    const orphan = await photo(a, 'reserve', { note_id: live.id, revision: live.revision });
    await photo(a, 'finish', { id: orphan.id, bytes: 100, digest: 'd'.repeat(64) });
    await pool.query("insert into storage.objects(bucket_id,name,owner_id)values('community-review-photos',$1,null)", [
        orphan.path,
    ]);
    await call(a, 'delete', { id: live.id });
    eq(
        (
            await pool.query('select chart_note_id,review_id from community_private.review_photos where id=$1', [
                orphan.id,
            ])
        ).rows[0],
        { chart_note_id: null, review_id: null },
        'orphan retains charged private journal',
    );
    for (const uid of [a, mod]) {
        await rejects(() => photo(uid, 'access', { id: orphan.id }), /Photo unavailable/, 'new orphan inaccessible');
        await rejects(
            () => oldPhoto(uid, 'access', { id: orphan.id }),
            /Photo unavailable/,
            'old null review_id inaccessible',
        );
    }
    const count = (
        await pool.query('select count(*)::int n from community_private.review_photos where owner_id=$1', [a])
    ).rows[0].n;
    await pool.query(
        "with ids as materialized(select gen_random_uuid() id from generate_series(1,$2::integer)) insert into community_private.review_photos(id,owner_id,review_revision,object_path,status) select id,$1::uuid,gen_random_uuid(),$1::uuid::text||'/'||id::text||'.jpg','removed' from ids",
        [a, 40 - count],
    );
    const limited = await call(a, 'save', { ...draft, message: 'Shared quota fixture.' });
    await rejects(
        () => photo(a, 'reserve', { note_id: limited.id, revision: limited.revision }),
        /quota/,
        'same 40 reservations include review and note orphans',
    );
    await rejects(
        () => oldPhoto(a, 'reserve', { review_id: old.id, revision: old.revision }),
        /quota/,
        'old API sees same quota',
    );
    const voter = await call(b, 'save', { ...draft, message: 'Tombstone fixture.' });
    await call(a, 'vote', { id: voter.id, revision: voter.revision, choice: 'confirm' });
    await pool.query('insert into public.account_deletion_jobs values($1)', [a]);
    eq(
        (await listing()).some((q) => q.id === limited.id),
        false,
        'author tombstone hidden',
    );
    eq((await listing()).find((q) => q.id === voter.id).confirms, 0, 'voter tombstone excluded');
    await rejects(() => call(a, 'owned'), /Account unavailable/, 'tombstoned requester cannot read own content');
    await rejects(
        () => call(a, 'vote', { id: voter.id, revision: voter.revision, choice: 'deny' }),
        /Account unavailable/,
        'tombstoned voter cannot act',
    );
    await rejects(
        () => photo(a, 'access', { id: orphan.id }),
        /Account unavailable/,
        'tombstoned photo requester cannot read',
    );
    await rejects(
        () => photo(mod, 'access', { id: notePhoto.id }),
        /Photo unavailable/,
        'author tombstone hides even moderator old note photo',
    );
    await rejects(
        () => call(mod, 'moderate', { id: limited.id, revision: limited.revision, decision: 'approve' }),
        /unavailable/,
        'stale moderator cannot revive tombstoned author',
    );
    await rejects(
        () =>
            pool.query("insert into storage.objects(bucket_id,name)values('community-review-photos',$1)", [
                a + '/late.jpg',
            ]),
        /permanently write-fenced/,
        'late Storage write blocked',
    );
    eq(
        (await pool.query('select * from public.account_deletion_storage_inventory($1)', [a])).rows.some(
            (r) => r.object_name === orphan.path,
        ),
        true,
        'existing deletion reaches service-owned note object',
    );
    await pool.query('delete from auth.users where id=$1', [a]);
    for (const table of ['chart_notes', 'chart_note_votes', 'chart_note_reports', 'chart_vote_quota', 'review_photos'])
        eq(
            (await pool.query('select count(*)::int n from community_private.' + table + ' where owner_id=$1', [a]))
                .rows[0].n,
            0,
            'account cascade ' + table,
        );
    eq(
        (
            await pool.query(
                'select count(*)::int n from community_private.chart_note_moderation m join community_private.chart_notes n on n.id=m.note_id where n.owner_id=$1',
                [a],
            )
        ).rows[0].n,
        0,
        'queue cascades',
    );
    eq(
        (await pool.query('select * from public.account_deletion_storage_inventory($1)', [a])).rows.some(
            (r) => r.object_name === orphan.path,
        ),
        true,
        'object inventory survives row deletion',
    );
    console.log(
        JSON.stringify(
            {
                engine: 'PostgreSQL',
                version: pre.version,
                checks,
                races,
                migrationSha256: createHash('sha256').update(migration).digest('hex'),
                baselineFunctionSha256: oldFunctions.map((f) => ({
                    signature: f.signature,
                    sha256: createHash('sha256').update(f.body).digest('hex'),
                })),
                liveChanges: false,
            },
            null,
            2,
        ),
    );
} finally {
    for (const c of [...clients]) await done(c).catch(() => {});
    await pool.end();
}
