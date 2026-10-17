import { pathToFileURL } from 'node:url';
import { runComfortCases } from './private-comfort-cases.mjs';
if (!process.env.PGLITE_MODULE_PATH) throw new Error('Existing isolated PGlite runtime required');
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href),
    db = new PGlite();
try {
    console.info(
        JSON.stringify({ engine: 'PGlite', checks: await runComfortCases(db), result: 'PASS', liveChanges: false }),
    );
} finally {
    await db.close();
}
