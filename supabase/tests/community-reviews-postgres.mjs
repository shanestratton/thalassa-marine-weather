/** Actual PostgreSQL17.6, exact empty localhost fixture only. No product credentials. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const exact = 'postgresql://postgres:fixture-only-password@127.0.0.1:5432/community_reviews140_test';
if (
    process.env.THALASSA_DISPOSABLE_COMMUNITY_TEST !== '1' ||
    process.env.COMMUNITY_TEST_DATABASE_URL !== exact ||
    !process.env.PG_MODULE_PATH ||
    Object.keys(process.env).some((k) => /^PG/i.test(k) && k !== 'PG_MODULE_PATH' && process.env[k]) ||
    process.env.DATABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_SERVICE_ROLE_KEY
)
    throw Error('Exact disposable localhost community fixture required');
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
const migration = await read('../migrations/20261017010813_community_place_reviews.sql');
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
        return (await c.query('select public.community_reviews($1,$2::jsonb) v', [action, input])).rows[0].v;
    } finally {
        await done(c);
    }
}
async function photo(uid, action, input) {
    const c = await connect(null, 'service_role');
    try {
        return (await c.query('select public.community_review_photo($1,$2,$3::jsonb) v', [action, uid, input])).rows[0]
            .v;
    } finally {
        await done(c);
    }
}
async function rejects(fn, rx, label) {
    await assert.rejects(fn, rx, label);
    checks++;
}
const draft = {
    place_id: 'osm-node12345',
    kind: 'anchorage',
    holding: 'good',
    protection: ['N', 'NW'],
    swell: 'some',
    facilities: ['water'],
    notes: 'Observed sand. Check local conditions.',
    visited: '2026-10-01',
    terms_version: '2026-10-17',
    owner_id: b,
    status: 'visible',
    reviewed: true,
};
async function age() {
    await pool.query("update community_private.place_reviews set updated_at=now()-interval '10 seconds'");
}
async function queueRow(id) {
    return (await call(mod, 'queue')).queue.find((r) => r.id === id);
}
async function moderate(id, decision, extra = {}) {
    const r = await queueRow(id);
    return call(mod, 'moderate', { id, revision: r.revision, decision, ...extra });
}
async function blocked(pid) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
        const r = await pool.query('select cardinality(pg_blocking_pids($1))>0 blocked', [pid]);
        if (r.rows[0].blocked) return;
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
    eq(pre.occupied, false, 'empty fixture');
    checks++;
    await pool.query(await read('./community-reviews-base.sql'));
    const fence = await read('../migrations/20261005160000_tombstone_fence_fails_closed.sql');
    const actualFence = fence.match(
        /CREATE OR REPLACE FUNCTION public\.block_tombstoned_account_write\(\)[\s\S]*?\$\$;/,
    )?.[0];
    assert.ok(actualFence);
    await pool.query(actualFence);
    const roles = await read('../migrations/20261010154000_chat_membership_question_and_crew_removal.sql');
    const actualMod = roles.match(/CREATE OR REPLACE FUNCTION public\.is_chat_moderator\([\s\S]*?\$\$;/)?.[0];
    assert.ok(actualMod);
    await pool.query(actualMod);
    await pool.query(migration);
    await pool.query(
        'create trigger account_deletion_write_fence before insert or update on storage.objects for each row execute function public.block_tombstoned_storage_write()',
    );
    await pool.query('insert into auth.users values($1,false),($2,false),($3,false),($4,true)', [a, b, mod, anonUser]);
    await pool.query("insert into public.chat_roles values($1,'moderator',false)", [mod]);
    eq(
        (
            await pool.query(
                "select relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='community_private' and relkind='r'",
            )
        ).rows.every((r) => r.relrowsecurity),
        true,
        'all private RLS',
    );
    eq(
        (await pool.query("select count(*)::int n from pg_publication_tables where schemaname='community_private'"))
            .rows[0].n,
        0,
        'no private Realtime',
    );
    eq(
        (
            await pool.query(
                "select public,file_size_limit,allowed_mime_types from storage.buckets where id='community-review-photos'",
            )
        ).rows[0],
        { public: false, file_size_limit: '1048576', allowed_mime_types: ['image/jpeg'] },
        'bounded private JPEG bucket',
    );
    for (const role of ['anon', 'authenticated']) {
        const c = await connect(a, role);
        try {
            await rejects(
                () => c.query('select * from community_private.place_reviews'),
                /permission denied/,
                'no direct raw projection',
            );
            await rejects(
                () => c.query('select public.community_review_photo($1,$2,$3)', ['access', a, {}]),
                /permission denied/,
                'service image API only',
            );
        } finally {
            await done(c);
        }
    }
    await rejects(() => call(null, 'save', draft), /Sign in required/, 'anonymous cannot write');
    await rejects(() => call(anonUser, 'save', draft), /Sign in required/, 'anonymous sign-in cannot publish');
    await rejects(() => photo(anonUser, 'reserve', {}), /Account unavailable/, 'anonymous photo denied');
    await rejects(() => call(b, 'queue'), /Moderator required/, 'role table required');
    await rejects(
        () => call(a, 'save', { ...draft, terms_version: 'old' }),
        /Accept user content terms/,
        'consent required',
    );
    await rejects(
        () => call(a, 'save', { ...draft, place_id: 'chart:licensed-private' }),
        /check constraint/,
        'chart IDs refused',
    );
    await rejects(() => call(a, 'save', { ...draft, notes: 'x'.repeat(1201) }), /1200/, 'text bound');
    const first = await call(a, 'save', draft);
    const id = first.id;
    await pool.query('update community_private.review_write_quota set operations=40 where owner_id=$1', [a]);
    await rejects(
        () => call(a, 'save', { ...draft, revision: first.revision }),
        /check constraint/,
        'atomic successful-write quota',
    );
    await pool.query('update community_private.review_write_quota set operations=1 where owner_id=$1', [a]);
    eq((await call(a, 'mine', { place_id: draft.place_id })).reviewed, false, 'forged moderation ignored');
    eq(await call(b, 'mine', { place_id: draft.place_id }), null, 'owner not transferable');
    const visible = await call(null, 'list', { place_id: draft.place_id });
    eq(visible.reviews.length, 1, 'ordinary text post-moderated');
    eq(
        Object.keys(visible.reviews[0]).sort(),
        [
            'facilities',
            'holding',
            'id',
            'notes',
            'photo_id',
            'protection',
            'reviewed',
            'swell',
            'updated_at',
            'visited',
        ],
        'exact public whitelist',
    );
    eq(JSON.stringify(visible).includes(a), false, 'no owner/GPS/path public projection');
    eq(visible.reviews[0].photo_id, null, 'no pending photo projected');
    await rejects(() => call(b, 'delete', { id }), /Owner required/, 'other owner delete denied');
    const pending = await photo(a, 'reserve', { review_id: id, revision: first.revision });
    await rejects(() => photo(b, 'access', { id: pending.id }), /Photo unavailable/, 'uploading invisible');
    const ready = await photo(a, 'finish', { id: pending.id, bytes: 100, digest: 'a'.repeat(64) });
    eq(ready.status, 'pending', 'no self approval');
    await rejects(() => photo(b, 'access', { id: pending.id }), /Photo unavailable/, 'pending inaccessible');
    eq((await photo(a, 'access', { id: pending.id })).path, pending.path, 'owner may preview sanitized pending');
    eq((await photo(mod, 'access', { id: pending.id })).id, pending.id, 'moderator may preview');
    eq((await call(null, 'list', { place_id: draft.place_id })).reviews[0].photo_id, null, 'pending not public');
    let row = await queueRow(id);
    await moderate(id, 'approve-photo', { photo_id: row.photo_id, photo_revision: row.photo_revision });
    eq(
        (await photo(b, 'access', { id: pending.id })).id,
        pending.id,
        'approved accessible with fresh authenticated check',
    );
    const storageClient = await connect(a);
    await pool.query(
        "insert into storage.objects(bucket_id,name,owner_id) values('community-review-photos',$1,null),('diary-photos',$2,null)",
        [pending.path, a + '/legacy-photo.jpg'],
    );
    try {
        eq(
            (await storageClient.query("select * from storage.objects where bucket_id='community-review-photos'")).rows,
            [],
            'Storage direct read denied',
        );
        eq(
            (await storageClient.query("select * from storage.objects where bucket_id='diary-photos'")).rows.length,
            1,
            'unrelated legacy Storage policy remains effective',
        );
        await rejects(
            () =>
                storageClient.query(
                    "insert into storage.objects(bucket_id,name) values('community-review-photos',$1)",
                    [pending.path],
                ),
            /row-level security/,
            'legacy permissive Storage cannot bypass restrictive policy',
        );
    } finally {
        await done(storageClient);
    }
    await call(b, 'report', { id, reason: 'privacy' });
    eq((await call(null, 'list', { place_id: draft.place_id })).reviews, [], 'report atomically withdraws public text');
    await rejects(() => photo(b, 'access', { id: pending.id }), /Photo unavailable/, 'report withdraws approved photo');
    await rejects(
        () => call(mod, 'moderate', { id, revision: first.revision, decision: 'approve' }),
        /Review changed/,
        'stale moderator CAS',
    );
    await age();
    const held = await call(a, 'save', {
        ...draft,
        revision: (await call(a, 'mine', { place_id: draft.place_id })).revision,
        notes: 'Edited while held.',
    });
    eq(held.status, 'held', 'owner edit cannot clear report');
    await moderate(id, 'approve');
    await call(b, 'block', { id });
    eq((await call(b, 'list', { place_id: draft.place_id })).reviews, [], 'personal contributor block');
    eq((await call(null, 'list', { place_id: draft.place_id })).reviews.length, 1, 'block is viewer scoped');
    await age();
    const second = await call(a, 'save', {
        ...draft,
        revision: (await call(a, 'mine', { place_id: draft.place_id })).revision,
        notes: 'Second version.',
    });
    await moderate(id, 'remove');
    await age();
    const removedEdit = await call(a, 'save', {
        ...draft,
        revision: second.revision,
        notes: 'Cannot self-unhold removal.',
    });
    eq(removedEdit.status, 'held', 'moderator removal cannot self-clear');
    await moderate(id, 'approve');
    // Real competing RPCs: cross-owner report refuses a busy owner fence rather than deadlocking.
    const fresh = await photo(a, 'reserve', { review_id: id, revision: removedEdit.revision });
    await photo(a, 'finish', { id: fresh.id, bytes: 100, digest: 'b'.repeat(64) });
    row = await queueRow(id);
    await age();
    const locker = await connect(mod);
    await locker.query('begin');
    await locker.query('select public.community_reviews($1,$2)', [
        'moderate',
        {
            id,
            revision: row.revision,
            photo_id: row.photo_id,
            photo_revision: row.photo_revision,
            decision: 'approve-photo',
        },
    ]);
    const reporter = await connect(b);
    await rejects(
        () => reporter.query('select public.community_reviews($1,$2)', ['report', { id, reason: 'unsafe' }]),
        /Review busy; retry/,
        'cross-owner race refuses instead of deadlocking',
    );
    await done(reporter);
    races.push('approval→busy report refusal');
    // Same-owner edit really blocks behind the moderator's held owner fence, then retires approved photo.
    const waiter = await connect(a);
    const waiterPid = (await waiter.query('select pg_backend_pid() pid')).rows[0].pid;
    const waiting = waiter.query('select public.community_reviews($1,$2)', [
        'save',
        { ...draft, revision: removedEdit.revision, notes: 'Concurrent owner edit after moderation.' },
    ]);
    await blocked(waiterPid);
    await locker.query('commit');
    await waiting;
    await done(locker);
    await done(waiter);
    races.push('approval→blocking-proven owner edit');
    await rejects(
        () => photo(b, 'access', { id: fresh.id }),
        /Photo unavailable/,
        'new edit retires prior approved photo',
    );
    await call(b, 'report', { id, reason: 'unsafe' });
    eq((await call(null, 'list', { place_id: draft.place_id })).reviews, [], 'waiting report wins visibility');
    await rejects(() => photo(b, 'access', { id: fresh.id }), /Photo unavailable/, 'waiting report wins photo');
    await moderate(id, 'approve');
    const beforeReport = await call(a, 'mine', { place_id: draft.place_id });
    const lateUpload = await photo(a, 'reserve', { review_id: id, revision: beforeReport.revision });
    const reportLock = await connect(b);
    await reportLock.query('begin');
    await reportLock.query('select public.community_reviews($1,$2)', ['report', { id, reason: 'privacy' }]);
    const finisher = await connect(null, 'service_role');
    const finishPid = (await finisher.query('select pg_backend_pid() pid')).rows[0].pid;
    const finishing = finisher.query('select public.community_review_photo($1,$2,$3)', [
        'finish',
        a,
        { id: lateUpload.id, bytes: 100, digest: 'c'.repeat(64) },
    ]);
    finishing.catch(() => {});
    await blocked(finishPid);
    await reportLock.query('commit');
    await rejects(() => finishing, /Upload retired/, 'report wins blocked upload finalization');
    await done(reportLock);
    await done(finisher);
    races.push('report→blocking-proven photo finish refusal');
    // Forty recorded reservations includes retired/orphan slots; deleting a review cannot reset it.
    await pool.query(
        "with ids as materialized(select gen_random_uuid() id from generate_series(1,37)) insert into community_private.review_photos(id,owner_id,review_id,review_revision,object_path,status) select id,$1,$2,$3,$1::text||'/'||id::text||'.jpg','removed' from ids",
        [a, id, (await call(a, 'mine', { place_id: draft.place_id })).revision],
    );
    await rejects(
        async () =>
            photo(a, 'reserve', {
                review_id: id,
                revision: (await call(a, 'mine', { place_id: draft.place_id })).revision,
            }),
        /Photo quota/,
        'retired photo reservations remain bounded',
    );
    // Real deletion reach: service-owned object owner_id is null; owner prefix still inventories and fences it.
    await pool.query("insert into storage.objects(bucket_id,name,owner_id) values('community-review-photos',$1,null)", [
        fresh.path,
    ]);
    const inv = (await pool.query('select * from public.account_deletion_storage_inventory($1)', [a])).rows;
    eq(
        inv.some((x) => x.object_name === fresh.path && x.source === 'owner-path'),
        true,
        'server upload inventory reach',
    );
    await pool.query('insert into public.account_deletion_jobs values($1)', [a]);
    const ownDelete = await call(b, 'save', { ...draft, place_id: 'osm-way777', notes: 'Owner deletion fixture.' });
    await call(b, 'delete', { id: ownDelete.id });
    eq(
        (await call(null, 'list', { place_id: 'osm-way777' })).reviews,
        [],
        'owner deletion withdraws public projection',
    );
    const banned = await call(b, 'save', {
        ...draft,
        place_id: 'osm-way888',
        notes: 'Contributor suspension fixture.',
    });
    await moderate(banned.id, 'ban');
    eq(
        (await call(null, 'list', { place_id: 'osm-way888' })).reviews,
        [],
        'moderator contributor suspension withdraws notes',
    );
    await rejects(
        () => call(b, 'save', { ...draft, place_id: 'osm-way999' }),
        /Posting is suspended/,
        'suspended contributor cannot republish',
    );
    await rejects(
        () => call(a, 'save', { ...draft, revision: removedEdit.revision }),
        /Account unavailable/,
        'tombstone write denied',
    );
    await rejects(() => photo(a, 'access', { id: fresh.id }), /Account unavailable/, 'tombstone stale token denied');
    await rejects(
        () =>
            pool.query("insert into storage.objects(bucket_id,name) values('community-review-photos',$1)", [
                a + '/late.jpg',
            ]),
        /permanently write-fenced/,
        'service late storage upload fenced',
    );
    eq((await call(null, 'list', { place_id: draft.place_id })).reviews, [], 'tombstone not public');
    await pool.query('delete from auth.users where id=$1', [a]);
    for (const table of [
        'place_reviews',
        'review_photos',
        'review_reports',
        'review_blocks',
        'review_bans',
        'review_write_quota',
    ])
        eq(
            (await pool.query('select count(*)::int n from community_private.' + table + ' where owner_id=$1', [a]))
                .rows[0].n,
            0,
            'account cascade ' + table,
        );
    eq(
        (await pool.query('select count(*)::int n from community_private.review_moderation')).rows[0].n,
        0,
        'queue cascades',
    );
    eq(
        (await pool.query('select * from public.account_deletion_storage_inventory($1)', [a])).rows.some(
            (x) => x.object_name === fresh.path,
        ),
        true,
        'inventory survives raw row deletion',
    );
    console.log(
        JSON.stringify(
            {
                engine: 'PostgreSQL',
                version: pre.version,
                checks,
                races,
                migrationSha256: createHash('sha256').update(migration).digest('hex'),
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
