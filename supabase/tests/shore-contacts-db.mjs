/** Disposable ACL/state proof only. Never connects to a product database/provider. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const actualPostgres = process.env.THALASSA_DISPOSABLE_SHORE_TEST === '1';
let postgresVersion = null;
async function isolatedDatabase() {
    if (!actualPostgres) {
        if (
            !process.env.PGLITE_MODULE_PATH ||
            process.env.SHORE_CONTACTS_TEST_DATABASE_URL ||
            process.env.PG_MODULE_PATH
        )
            throw new Error('Explicit isolated PGlite module or opted-in disposable PostgreSQL fixture required.');
        const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
        return new PGlite();
    }
    const url = new URL(process.env.SHORE_CONTACTS_TEST_DATABASE_URL ?? 'http://invalid');
    if (
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.port !== '5432' ||
        url.pathname !== '/shore137_test' ||
        url.username !== 'postgres' ||
        url.password !== 'fixture-only-password' ||
        url.search ||
        url.hash ||
        !process.env.PG_MODULE_PATH
    )
        throw new Error('Only the explicit empty localhost shore137_test fixture is allowed.');
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
        if (database !== 'shore137_test' || tables !== 0 || !/^17\.6(?:\D|$)/.test(postgresVersion))
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
 GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;`);
    await db.exec(
        await readFile(new URL('../migrations/20261016194554_shore_contacts.sql', import.meta.url), 'utf8'),
    );
    eq((await list()).emailReady, false, 'default off');
    eq((await list()).contacts, [], 'empty own hull');
    await denied(
        () => as('anon', null, 'SELECT public.shore_contacts_list($1)', [boat]),
        '42501',
        'anonymous owner API denied',
    );
    await denied(
        () => as('authenticated', other, 'SELECT public.shore_contacts_list($1)', [boat]),
        '42501',
        'foreign hull denied',
    );
    await denied(() => user('SELECT * FROM private_shore.contacts'), '42501', 'PII not directly readable');
    await denied(
        () => user('SELECT public.shore_consent($1,$2)', [hash, 'confirm']),
        '42501',
        'nonce RPC service only',
    );
    await denied(() => save(null, null, configuration({ enabled: true })), '55000', 'cannot start enabled');
    await denied(() => save(null, null, configuration({ unknown: true })), '22023', 'unknown config key refused');
    await denied(
        () => save(null, null, configuration({ address: 'bad\n@example.invalid' })),
        '22023',
        'header injection refused',
    );
    await save(null, null, configuration());
    let row = await contact();
    eq(row.consent, 'pending', 'save creates no consent');
    await denied(() => invite(row), '55000', 'held provider cannot invite');
    await db.exec(
        "UPDATE private_shore.control SET enabled=true,email_version=1,telegram_version=1,entitlement_until=now()+interval '1 day',bot_id='456'",
    );
    eq((await list()).emailReady, false, 'SQL/function versions are not scheduled/fresh proof');
    await service('SELECT public.shore_worker_finish(true)');
    eq((await list()).emailReady, true, 'scheduled fresh source with explicit entitlement');
    await db.exec('UPDATE cron.job SET active=false');
    eq((await list()).emailReady, false, 'disabled cron cannot claim ready');
    await db.exec('UPDATE cron.job SET active=true');
    const invitation = await invite(row);
    eq(invitation.address, 'recipient@example.invalid', 'service gets exact saved recipient');
    eq(
        await scalar('SELECT count(*)::int FROM private_shore.nonces WHERE hash=$1', [hash]),
        1,
        'only hashed confirmation stored',
    );
    await denied(() => invite(row), '54000', 'recipient invitation cooldown');
    eq(await consent('c'.repeat(64)), false, 'unknown nonce');
    eq(await consent(hash, 'confirm', '123', '123', '456'), false, 'email cannot be telegram-confirmed');
    eq(await consent(), true, 'explicit recipient confirmation');
    eq(await consent(), false, 'one-use nonce');
    row = await contact();
    await save(row.id, row.revision, configuration({ enabled: true }));
    row = await contact();
    eq(row.consent, 'confirmed', 'enable alone preserves consent');
    eq(await consent(revoke, 'revoke'), true, 'revocation token survives owner enable revision');
    eq((await contact()).consent, 'revoked', 'recipient revoke stops contact');
    eq(await consent(revoke, 'revoke'), false, 'revocation one-use');
    await denied(
        () => save(row.id, row.revision, configuration({ enabled: true })),
        '55000',
        'revoked recipient cannot be reenabled',
    );
    row = await contact();
    await save(row.id, row.revision, configuration());
    row = await contact();
    await db.exec('UPDATE private_shore.contacts SET invited_at=NULL');
    await invite(row);
    await db.exec("UPDATE private_shore.nonces SET expires_at=now()-interval '1 second' WHERE kind='confirm'");
    eq(await consent(), false, 'expired consent cannot activate');
    await db.exec('UPDATE private_shore.contacts SET invited_at=NULL');
    await invite(row);
    await consent();
    row = await contact();
    await denied(
        () => save(row.id, row.revision, configuration({ channel: 'telegram', address: null, sharePosition: true })),
        '55000',
        'cannot share guessed/account position',
    );
    await save(row.id, row.revision, configuration({ address: 'other@example.invalid' }));
    eq((await contact()).consent, 'pending', 'recipient change resets consent');
    eq(await consent(revoke, 'revoke'), false, 'old policy nonce retired');
    row = await contact();
    await denied(
        () => save(row.id, '00000000-0000-4000-8000-000000000000', configuration()),
        '40001',
        'no silent stale overwrite',
    );
    await save(row.id, row.revision, configuration({ channel: 'telegram', address: null }));
    row = await contact();
    await db.exec('UPDATE private_shore.contacts SET invited_at=NULL');
    await invite(row);
    eq(await consent(), false, 'Telegram link holder must use verified private chat');
    eq(await command('confirm', 98, '123', hash), null, 'callback without private policy preview refuses');
    eq(await command('preview', 98, '123', 'c'.repeat(64)), null, 'unknown preview nonce refuses');
    eq(
        await command('preview', 99, '123', hash),
        { invitation: { sharePosition: false } },
        'Start previews exact current policy',
    );
    eq((await contact()).consent, 'pending', 'preview is not recipient consent');
    eq(
        await scalar('SELECT used_at FROM private_shore.nonces WHERE hash=$1', [hash]),
        null,
        'preview does not consume nonce',
    );
    eq(await command('preview', 99, '124', hash), null, 'another private chat cannot replace preview binding');
    eq(await command('confirm', 100, '124', hash), null, 'another private chat cannot consume preview');
    await db.exec("UPDATE private_shore.nonces SET preview_at=now()-interval '6 minutes' WHERE kind='confirm'");
    eq(await command('confirm', 100, '123', hash), null, 'expired preview cannot consent');
    await db.exec("UPDATE private_shore.nonces SET preview_at=now() WHERE kind='confirm'");
    const confirmed = await command('confirm', 100, '123', hash);
    eq(typeof confirmed.text, 'string', 'explicit callback consumes same private recipient invitation');
    eq(await command('confirm', 100, '123', hash), null, 'replayed webhook ignored');
    row = await contact();
    await save(row.id, row.revision, configuration({ channel: 'telegram', address: null, enabled: true }));
    row = await contact();
    await db.exec('UPDATE private_shore.telegram_updates SET replied_at=NULL');
    const where = await command('where', 101);
    eq(where.text.includes('Position unavailable'), true, '/where needs explicit percontact position consent');
    eq(await command('where', 102, '123', null, Date.now() - 600_000), null, 'old update cannot be restamped');
    eq(await command('where', 103, '123', null, Date.now() + 60_000), null, 'future original update refused');
    eq(
        await service('SELECT public.shore_anchor_enqueue(NULL)'),
        { after: event, queued: 0 },
        'phone event without durable boat binding ignored',
    );
    const binding = await user('SELECT public.bind_shore_anchor($1,$2,NULL)', [boat, session]);
    eq(typeof binding, 'string', 'explicit current phone session binding');
    await denied(
        () => user('SELECT public.bind_shore_anchor($1,$2,NULL)', [boat, session]),
        '40001',
        'binding CAS required',
    );
    eq((await service('SELECT public.shore_anchor_enqueue(NULL)')).queued, 1, 'current exact own event fans out');
    eq(await scalar('SELECT count(*)::int FROM private_shore.deliveries'), 1, 'one incident row only');
    await service('SELECT public.shore_anchor_enqueue(NULL)');
    eq(await scalar('SELECT count(*)::int FROM private_shore.deliveries'), 1, 'incident idempotent');
    const d = await service('SELECT public.shore_delivery_claim()');
    eq(d.kind, 'drag', 'only fixed current event facts');
    eq(await service('SELECT public.shore_delivery_guard($1,$2)', [d.id, d.revision]), true, 'current provider guard');
    eq(
        await service('SELECT public.shore_delivery_guard($1,$2)', [d.id, d.revision]),
        false,
        'same HTTP attempt cannot pass its gate twice',
    );
    eq(
        await scalar('SELECT finished FROM private_shore.deliveries WHERE id=$1', [d.id]),
        true,
        'Telegram reserves its sole attempt before uncertain HTTP',
    );
    await service('SELECT public.shore_delivery_finish($1,$2,false)', [d.id, d.revision]);
    eq(
        await scalar('SELECT finished FROM private_shore.deliveries WHERE id=$1', [d.id]),
        true,
        'unknown Telegram outcome cannot re-open an automatic retry',
    );
    eq((await command('stop', 104)).text.includes('stopped'), true, 'recipient Stop revokes pending work');
    eq(
        await service('SELECT public.shore_delivery_guard($1,$2)', [d.id, d.revision]),
        false,
        'stop blocks subsequent provider attempt',
    );
    eq((await contact()).configuration.enabled, false, 'Stop turns delivery off');
    // Exact position contract is optional and private. Install only a fixed fixture
    // function; production never substitutes account Guardian or last active hull.
    await db.exec(
        `CREATE SCHEMA private_weather_watch;CREATE TABLE private_weather_watch.test_position(boat uuid,revision uuid,at_ms bigint);INSERT INTO private_weather_watch.test_position VALUES('${boat}','40000000-0000-4000-8000-000000000001',floor(extract(epoch FROM now())*1000));CREATE FUNCTION private_weather_watch.weather_position_current(p_boat_id uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('revision',revision,'lat',0,'lon',0,'at',at_ms,'zone','UTC') FROM private_weather_watch.test_position WHERE boat=p_boat_id AND at_ms>extract(epoch FROM now()-interval '15 minutes')*1000$$;`,
    );
    row = await contact();
    await save(row.id, row.revision, configuration({ channel: 'telegram', address: null, sharePosition: true }));
    row = await contact();
    await db.exec('UPDATE private_shore.contacts SET invited_at=NULL');
    await invite(row, 'd'.repeat(64), 'e'.repeat(64));
    await db.exec('UPDATE private_shore.telegram_updates SET replied_at=NULL');
    eq(
        await command('preview', 105, '123', 'd'.repeat(64)),
        { invitation: { sharePosition: true } },
        'position permission is previewed explicitly',
    );
    await command('confirm', 106, '123', 'd'.repeat(64));
    row = await contact();
    await save(
        row.id,
        row.revision,
        configuration({ channel: 'telegram', address: null, sharePosition: true, enabled: true }),
    );
    await db.exec('UPDATE private_shore.telegram_updates SET replied_at=NULL');
    eq((await command('where', 107)).position.lat, 0, 'fresh exact registered position at 0,0 is valid');
    await db.exec(
        'UPDATE private_shore.telegram_updates SET replied_at=NULL;UPDATE private_weather_watch.test_position SET revision=gen_random_uuid()',
    );
    eq(
        (await command('where', 108)).text.includes('no fresh receipt'),
        true,
        'changed source cannot inherit position consent',
    );
    await db.exec(
        "UPDATE private_shore.telegram_updates SET replied_at=NULL;UPDATE public.boats SET owner_id='" +
            other +
            "' WHERE id='" +
            boat +
            "'",
    );
    eq(
        (await command('where', 109)).text.includes('no single'),
        true,
        'transferred hull cannot disclose to old contact',
    );
    await denied(() => list(), '42501', 'transferred hull hidden from old owner');
    // Restore ownership to exercise bounded slots/cleanup without any provider work.
    await db.exec(`UPDATE public.boats SET owner_id='${owner}' WHERE id='${boat}';DELETE FROM private_shore.contacts;`);
    for (let i = 0; i < 10; i++)
        await save(null, null, configuration({ label: 'Contact ' + i, address: `c${i}@example.invalid` }));
    await denied(() => save(null, null, configuration()), '54000', 'hard ten-account contact cap');
    await db.exec('DELETE FROM private_shore.quotas;DELETE FROM private_shore.global_quotas');
    const readyRows = (await list()).contacts;
    for (let i = 0; i < 10; i++)
        await invite(readyRows[i], i.toString(16).padStart(64, '0'), (i + 100).toString(16).padStart(64, '0'));
    eq(
        await scalar('SELECT invites FROM private_shore.quotas WHERE owner_id=$1', [owner]),
        10,
        'ten invitations consume exact independent UTC account quota',
    );
    await db.exec('UPDATE private_shore.contacts SET invited_at=NULL');
    await denied(
        () => invite(readyRows[0], 'f'.repeat(64), 'e'.repeat(64)),
        '54000',
        'eleventh invitation refused even after cooldown',
    );
    await db.exec('UPDATE private_shore.quotas SET invites=0;UPDATE private_shore.global_quotas SET invites=500');
    await denied(
        () => invite(readyRows[0], 'f'.repeat(64), 'e'.repeat(64)),
        '54000',
        'separate global invitation budget',
    );
    for (let i = 0; i < 10; i++) {
        eq(await consent(i.toString(16).padStart(64, '0')), true, 'exact recipient consent ' + i);
        await save(readyRows[i].id, readyRows[i].revision, { ...readyRows[i].configuration, enabled: true });
    }
    eq(
        Number.isSafeInteger((await list()).contacts[0].consentedAt),
        true,
        'client consent clocks are integral UTC milliseconds',
    );
    await db.exec('DELETE FROM private_shore.deliveries;UPDATE private_shore.quotas SET deliveries=30');
    eq((await service('SELECT public.shore_anchor_enqueue(NULL)')).queued, 10, 'bounded confirmed hull fanout');
    eq(
        await service('SELECT public.shore_delivery_claim()'),
        null,
        'account delivery budget cannot be borrowed from invitation budget',
    );
    await db.exec(
        'UPDATE private_shore.quotas SET deliveries=0;UPDATE private_shore.global_quotas SET deliveries=5000',
    );
    eq(await service('SELECT public.shore_delivery_claim()'), null, 'global provider-attempt budget');
    await db.exec('UPDATE private_shore.global_quotas SET deliveries=0');
    const emailDelivery = await service('SELECT public.shore_delivery_claim()');
    await db.query('UPDATE private_shore.deliveries SET finished=true WHERE id<>$1', [emailDelivery.id]);
    for (let attempt = 1; attempt <= 3; attempt++) {
        eq(
            await service('SELECT public.shore_delivery_guard($1,$2)', [emailDelivery.id, emailDelivery.revision]),
            true,
            'email idempotency attempt ' + attempt,
        );
        await service('SELECT public.shore_delivery_finish($1,$2,false)', [emailDelivery.id, emailDelivery.revision]);
        if (attempt < 3) {
            await db.query("UPDATE private_shore.deliveries SET claimed_at=now()-interval '3 minutes' WHERE id=$1", [
                emailDelivery.id,
            ]);
            eq(
                (await service('SELECT public.shore_delivery_claim()')).id,
                emailDelivery.id,
                'bounded same-delivery retry',
            );
        }
    }
    eq(await service('SELECT public.shore_delivery_claim()'), null, 'no fourth attempt');
    await db.exec("UPDATE public.anchor_watch_sessions SET vessel_state='ended'");
    eq(await scalar('SELECT private_shore.anchor_event($1)', [event]), null, 'ended watch cannot remain green');
    await db.exec(
        "UPDATE public.anchor_watch_sessions SET vessel_state='watching';DELETE FROM public.anchor_watch_members",
    );
    eq(await scalar('SELECT private_shore.anchor_event($1)', [event]), null, 'retired vessel role cannot fan out');
    await db.exec(
        `INSERT INTO public.anchor_watch_members VALUES('${session}','${owner}','vessel');INSERT INTO public.pi_diary_relays VALUES('fixture-relay-001','${owner}','${boat}',true);INSERT INTO public.pi_anchor_sessions VALUES('fixture-relay-001','${owner}','${session}',now()+interval '1 hour',now(),now(),true,true);UPDATE public.anchor_alarm_events SET pi_relay_id='fixture-relay-001';`,
    );
    eq(
        (await scalar('SELECT private_shore.anchor_event($1)', [event])).boatId,
        boat,
        'Pi source uses its authoritative hull binding',
    );
    await db.exec("UPDATE public.pi_anchor_sessions SET last_heartbeat_at=now()-interval '36 seconds'");
    eq(await scalar('SELECT private_shore.anchor_event($1)', [event]), null, 'stale Pi drag state cannot be restamped');
    await db.exec(
        "UPDATE public.anchor_alarm_events SET alarm_kind='contact_lost';UPDATE public.pi_anchor_sessions SET last_heartbeat_at=now()-interval '2 minutes'",
    );
    eq(
        (await scalar('SELECT private_shore.anchor_event($1)', [event])).kind,
        'contact_lost',
        'quiet Pi reports missing contact, no claimed position',
    );
    await db.exec('UPDATE public.pi_anchor_sessions SET last_heartbeat_at=now()');
    eq(
        await scalar('SELECT private_shore.anchor_event($1)', [event]),
        null,
        'recovered contact suppresses old missing incident',
    );
    await db.exec("UPDATE private_shore.control SET worker_at=now()-interval '16 minutes'");
    eq((await list()).emailReady, false, 'old successful cron tick cannot prove current readiness');
    eq(
        await scalar("SELECT has_function_privilege('anon','public.shore_delivery_claim()','EXECUTE')"),
        false,
        'no anonymous queue surface',
    );
    eq(
        await scalar("SELECT has_table_privilege('authenticated','private_shore.nonces','SELECT')"),
        false,
        'owner never reads bearer hashes',
    );
    eq(
        await scalar(
            "SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private_shore' AND prosecdef AND NOT coalesce(proconfig,'{}') @> ARRAY['search_path=\"\"']",
        ),
        0,
        'all definer paths empty',
    );
    let races = null;
    if (actualPostgres) {
        // New connections point only at the exact already-verified empty CI
        // fixture. No fallback to product URLs, default PG credentials or ports.
        const module = await import(pathToFileURL(process.env.PG_MODULE_PATH).href),
            Client = module.Client ?? module.default.Client;
        const cohorts = [];
        async function race(name, width, role, uid, holdSql, holdArgs, action) {
            assert(['authenticated', 'service_role'].includes(role));
            const clients = Array.from(
                { length: width },
                () =>
                    new Client({
                        connectionString: process.env.SHORE_CONTACTS_TEST_DATABASE_URL,
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
        const ownerLock = "SELECT pg_advisory_xact_lock(hashtextextended('shore:'||$1::text,0))";
        const run = async (c, sql, args) => Object.values((await c.query(sql, args)).rows[0] ?? {})[0];
        await db.exec(
            `DELETE FROM private_shore.contacts;DELETE FROM private_shore.quotas;DELETE FROM private_shore.global_quotas;UPDATE private_shore.control SET worker_at=now();UPDATE public.anchor_alarm_events SET pi_relay_id=NULL,alarm_kind='drag',created_at=now();`,
        );
        const slots = await race('owner-slots', 16, 'authenticated', owner, ownerLock, [owner], (c, i) =>
            run(c, 'SELECT public.configure_shore_contact($1,NULL,NULL,$2::jsonb)', [
                boat,
                JSON.stringify(configuration({ label: 'Racing contact ' + i, address: `race${i}@example.invalid` })),
            ]),
        );
        eq(
            slots.filter((r) => r.status === 'fulfilled').length,
            10,
            '16 concurrent configurations admit exact ten slots',
        );
        eq(
            slots.filter((r) => r.status === 'rejected' && r.reason.code === '54000').length,
            6,
            'all remaining slot contenders receive explicit quota refusal',
        );
        const first = (await list()).contacts[0];
        const edits = await race('configuration-CAS', 2, 'authenticated', owner, ownerLock, [owner], (c, i) =>
            run(c, 'SELECT public.configure_shore_contact($1,$2,$3,$4::jsonb)', [
                boat,
                first.id,
                first.revision,
                JSON.stringify({ ...first.configuration, label: 'CAS contender ' + i }),
            ]),
        );
        eq(edits.filter((r) => r.status === 'fulfilled').length, 1, 'two stale-revision edits have one CAS winner');
        eq(
            edits.filter((r) => r.status === 'rejected' && r.reason.code === '40001').length,
            1,
            'CAS loser cannot silently overwrite',
        );
        const selected = (await list()).contacts.find((c) => c.id === first.id);
        await invite(selected);
        const confirmations = await race(
            'one-use-consent',
            16,
            'service_role',
            null,
            'SELECT id FROM private_shore.contacts WHERE id=$1 FOR UPDATE',
            [selected.id],
            (c) => run(c, 'SELECT public.shore_consent($1,$2)', [hash, 'confirm']),
        );
        eq(
            confirmations.filter((r) => r.status === 'fulfilled' && r.value === true).length,
            1,
            '16 one-use consent races have exactly one winner',
        );
        await save(selected.id, selected.revision, { ...selected.configuration, enabled: true });
        await service('SELECT public.shore_anchor_enqueue(NULL)');
        const claimed = await service('SELECT public.shore_delivery_claim()');
        const guards = await race(
            'provider-attempt',
            16,
            'service_role',
            null,
            'SELECT id FROM private_shore.deliveries WHERE id=$1 FOR UPDATE',
            [claimed.id],
            (c) => run(c, 'SELECT public.shore_delivery_guard($1,$2)', [claimed.id, claimed.revision]),
        );
        eq(
            guards.filter((r) => r.status === 'fulfilled' && r.value === true).length,
            1,
            '16 delivery gates reserve one HTTP attempt',
        );
        races = {
            cohorts,
            slotContenders: 16,
            admitted: 10,
            casContenders: 2,
            casWinners: 1,
            consentContenders: 16,
            consentWinners: 1,
            deliveryContenders: 16,
            deliveryWinners: 1,
        };
    }
    console.log(
        JSON.stringify({
            engine: actualPostgres ? 'PostgreSQL ' + postgresVersion : 'PGlite disposable',
            checks,
            races,
            productDatabase: false,
            providerCalls: 0,
        }),
    );
} catch (e) {
    console.error(
        JSON.stringify({
            error: e.message,
            code: e.code,
            where: e.where,
            site: e.stack
                ?.split('\n')
                .filter((s) => s.includes('shore-contacts-db.mjs'))
                .slice(0, 2),
        }),
    );
    process.exitCode = 1;
} finally {
    await db.close();
}
