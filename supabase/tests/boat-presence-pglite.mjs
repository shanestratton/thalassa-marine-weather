import { pathToFileURL } from 'node:url';
import { runPresenceCases } from './boat-presence-cases.mjs';
if (!process.env.PGLITE_MODULE_PATH) throw new Error('Existing local PGlite runtime required');
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
const { pgcrypto } = await import(new URL('./contrib/pgcrypto.js', pathToFileURL(process.env.PGLITE_MODULE_PATH)));
const db = new PGlite({ extensions: { pgcrypto } });
try {
    console.info(
        JSON.stringify({ engine: 'PGlite', checks: await runPresenceCases(db), result: 'PASS', liveChanges: false }),
    );
} finally {
    await db.close();
}
