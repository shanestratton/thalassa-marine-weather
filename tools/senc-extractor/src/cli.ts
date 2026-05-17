#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, resolve, extname } from 'node:path';
import { parseSenc } from './featureParser.js';
import { emitCell } from './geojsonEmitter.js';

interface Args {
    input: string;
    output: string;
    classes?: 'all';
    pretty: boolean;
}

function parseArgs(argv: string[]): Args | null {
    let input = '';
    let output = '';
    let classes: 'all' | undefined;
    let pretty = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--all') classes = 'all';
        else if (a === '--pretty') pretty = true;
        else if (a.startsWith('--out=')) output = a.slice('--out='.length);
        else if (a === '-o' && i + 1 < argv.length) output = argv[++i];
        else if (!a.startsWith('--') && !input) input = a;
    }
    if (!input) return null;
    return { input, output, classes, pretty };
}

function deriveCellId(inputPath: string): string {
    const base = basename(inputPath, extname(inputPath));
    // Strip OpenCPN's "<hash>_" prefix on cache files (e.g. "D3EDB6C5662E_US5GA22M" → "US5GA22M").
    const m = base.match(/^[0-9A-Fa-f]{8,16}_(.+)$/);
    return m ? m[1] : base;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args) {
        console.error('usage: senc-extract <senc-file> [-o <out-path>] [--all] [--pretty]');
        console.error('');
        console.error('  Default: writes cells/<cellId>.json with routing-relevant classes only.');
        console.error('  --all: include every S-57 class found, not just the router-consumed subset.');
        console.error('  --pretty: indent the JSON output.');
        process.exit(1);
    }

    const cellId = deriveCellId(args.input);
    const outPath = args.output || resolve('cells', `${cellId}.json`);

    const buf = await readFile(args.input);
    const t0 = Date.now();
    const { header, features, stats } = parseSenc(buf);
    const tParse = Date.now() - t0;

    const cell = emitCell(header, features, {
        cellId,
        classes: args.classes,
        sourceHO: process.env.SENC_SOURCE_HO ?? '??',
    });

    await mkdir(dirname(outPath), { recursive: true });
    const json = args.pretty ? JSON.stringify(cell, null, 2) : JSON.stringify(cell);
    await writeFile(outPath, json);

    console.log(`extracted ${cellId} from ${args.input}`);
    console.log(`  ${features.length} features, ${stats.totalRecords} records parsed in ${tParse}ms`);
    console.log(`  ${cell.stats?.emittedFeatures} features emitted across ${Object.keys(cell.layers).length} layer(s)`);
    for (const [acronym, fc] of Object.entries(cell.layers).sort()) {
        console.log(`    ${acronym.padEnd(8)} ${String(fc.features.length).padStart(6)} features`);
    }
    if (stats.unknownRecordCounts.size > 0) {
        const dropped = [...stats.unknownRecordCounts.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([type, n]) => `${type}:${n}`)
            .join(' ');
        console.log(`  dropped record-types (type:count): ${dropped}`);
    }
    console.log(`  wrote ${outPath} (${json.length.toLocaleString()} bytes)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
