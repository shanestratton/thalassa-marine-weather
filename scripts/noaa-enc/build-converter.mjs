/** Build into an explicit outside-checkout staging location; this converter
 * is a server artifact and must never enter the phone's public directory. */
import path from 'node:path';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
const [destination] = process.argv.slice(2);
if (!destination) throw Error('Pass an explicit converter output .mjs path');
const root = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(destination);
if (!output.endsWith('.mjs') || output.startsWith(root + path.sep))
    throw Error('Converter output must be outside the app checkout');
await fs.mkdir(path.dirname(output), { recursive: true });
await build({
    absWorkingDir: root,
    entryPoints: ['scripts/noaa-enc/convert-cli.ts'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    legalComments: 'none',
});
console.log(
    JSON.stringify({
        output,
        network: false,
        hostDependencies: ['Node >=20', 'GDAL ogrinfo/ogr2ogr'],
        source: 'Shared pi-cache/src/s57Converter.ts',
        maxConvertedBytes: 16 * 1024 * 1024,
    }),
);
