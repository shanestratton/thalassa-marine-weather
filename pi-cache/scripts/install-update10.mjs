// Update 10 preserves the reviewed update-7 installer/rollback and anchor-lease guards.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyBundle, verifyBundle } from './update10.mjs';
const bundle = path.dirname(fileURLToPath(import.meta.url));
const manifest = verifyBundle(bundle);
if (!process.argv.includes('--apply')) {
    process.stdout.write(
        JSON.stringify(
            {
                mode: 'PLAN ONLY: no Pi mutation',
                manifest,
                steps: [
                    'Verify frozen-source inventory and every SHA256SUMS entry',
                    'Build/test locked source as the non-root service user while prior code runs',
                    'Require fresh loopback guard status and no active/persisted anchor lease',
                    'Hold maintenance sentinel; recheck status before stopping services',
                    'Back up code only; preserve .env, cache, identity, enc-charts and reference',
                    'Replace code; start vault/cache; require healthy guarded status',
                    'On failure restore complete prior code; retain guard if recovery is uncertain',
                ],
            },
            null,
            2,
        ) + '\n',
    );
} else {
    const index = process.argv.indexOf('--cache-dir');
    const portIndex = process.argv.indexOf('--port');
    const result = await applyBundle(bundle, {
        ...(index >= 0 ? { cacheDir: process.argv[index + 1] } : {}),
        ...(portIndex >= 0 ? { port: Number(process.argv[portIndex + 1]) } : {}),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
