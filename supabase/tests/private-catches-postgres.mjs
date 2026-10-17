/** Actual disposable WASM PostgreSQL proof; no network, live Supabase or auth tokens.
 * PGLITE_MODULE_PATH names an already installed @electric-sql/pglite entry. */
import { pathToFileURL } from 'node:url';
import { runPrivateCatchCases } from './private-catches-cases.mjs';
if (!process.env.PGLITE_MODULE_PATH) throw new Error('Set PGLITE_MODULE_PATH to an existing local PGlite module.');
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
const db = new PGlite();
try {
    const checks = await runPrivateCatchCases(db);
    console.info(
        JSON.stringify({ engine: 'PGlite disposable PostgreSQL', checks, result: 'PASS', liveChanges: false }),
    );
} finally {
    await db.close();
}
