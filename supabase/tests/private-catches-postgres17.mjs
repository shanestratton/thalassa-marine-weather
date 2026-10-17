/** Actual isolated Linux PostgreSQL 17.6; no application DB/HTTP/storage path.
 * All destructive fixture DDL is behind opt-in, exact loopback credentials,
 * database/role/version/empty-schema checks. The service container is disposable. */
import { pathToFileURL } from 'node:url';
import { privateCatchFixtureConfig, assertPrivateCatchFixtureFacts } from './private-catches-disposable.mjs';
import { runPrivateCatchCases } from './private-catches-cases.mjs';

const config = privateCatchFixtureConfig(process.env, process.platform);
const module = await import(pathToFileURL(config.modulePath).href),
    Client = module.Client ?? module.default.Client;
const client = new Client(config.connection);
await client.connect();
try {
    const facts = (
        await client.query(`SELECT current_database() AS database,current_user AS "user",
        current_setting('server_version_num') AS server_version_num,version(),
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p','v','m','S','f')) AS tables,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_') AS functions,
        (SELECT count(*) FROM pg_namespace WHERE nspname='auth') AS auth_schema,
        (SELECT count(*) FROM pg_roles WHERE rolname <> 'postgres' AND rolname !~ '^pg_') AS auth_roles,
        (SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1','catch140_test')) AS databases,
        (SELECT count(*) FROM pg_publication) AS publications`)
    ).rows[0];
    assertPrivateCatchFixtureFacts(facts);
    const checks = await runPrivateCatchCases({ exec: (sql) => client.query(sql), query: (sql) => client.query(sql) });
    console.info(
        JSON.stringify({
            engine: 'actual isolated Linux PostgreSQL',
            postgres: facts.version,
            database: facts.database,
            checks,
            result: 'PASS',
            disposable: true,
            liveProductChanges: false,
        }),
    );
} finally {
    await client.end();
}
