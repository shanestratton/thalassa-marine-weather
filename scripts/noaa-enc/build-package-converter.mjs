/** Explicit experimental package artifact; never replaces the reviewed
 * monolith CLI/runtime policy or enters the phone's public directory. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
const [destination] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(destination ?? '');
if (!destination || !output.endsWith('.mjs') || output.startsWith(root + path.sep))
    throw Error('Pass a new outside-checkout package CLI path.');
if (
    await fs.stat(output).then(
        () => true,
        () => false,
    )
)
    throw Error('Refusing to replace a retained converter artifact.');
await fs.mkdir(path.dirname(output), { recursive: true });
await build({
    absWorkingDir: root,
    entryPoints: ['scripts/noaa-enc/convert-package-cli.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    legalComments: 'none',
});
console.log(JSON.stringify({ output, acquisition: false, publication: false, oldRuntimePolicyChanged: false }));
