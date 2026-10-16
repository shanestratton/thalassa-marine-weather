/** Disposable ACL/state proof only. Never connects to a product database/provider. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const actualPostgres = process.env.THALASSA_DISPOSABLE_OVERDUE_TEST === '1';
let postgresVersion = null;
async function isolatedDatabase() {
    if (!actualPostgres) {
        if (!process.env.PGLITE_MODULE_PATH || process.env.OVERDUE_TEST_DATABASE_URL || process.env.PG_MODULE_PATH)
            throw new Error('Explicit isolated PGlite module or opted-in disposable PostgreSQL fixture required.');
        const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
        return new PGlite();
    }
    const url = new URL(process.env.OVERDUE_TEST_DATABASE_URL ?? 'http://invalid');
    if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.port !== '5432' ||
        url.pathname !== '/overdue137_test' ||
        url.username !== 'postgres' ||
        url.password !== 'fixture-only-password' ||
        url.search ||
        url.hash ||
        !process.env.PG_MODULE_PATH
    )
        throw new Error('Only the explicit empty localhost overdue137_test fixture is allowed.');
    const module = await import(pathToFileURL(process.env.PG_MODULE_PATH).href),
        Client = module.Client ?? module.default.Client;
    const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    await client.connect();
    try {
        const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
        const tables = (
            await client.query("SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname IN ('public','auth')")
        ).rows[0].count;
        postgresVersion = (await client.query('SHOW server_version')).rows[0].server_version;
        if (database !== 'overdue137_test' || tables !== 0 || !/^17\.6(?:\D|$)/.test(postgresVersion))
            throw new Error('Refuse a nonempty or different PostgreSQL fixture.');
        return {
            exec: (sql) => client.query(sql),
            query: (sql, args) => client.query(sql, args),
            close: () => client.end(),
        };
    } catch (error) {
        await client.end();
        throw error;
    }
}
const db = await isolatedDatabase();
const owner = '10000000-0000-4000-8000-000000000001',
    other = '10000000-0000-4000-8000-000000000002',
    boat = '20000000-0000-4000-8000-000000000001',
    foreign = '20000000-0000-4000-8000-000000000002',
    event = '30000000-0000-4000-8000-000000000001',
    session = 'ABCDEFGHJKLM';
let checks = 0;
const eq = (a, b, label) => {
    assert.deepEqual(a, b, label);
    checks++;
};
const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
async function as(role, uid, sql, args = []) {
    await db.exec(`RESET ROLE;SELECT set_config('request.jwt.claim.sub','${uid ?? ''}',false);SET ROLE ${role};`);
    try {
        return await scalar(sql, args);
    } finally {
        await db.exec('RESET ROLE');
    }
}
const user = (sql, args = []) => as('authenticated', owner, sql, args),
    service = (sql, args = []) => as('service_role', null, sql, args);
async function denied(fn, code, label) {
    await assert.rejects(fn, (e) => e.code === code, label);
    checks++;
}
const configuration = (patch = {}) => ({
    channel: 'email',
    label: 'Fictional contact',
    address: 'recipient@example.invalid',
    sharePosition: false,
    enabled: false,
    ...patch,
});
const list = () => user('SELECT public.shore_contacts_list($1)', [boat]);
const save = (id, rev, cfg) =>
    user('SELECT public.configure_shore_contact($1,$2,$3,$4::jsonb)', [
        boat,
        id,
        rev,
        cfg === null ? null : JSON.stringify(cfg),
    ]);
const hash = 'a'.repeat(64),
    revoke = 'b'.repeat(64);
const invite = (r, h = hash, k = revoke) =>
    service('SELECT public.shore_invite($1,$2,$3,$4,$5)', [owner, r.id, r.revision, h, k]);
const consent = (h = hash, action = 'confirm', chat = null, uid = null, bot = null) =>
    service('SELECT public.shore_consent($1,$2,$3,$4,$5)', [h, action, chat, uid, bot]);
const contact = async () => (await list()).contacts[0];
const command = (kind, update, chat = '123', h = null, at = Date.now() - 1000) =>
    service('SELECT public.shore_telegram_command($1,$2,$3,$4,$5,$6,$7)', ['456', chat, chat, update, at, kind, h]);
try {
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
 CREATE TABLE public.boats(id uuid PRIMARY KEY,owner_id uuid REFERENCES auth.users,archived_at timestamptz);
 CREATE TABLE public.anchor_watch_sessions(session_code text PRIMARY KEY,owner_user_id uuid,expires_at timestamptz,vessel_state text,vessel_heartbeat_at timestamptz);
 CREATE TABLE public.anchor_watch_members(session_code text,user_id uuid,role text);
 CREATE TABLE public.pi_diary_relays(relay_id text PRIMARY KEY,owner_id uuid,boat_id uuid,enabled boolean);
 CREATE TABLE public.pi_anchor_sessions(relay_id text,owner_id uuid,session_code text,expires_at timestamptz,last_heartbeat_at timestamptz,authorised_at timestamptz,gps_available boolean,is_dragging boolean);
 CREATE TABLE public.anchor_alarm_events(id uuid PRIMARY KEY,incident_id uuid,session_code text,user_id uuid,pi_relay_id text,alarm_kind text,created_at timestamptz,resolved_at timestamptz);
 CREATE SCHEMA cron;CREATE TABLE cron.job(jobname text,schedule text,command text,active boolean);INSERT INTO cron.job VALUES('shore-anchor-messaging','* * * * *','SELECT public.invoke_edge_function(''anchor-alert-messaging'', 25000, ''{"action":"work"}''::jsonb)',true);
 INSERT INTO auth.users VALUES('${owner}'),('${other}');INSERT INTO public.boats VALUES('${boat}','${owner}',NULL),('${foreign}','${other}',NULL);
 INSERT INTO public.anchor_watch_sessions VALUES('${session}','${owner}',now()+interval '1 day','watching',now());INSERT INTO public.anchor_watch_members VALUES('${session}','${owner}','vessel');
 INSERT INTO public.anchor_alarm_events VALUES('${event}',NULL,'${session}','${owner}',NULL,'drag',now(),NULL);
 CREATE TABLE public.push_notification_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_user_id uuid,notification_type text,title text,body text,data jsonb);CREATE TABLE public.push_device_tokens(user_id uuid,platform text);INSERT INTO public.push_device_tokens VALUES('${owner}','ios');GRANT SELECT ON public.boats TO authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;`);
    await db.exec(
        await readFile(new URL('../held-migrations/20261016174406_shore_contacts.sql', import.meta.url), 'utf8'),
    );
    await db.exec(
        await readFile(new URL('../held-migrations/20261016182715_overdue_watch.sql', import.meta.url), 'utf8'),
    );

    const status = () => user('SELECT public.overdue_watch_status($1)', [boat]);
    const cfg = () => ({
        enabled: false,
        plan: {
            vesselLabel: 'Public fixture yacht',
            from: 'Fixture harbour',
            to: 'Fixture anchorage',
            departureAt: Date.now() - 3600000,
            etaAt: null,
            overdueAt: Date.now() + 3600000,
            persons: 2,
        },
        contacts: [],
        sharePosition: false,
        rescueRegion: null,
    });
    const configure = (expected, c) =>
        user('SELECT public.configure_overdue_watch($1,$2,$3::jsonb)', [boat, expected, JSON.stringify(c)]);
    eq((await status()).ready, false, 'default off, no SQL-only capability');
    eq((await status()).watch, null, 'no previous owner watch');
    await denied(
        () => as('anon', null, 'SELECT public.overdue_watch_status($1)', [boat]),
        '42501',
        'anonymous status denied',
    );
    await denied(
        () => as('authenticated', other, 'SELECT public.overdue_watch_status($1)', [boat]),
        '42501',
        'foreign boat denied',
    );
    await denied(() => user('SELECT * FROM private_overdue.control'), '42501', 'private controls not readable');
    await denied(() => user('SELECT public.overdue_watch_work(NULL)'), '42501', 'worker service only');
    await denied(
        () => user('SELECT public.overdue_owner_attempt($1)', [boat]),
        '42501',
        'owner cannot forge attempted push',
    );
    await denied(() => configure(null, cfg()), '22023', 'empty contacts refused');
    await save(null, null, configuration());
    let c = await contact();
    let plan = { ...cfg(), contacts: [{ id: c.id, revision: c.revision }] };
    let revision = await configure(null, plan);
    eq(typeof revision, 'string', 'disabled draft stores compact plan only');
    await denied(() => configure(null, plan), '40001', 'watch CAS cannot overwrite');
    await denied(
        () => configure(revision, { ...plan, medicalNotes: 'private' }),
        '22023',
        'raw medical/roster/route input refused',
    );
    await denied(() => configure(revision, { ...plan, enabled: true }), '55000', 'held capability refuses arming');
    await db.exec(
        "UPDATE private_shore.control SET enabled=true,email_version=1,telegram_version=1,bot_id='456',entitlement_until=now()+interval '1 day';UPDATE private_overdue.control SET enabled=true,function_version=1,delivery_version=1,entitlement_until=now()+interval '1 day';",
    );
    await service('SELECT public.shore_worker_finish(true)');
    await service('SELECT public.overdue_worker_finish(true)');
    eq((await status()).ready, false, 'fresh tick without reviewed active cron is not ready');
    await db.exec(
        `INSERT INTO cron.job VALUES('overdue-watch','* * * * *','SELECT public.invoke_edge_function(''overdue-watch'', 25000, ''{"action":"work"}''::jsonb)',true)`,
    );
    eq((await status()).ready, true, 'explicit deployed/entitled/scheduled/fresh capability');
    await invite(c);
    await consent();
    c = await contact();
    await save(c.id, c.revision, configuration({ enabled: true }));
    c = await contact();
    plan = { ...plan, enabled: true, contacts: [{ id: c.id, revision: c.revision }] };
    await denied(() => configure(revision, plan), '55000', 'anchor-only consent cannot authorize overdue');
    await save(c.id, c.revision, configuration({ allowOverdue: true }));
    c = await contact();
    eq(c.consent, 'pending', 'new purpose resets recipient consent');
    await db.exec('UPDATE private_shore.contacts SET invited_at=NULL');
    await denied(() => invite(c), '55000', 'old invitation handler cannot authorize unseen overdue purpose');
    const inv = await service('SELECT public.shore_invite($1,$2,$3,$4,$5,2)', [owner, c.id, c.revision, hash, revoke]);
    eq(inv.allowOverdue, true, 'version2 invitation contains exact overdue purpose');
    eq(await consent(), false, 'legacy confirmation cannot grant overdue purpose');
    eq(
        await service('SELECT public.shore_consent($1,$2,NULL,NULL,NULL,2)', [hash, 'confirm']),
        true,
        'explicit current-purpose recipient consent',
    );
    c = await contact();
    await save(c.id, c.revision, configuration({ allowOverdue: true, enabled: true }));
    c = await contact();
    plan = { ...plan, contacts: [{ id: c.id, revision: c.revision }] };
    await db.exec('DELETE FROM public.push_device_tokens');
    await denied(() => configure(revision, plan), '55000', 'no owner push token cannot arm');
    await db.exec(`INSERT INTO public.push_device_tokens VALUES('${owner}','ios')`);
    revision = await configure(revision, plan);
    eq((await status()).watch.configuration.enabled, true, 'explicit owner arming after new recipient consent');
    await service('SELECT public.overdue_watch_work(NULL)');
    eq(await scalar('SELECT count(*)::int FROM public.push_notification_queue'), 0, 'future plan queues nothing');
    await db.exec(
        `UPDATE public.overdue_watches SET configuration=jsonb_set(configuration,'{plan,overdueAt}',to_jsonb(floor(extract(epoch FROM now()-interval '1 second')*1000))) WHERE boat_id='${boat}'`,
    );
    const work = await service('SELECT public.overdue_watch_work(NULL)');
    eq(work.after, boat, 'finite cursor names reviewed boat');
    eq(await scalar('SELECT count(*)::int FROM public.push_notification_queue'), 1, 'owner first only');
    const queue = await scalar('SELECT id FROM public.push_notification_queue');
    eq(
        await scalar('SELECT notification_type FROM public.push_notification_queue'),
        'overdue_notice',
        'distinct ordinary push family',
    );
    eq(
        await scalar("SELECT data ? 'position' OR data ? 'plan' FROM public.push_notification_queue"),
        false,
        'lock-screen queue has no route/position/roster',
    );
    await service('SELECT public.overdue_watch_work(NULL)');
    eq(
        await scalar('SELECT count(*)::int FROM public.push_notification_queue'),
        1,
        'owner incident admission idempotent',
    );
    eq(
        await scalar('SELECT count(*)::int FROM private_overdue.contact_deliveries'),
        0,
        'queue alone never starts grace',
    );
    eq(await service('SELECT public.overdue_owner_current($1)', [queue]), true, 'preflight current check');
    eq((await status()).watch.state.ownerAttemptedAt, null, 'preflight is not HTTP attempt receipt');
    eq(
        await service('SELECT public.overdue_owner_attempt($1)', [queue]),
        true,
        'immediate HTTP boundary records initiated attempt',
    );
    const attempted = (await status()).watch.state.ownerAttemptedAt;
    eq(
        await service('SELECT public.overdue_owner_attempt($1)', [queue]),
        true,
        'same incident may reach another owner device',
    );
    eq((await status()).watch.state.ownerAttemptedAt, attempted, 'first attempt clock never restamped');
    await service('SELECT public.overdue_watch_work(NULL)');
    eq(
        await scalar('SELECT count(*)::int FROM private_overdue.contact_deliveries'),
        0,
        'full ten-minute grace required',
    );
    await db.exec(
        `UPDATE public.overdue_watches SET owner_queued_at=now()-interval '12 minutes',owner_attempted_at=now()-interval '11 minutes',configuration=jsonb_set(configuration,'{plan,overdueAt}',to_jsonb(floor(extract(epoch FROM now()-interval '13 minutes')*1000))) WHERE boat_id='${boat}';UPDATE private_overdue.owner_deliveries SET expires_at=now()-interval '2 minutes'`,
    );
    await service('SELECT public.overdue_watch_work(NULL)');
    eq(
        await scalar('SELECT count(*)::int FROM private_overdue.contact_deliveries'),
        1,
        'after actual attempt plus grace, confirmed personal contact only',
    );
    eq(
        await service('SELECT public.overdue_owner_attempt($1)', [queue]),
        false,
        'expired owner queue cannot initiate another attempt',
    );
    let delivery = await service('SELECT public.overdue_contact_claim()');
    eq(delivery.address, 'recipient@example.invalid', 'fixed stored personal recipient');
    eq(delivery.position, null, 'position off remains null');
    eq(Object.keys(delivery.plan).length, 7, 'compact plan excludes roster and raw waypoints');
    eq(
        await service('SELECT public.overdue_contact_guard($1,$2,$3)', [
            delivery.id,
            delivery.revision,
            delivery.contactRevision,
        ]),
        true,
        'current exact provider guard',
    );
    eq(
        await service('SELECT public.overdue_contact_guard($1,$2,$3)', [
            delivery.id,
            delivery.revision,
            delivery.contactRevision,
        ]),
        false,
        'same provider attempt cannot pass twice',
    );
    await service('SELECT public.overdue_contact_finish($1,$2,false)', [delivery.id, delivery.revision]);
    await db.exec("UPDATE private_overdue.contact_deliveries SET claimed_at=now()-interval '2 minutes'");
    const retry = await service('SELECT public.overdue_contact_claim()');
    eq(retry.id, delivery.id, 'email retries retain idempotency identity');
    eq(retry.plan, delivery.plan, 'email retries retain exact body inputs');
    const ended = await user('SELECT public.end_overdue_watch($1,$2,$3)', [boat, revision, 'arrived']);
    eq((await status()).watch.endReason, 'arrived', 'only explicit owner arrival');
    eq((await status()).watch.configuration.enabled, false, 'arrival turns watch off');
    eq(
        await service('SELECT public.overdue_contact_guard($1,$2,$3)', [
            retry.id,
            retry.revision,
            retry.contactRevision,
        ]),
        false,
        'arrival retires queued provider attempt',
    );
    await denied(
        () => user('SELECT public.end_overdue_watch($1,$2,$3)', [boat, revision, 'cancelled']),
        '40001',
        'old phone cannot cancel replacement',
    );
    eq(
        await as('authenticated', other, 'SELECT count(*)::int FROM public.overdue_watches'),
        0,
        'RLS hides other owner plan',
    );
    await denied(
        () => user('UPDATE public.overdue_watches SET owner_attempted_at=now()'),
        '42501',
        'owner cannot directly forge receipt',
    );
    eq(
        await scalar("SELECT has_function_privilege('anon','public.overdue_owner_attempt(uuid)','EXECUTE')"),
        false,
        'no anonymous attempt door',
    );
    eq(
        await scalar("SELECT has_table_privilege('authenticated','private_overdue.contact_deliveries','SELECT')"),
        false,
        'delivery PII not exposed',
    );

    await db.exec(`CREATE SCHEMA private_weather_watch;
CREATE TABLE private_weather_watch.weather_position_registrations(boat_id uuid PRIMARY KEY,owner_id uuid,relay_id text,revision uuid,enabled boolean);
CREATE TABLE private_weather_watch.weather_position_receipts(boat_id uuid PRIMARY KEY,revision uuid,lat double precision,lon double precision,measured_at timestamptz);
INSERT INTO public.pi_diary_relays VALUES('fixture-relay','${owner}','${boat}',true);
INSERT INTO private_weather_watch.weather_position_registrations VALUES('${boat}','${owner}','fixture-relay','40000000-0000-4000-8000-000000000001',true);
INSERT INTO private_weather_watch.weather_position_receipts VALUES('${boat}','40000000-0000-4000-8000-000000000001',0,0,now());
CREATE FUNCTION private_weather_watch.weather_position_current(boat uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('revision',r.revision,'lat',p.lat,'lon',p.lon,'at',floor(extract(epoch FROM p.measured_at)*1000)) FROM private_weather_watch.weather_position_registrations r JOIN private_weather_watch.weather_position_receipts p ON p.boat_id=r.boat_id AND p.revision=r.revision WHERE r.boat_id=boat AND r.enabled AND p.measured_at>now()-interval '15 minutes' AND p.measured_at<=now()$$;`);
    c = await contact();
    await save(c.id, c.revision, configuration({ allowOverdue: true, sharePosition: true }));
    c = await contact();
    await db.exec('UPDATE private_shore.contacts SET invited_at=NULL');
    await service('SELECT public.shore_invite($1,$2,$3,$4,$5,2)', [owner, c.id, c.revision, hash, revoke]);
    eq(
        await service('SELECT public.shore_consent($1,$2,NULL,NULL,NULL,2)', [hash, 'confirm']),
        true,
        'recipient explicitly permits overdue last-position sharing',
    );
    c = await contact();
    await save(c.id, c.revision, configuration({ allowOverdue: true, sharePosition: true, enabled: true }));
    c = await contact();
    const positionPlan = {
        ...cfg(),
        enabled: true,
        contacts: [{ id: c.id, revision: c.revision }],
        sharePosition: true,
        rescueRegion: 'au',
    };
    const positionRevision = await configure(ended, positionPlan);
    eq((await status()).watch.reviewRequired, false, 'exact current contact and registered source');
    await db.exec("UPDATE private_weather_watch.weather_position_receipts SET measured_at=now()-interval '19 hours'");
    eq((await status()).watch.reviewRequired, false, 'stale fix does not relabel unchanged registered source as new');
    await db.exec(
        `UPDATE public.overdue_watches SET configuration=jsonb_set(configuration,'{plan,overdueAt}',to_jsonb(floor(extract(epoch FROM now()-interval '13 minutes')*1000))) WHERE boat_id='${boat}'`,
    );
    await service('SELECT public.overdue_watch_work(NULL)');
    const positionQueue = await scalar('SELECT queue_id FROM private_overdue.owner_deliveries WHERE revision=$1', [
        positionRevision,
    ]);
    eq(
        await service('SELECT public.overdue_owner_attempt($1)', [positionQueue]),
        true,
        'position unavailable for fresh navigation does not prevent owner warning',
    );
    await db.exec(
        `UPDATE public.overdue_watches SET owner_queued_at=now()-interval '12 minutes',owner_attempted_at=now()-interval '11 minutes' WHERE boat_id='${boat}'`,
    );
    await service('SELECT public.overdue_watch_work(NULL)');
    await db.exec('UPDATE private_shore.quotas SET deliveries=30');
    eq(
        await service('SELECT public.overdue_contact_claim()'),
        { more: true },
        'quota-held work cannot certify drained readiness',
    );
    await db.exec('UPDATE private_shore.quotas SET deliveries=0');
    const positioned = await service('SELECT public.overdue_contact_claim()');
    eq(positioned.position.lat, 0, 'explicit last saved position at0,0 is valid');
    eq(
        positioned.position.at < Date.now() - 18 * 3600000,
        true,
        'old original measurement preserved without restamping',
    );
    await db.exec('UPDATE private_weather_watch.weather_position_registrations SET revision=gen_random_uuid()');
    eq((await status()).watch.reviewRequired, true, 'changed source requires explicit owner review/rearm');
    eq(
        await service('SELECT public.overdue_contact_guard($1,$2,$3)', [
            positioned.id,
            positioned.revision,
            positioned.contactRevision,
        ]),
        false,
        'old source receipt cannot escape after registration change',
    );
    eq(
        await service('SELECT public.overdue_owner_attempt($1)', [positionQueue]),
        false,
        'old owner queue cannot adopt new source',
    );
    await db.exec(
        "UPDATE private_weather_watch.weather_position_registrations SET revision='40000000-0000-4000-8000-000000000001'",
    );
    c = await contact();
    await save(c.id, c.revision, configuration({ allowOverdue: true, enabled: false }));
    eq((await status()).watch.reviewRequired, true, 'recipient pause/revision is visible in watch status');
    eq(
        await service('SELECT public.overdue_contact_guard($1,$2,$3)', [
            positioned.id,
            positioned.revision,
            positioned.contactRevision,
        ]),
        false,
        'recipient revocation/pause retires provider attempt',
    );
    await db.exec(`UPDATE public.boats SET owner_id='${other}' WHERE id='${boat}'`);
    await denied(() => status(), '42501', 'old owner cannot inspect transferred plan');
    const newStatus = await as('authenticated', other, 'SELECT public.overdue_watch_status($1)', [boat]);
    eq(newStatus.watch, null, 'new owner cannot read previous owner compact plan');
    const adopted = await as('authenticated', other, 'SELECT public.configure_overdue_watch($1,NULL,$2::jsonb)', [
        boat,
        JSON.stringify({ ...positionPlan, enabled: false, sharePosition: false }),
    ]);
    eq(typeof adopted, 'string', 'new owner explicit draft retires foreign prior watch instead of adopting it');
    eq(
        await scalar('SELECT count(*)::int FROM private_overdue.owner_deliveries WHERE boat_id=$1', [boat]),
        0,
        'previous owner delivery mapping removed on ownership replacement',
    );
    await db.exec(`UPDATE public.boats SET owner_id='${owner}' WHERE id='${boat}'`);

    for (let i = 0; i < 5; i++) {
        const b = `70000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        await db.query('INSERT INTO public.boats VALUES($1,$2,NULL)', [b, owner]);
        await db.query('INSERT INTO public.overdue_watches(boat_id,owner_id,configuration) VALUES($1,$2,$3::jsonb)', [
            b,
            owner,
            JSON.stringify({ ...cfg(), enabled: true, contacts: [{ id: c.id, revision: c.revision }] }),
        ]);
    }
    await denied(
        () => configure(null, { ...cfg(), enabled: true, contacts: [{ id: c.id, revision: c.revision }] }),
        '54000',
        'new row with null prior state still respects five-active-watch cap',
    );
    await db.exec("DELETE FROM public.boats WHERE id::text LIKE '70000000-%'");
    eq(
        await scalar(
            "SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private_overdue' AND prosecdef AND NOT coalesce(proconfig,'{}') @> ARRAY['search_path=\"\"']",
        ),
        0,
        'all overdue definer paths empty',
    );
    eq(
        await scalar(
            "SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='private_overdue' AND c.relkind='r' AND NOT c.relrowsecurity",
        ),
        0,
        'all private overdue tables have RLS',
    );
    eq(
        await scalar(
            "SELECT has_function_privilege('authenticated','private_overdue.last_position(uuid,uuid,uuid)','EXECUTE')",
        ),
        false,
        'no direct source-position helper for callers',
    );
    eq(
        await scalar(
            "SELECT has_function_privilege('anon','public.configure_overdue_watch(uuid,uuid,jsonb)','EXECUTE')",
        ),
        false,
        'no anonymous watch configuration',
    );
    eq(
        await scalar(
            "SELECT has_function_privilege('authenticated','public.overdue_contact_guard(uuid,uuid,uuid)','EXECUTE')",
        ),
        false,
        'owner cannot authorize provider attempts',
    );
    eq(
        await scalar("SELECT has_table_privilege('authenticated','private_overdue.quotas','SELECT')"),
        false,
        'no private quota-table read surface',
    );
    await db.exec('UPDATE cron.job SET active=false');
    eq((await status()).ready, false, 'stopped cron loses capability');
    await db.exec(
        "UPDATE cron.job SET active=true;UPDATE private_overdue.control SET worker_at=now()-interval '6 minutes'",
    );
    eq((await status()).ready, false, 'stale worker loses capability');
    await db.exec('UPDATE private_overdue.control SET worker_at=now(),delivery_version=0');
    eq((await status()).ready, false, 'missing actual sender integration loses capability');
    eq(typeof ended, 'string', 'termination revision receipt');
    let races = null;
    if (actualPostgres) {
        const module = await import(pathToFileURL(process.env.PG_MODULE_PATH).href),
            Client = module.Client ?? module.default.Client;
        const cohorts = [];
        async function race(name, width, role, uid, holdSql, holdArgs, action) {
            assert(['authenticated', 'service_role'].includes(role));
            const clients = Array.from(
                { length: width },
                () =>
                    new Client({
                        connectionString: process.env.OVERDUE_TEST_DATABASE_URL,
                        connectionTimeoutMillis: 5000,
                        statement_timeout: 15000,
                    }),
            );
            let running = [],
                holding = false;
            try {
                await Promise.all(clients.map((c) => c.connect()));
                const pids = await Promise.all(
                    clients.map(async (c) => {
                        await c.query('BEGIN');
                        await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [uid ?? '']);
                        await c.query(`SET LOCAL ROLE ${role}`);
                        return Object.values((await c.query('SELECT pg_backend_pid()')).rows[0])[0];
                    }),
                );
                eq(new Set(pids).size, width, name + ': distinct actual backends');
                await db.exec('BEGIN');
                holding = true;
                await db.query(holdSql, holdArgs);
                running = clients.map(async (c, i) => {
                    try {
                        const value = await action(c, i);
                        await c.query('COMMIT');
                        return { status: 'fulfilled', value };
                    } catch (e) {
                        await c.query('ROLLBACK');
                        return { status: 'rejected', reason: { code: e.code } };
                    }
                });
                let blocked = 0;
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline) {
                    await db.exec('SELECT pg_stat_clear_snapshot()');
                    blocked = await scalar(
                        "SELECT count(*)::integer FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND state='active' AND wait_event_type='Lock'",
                        [pids],
                    );
                    if (blocked === width) break;
                    await new Promise((r) => setTimeout(r, 20));
                }
                eq(blocked, width, name + ': all contenders overlap behind real database locks');
                await db.exec('COMMIT');
                holding = false;
                const results = await Promise.all(running);
                cohorts.push({ name, backends: width, blocked });
                return results;
            } finally {
                if (holding) await db.exec('ROLLBACK').catch(() => {});
                await Promise.allSettled(running);
                await Promise.allSettled(
                    clients.map(async (c) => {
                        await c.query('ROLLBACK').catch(() => {});
                        await c.end();
                    }),
                );
            }
        }
        const { runOverduePostgresCases } = await import('./overdue-watch-postgres-cases.mjs');
        await runOverduePostgresCases({ db, scalar, service, cfg, configuration, owner, revision, eq, race });
        races = cohorts;
    }
    console.log(
        JSON.stringify({
            engine: actualPostgres ? 'PostgreSQL disposable' : 'PGlite disposable',
            checks,
            postgresVersion,
            races,
            productDatabase: false,
            providerCalls: 0,
        }),
    );
} finally {
    await db.close();
}
